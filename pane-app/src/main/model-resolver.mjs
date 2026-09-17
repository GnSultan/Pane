/**
 * Model Resolver — the single source of truth for "which model should a
 * Pane-internal call use right now".
 *
 * Rule: the active model is the user's current selection — the same model
 * they pick for day-to-day turns (settings.selected_model +
 * selected_model_provider, written by the renderer's model picker and sent
 * with every foreground turn). Background operations (quickCall, agentCall,
 * handoff enrichment, arbiter reviews) resolve through this module so they
 * use the identical selection the foreground uses.
 *
 * This module NEVER invents a model. When nothing is configured it returns
 * null and callers surface a clear error. The only exceptions are explicit
 * overrides passed by configuration (per-request model, legacy http_model,
 * voice_distill_model) — never code-side defaults.
 *
 * Pure functions take settings/selection objects so they are testable
 * without touching disk; the thin IO wrapper reads ~/.pane/settings.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Settings path is resolved at read time (not module load) so the resolver
 * always reflects the current environment — and tests can redirect HOME.
 */
function settingsPath() {
  return path.join(os.homedir(), ".pane", "settings.json");
}

/**
 * Providers that can serve LLM chat calls. settings.http_api_keys also
 * holds tool/API keys (tavily, jina) that must never be selected as a
 * chat provider fallback.
 */
export const LLM_PROVIDERS = new Set([
  "openrouter", "deepseek", "z-ai", "stepfun", "kimi", "xiaomi",
  "openai", "anthropic", "gemini",
]);

/** Normalize "-api" suffixed provider names: "anthropic-api" → "anthropic". */
export function normalizeProvider(provider) {
  return typeof provider === "string" ? provider.replace(/-api$/, "") : provider;
}

/** Read ~/.pane/settings.json. Returns {} when unreadable. */
export async function readPaneSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Extract the user's active model selection from a settings object.
 * Returns { provider, model, source: "selection" } or null — never an
 * invented model. Both provider AND model must be present.
 */
export function extractActiveSelection(settings) {
  if (!settings || typeof settings !== "object") return null;
  const provider = normalizeProvider(settings.selected_model_provider) || null;
  const model = settings.selected_model || null;
  if (!provider || !model) return null;
  return { provider, model, source: "selection" };
}

/**
 * Resolve the active model from disk (async IO wrapper around
 * extractActiveSelection). The one entry point all background callers use.
 */
export async function resolveActiveModel() {
  return extractActiveSelection(await readPaneSettings());
}

/**
 * The model the active selection would use on `provider`, or null when the
 * selection belongs to a different provider. Used to keep background calls
 * on the SAME provider they're about to hit — no cross-provider borrowing.
 */
export function resolveModelForProvider(selection, provider) {
  if (!selection || !provider) return null;
  return normalizeProvider(selection.provider) === normalizeProvider(provider)
    ? selection.model
    : null;
}

/**
 * Map a heuristic-router tier to a power-combo slot. frontier/capable →
 * thinking slot; everything else → execution slot. Shared by spawn routing
 * and previewRoute so the prediction and the real route can't diverge.
 */
export function comboSlotForTier(tier) {
  return tier === "frontier" || tier === "capable" ? "thinking" : "execution";
}

/**
 * Derive a power combo from the active selection when the user hasn't
 * configured one explicitly: both slots point at the selected model.
 * Returns null when there is no selection — never a hardcoded combo.
 */
export function deriveComboFromSelection(selection) {
  if (!selection?.provider || !selection?.model) return null;
  const slot = {
    provider: selection.provider,
    model: selection.model,
    thinking: false,
  };
  return { thinking: { ...slot }, execution: slot };
}

/**
 * Pick a provider that actually has a key, respecting disabled_providers.
 * Candidates are ONLY the preferred providers (callers pass the providers
 * they hold a configured model for — combo slot, active selection). Tool
 * keys (tavily, jina…) and disabled providers are never chosen. Returns
 * null when nothing qualifies — callers then leave the original provider
 * in place so the missing-key error surfaces honestly.
 *
 * Note: no "any keyed provider" fallback. Redirecting to a provider we
 * have no model for would trade a clear "no API key" error for a
 * misleading "no model configured" one.
 */
export function pickKeyedProvider(
  keys,
  disabledProviders,
  preferredProviders = [],
  llmProviders = LLM_PROVIDERS,
) {
  const keyMap = keys || {};
  const disabled = new Set(disabledProviders || []);
  return (
    (preferredProviders || []).find(
      (p) => p && keyMap[p] && llmProviders.has(p) && !disabled.has(p),
    ) || null
  );
}

/**
 * Resolve the model for voice companion-memory distillation.
 *
 * Two transports exist (verified live, Sep 2026):
 *   - api.openai.com/v1/chat/completions under a platform API key;
 *   - the Codex Responses bridge (chatgpt.com/backend-api/codex) under
 *     ChatGPT OAuth tokens — the same bridge main chat uses since Aug 2026.
 *
 * Resolution order: explicit settings.voice_distill_model override wins;
 * otherwise the active selection when it is an OpenAI model; otherwise,
 * when Codex OAuth credentials exist, the Codex default distill model.
 * Never a silent fallback to an invented standard-API model — each path
 * returns the transport the caller must use.
 *
 * @returns {{ model: string|null, error: string|null, transport: "api"|"codex"|null }}
 */
export function resolveVoiceDistillModel(settings, codexOnly = false) {
  if (settings?.voice_distill_model) {
    // Explicit override: transport follows the credential that exists —
    // platform key → api, OAuth-only → the Codex bridge. A slug the chosen
    // transport rejects surfaces as a visible distill error, never silence.
    return { model: settings.voice_distill_model, transport: codexOnly ? "codex" : "api", error: null };
  }
  const selection = extractActiveSelection(settings);
  if (selection?.provider === "openai" && selection.model) {
    // OAuth access tokens are rejected by api.openai.com (verified Aug 2026,
    // TTS 401 class) — when the credential is OAuth-only, the Codex
    // transport must carry the call even for an OpenAI selection.
    return { model: selection.model, transport: codexOnly ? "codex" : "api", error: null };
  }
  if (codexOnly) {
    return { model: CODEX_DISTILL_MODEL, transport: "codex", error: null };
  }
  return {
    model: null,
    transport: null,
    error:
      "Voice memory distillation needs an OpenAI model or a ChatGPT sign-in. Select an OpenAI model as your active model, sign in with ChatGPT, or set an explicit override via voice_distill_model in settings.",
  };
}

// The Codex-side model distillation uses when riding OAuth credentials.
// Codex slugs rotate; gpt-5.5 verified live via codexFetch Sep 2026
// (gpt-5.4-mini now 400s: "model is not supported when using Codex with
// a ChatGPT account"). Re-verify against codexModels() if distill 400s.
export const CODEX_DISTILL_MODEL = "gpt-5.5";

/**
 * Resolve the provider/model target for handoff enrichment (pure — used by
 * handoff-enricher and covered by tests).
 *
 * Priority: legacy explicit settings.http_model/http_provider override, then
 * the active selection. Returns null when nothing is configured — the caller
 * skips enrichment with a clear log instead of inventing a model.
 */
export function resolveHandoffTarget(settings) {
  if (!settings || typeof settings !== "object") return null;
  if (settings.http_model) {
    return {
      provider: normalizeProvider(settings.http_provider) || null,
      model: settings.http_model,
      source: "legacy-http-model",
    };
  }
  const selection = extractActiveSelection(settings);
  return selection
    ? { provider: selection.provider, model: selection.model, source: "selection" }
    : null;
}
