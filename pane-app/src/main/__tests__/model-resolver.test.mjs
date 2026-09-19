import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractActiveSelection,
  resolveModelForProvider,
  comboSlotForTier,
  deriveComboFromSelection,
  pickKeyedProvider,
  resolveVoiceDistillModel,
  resolveHandoffTarget,
  normalizeProvider,
  LLM_PROVIDERS,
} from "../model-resolver.mjs";

// ---------------------------------------------------------------------------
// Active selection extraction — the runtime source of truth
// ---------------------------------------------------------------------------

describe("extractActiveSelection", () => {
  it("returns the user's selection when both provider and model exist", () => {
    const sel = extractActiveSelection({
      selected_model: "deepseek-v4-pro",
      selected_model_provider: "deepseek",
    });
    expect(sel).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      source: "selection",
    });
  });

  it("normalizes -api suffixed providers", () => {
    const sel = extractActiveSelection({
      selected_model: "claude-sonnet-4-6",
      selected_model_provider: "anthropic-api",
    });
    expect(sel?.provider).toBe("anthropic");
  });

  it("returns null when no model is selected — never an invented model", () => {
    expect(extractActiveSelection({})).toBeNull();
    expect(extractActiveSelection(null)).toBeNull();
    expect(
      extractActiveSelection({ selected_model_provider: "deepseek" }),
    ).toBeNull();
    expect(
      extractActiveSelection({ selected_model: "deepseek-chat" }),
    ).toBeNull();
  });

  it("is project-agnostic — reads only the shared selection keys", () => {
    // The selection lives in global settings; per-project overrides ride on
    // top in the renderer. The resolver must not smuggle project state in.
    const sel = extractActiveSelection({
      project_states: { "/other/project": { selected_model: "x" } },
      selected_model: "glm-5.2",
      selected_model_provider: "z-ai",
    });
    expect(sel?.model).toBe("glm-5.2");
  });
});

// ---------------------------------------------------------------------------
// Provider-scoped model resolution
// ---------------------------------------------------------------------------

describe("resolveModelForProvider", () => {
  it("returns the selected model when the provider matches", () => {
    expect(
      resolveModelForProvider(
        { provider: "deepseek", model: "deepseek-v4-pro" },
        "deepseek",
      ),
    ).toBe("deepseek-v4-pro");
  });

  it("returns null when the selection belongs to a different provider", () => {
    expect(
      resolveModelForProvider(
        { provider: "openrouter", model: "a/b" },
        "deepseek",
      ),
    ).toBeNull();
  });

  it("does not leak a model across providers", () => {
    // Tenant/config boundary: a deepseek model must never run on anthropic.
    expect(
      resolveModelForProvider(
        { provider: "deepseek", model: "deepseek-v4-pro" },
        "anthropic",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tier → combo slot mapping (shared by spawn routing and previewRoute)
// ---------------------------------------------------------------------------

describe("comboSlotForTier", () => {
  it("maps frontier and capable to the thinking slot", () => {
    expect(comboSlotForTier("frontier")).toBe("thinking");
    expect(comboSlotForTier("capable")).toBe("thinking");
  });

  it("maps cheap and mid to the execution slot", () => {
    expect(comboSlotForTier("cheap")).toBe("execution");
    expect(comboSlotForTier("mid")).toBe("execution");
  });
});

// ---------------------------------------------------------------------------
// Combo derivation from selection (replaces hardcoded DEFAULT_POWER_COMBO)
// ---------------------------------------------------------------------------

describe("deriveComboFromSelection", () => {
  it("derives a two-slot combo from the selection — both slots = selected model", () => {
    const combo = deriveComboFromSelection({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    expect(combo).toEqual({
      thinking: { provider: "deepseek", model: "deepseek-v4-pro", thinking: false },
      execution: { provider: "deepseek", model: "deepseek-v4-pro", thinking: false },
    });
  });

  it("returns null when there is no selection — never a hardcoded combo", () => {
    expect(deriveComboFromSelection(null)).toBeNull();
    expect(deriveComboFromSelection({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyed-provider picking (respects disabled_providers, excludes tool keys)
// ---------------------------------------------------------------------------

describe("pickKeyedProvider", () => {
  const keys = {
    openrouter: "sk-or-1",
    deepseek: "sk-ds-1",
    tavily: "tvly-1", // tool key — must never be chosen
    jina: "jina-1",   // tool key — must never be chosen
  };

  it("prefers the requested candidates in order", () => {
    expect(pickKeyedProvider(keys, [], ["deepseek"])).toBe("deepseek");
  });

  it("never selects a tool-only provider (tavily/jina)", () => {
    const onlyTools = { tavily: "tvly-1", jina: "jina-1" };
    expect(pickKeyedProvider(onlyTools, [])).toBeNull();
  });

  it("never selects a disabled provider, even with a key and preference", () => {
    // Disabled + preferred → excluded entirely
    expect(
      pickKeyedProvider(keys, ["deepseek"], ["deepseek"]),
    ).toBeNull();
    // Preferred disabled → falls to the next preferred provider with a key
    expect(
      pickKeyedProvider(keys, ["deepseek"], ["deepseek", "openrouter"]),
    ).toBe("openrouter");
    // Preferred enabled, another provider disabled → preference wins
    expect(
      pickKeyedProvider(keys, ["openrouter"], ["deepseek"]),
    ).toBe("deepseek");
  });

  it("never redirects to a provider the caller has no model for", () => {
    // No "any keyed provider" fallback: openrouter has a key here but was
    // not offered as a candidate → null, so the missing-key error surfaces
    // on the original provider instead of a misleading no-model one.
    expect(pickKeyedProvider(keys, [], ["kimi"])).toBeNull();
  });

  it("returns null when nothing qualifies", () => {
    expect(pickKeyedProvider({}, [])).toBeNull();
    expect(pickKeyedProvider(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Voice distill model (replaces hardcoded gpt-5-mini)
// ---------------------------------------------------------------------------

describe("resolveVoiceDistillModel", () => {
  it("uses the explicit voice_distill_model override when set", () => {
    expect(
      resolveVoiceDistillModel({
        voice_distill_model: "gpt-5.4-mini",
        selected_model: "deepseek-v4-pro",
        selected_model_provider: "deepseek",
      }),
    ).toEqual({ model: "gpt-5.4-mini", transport: "api", error: null });
  });

  it("routes an explicit override over the Codex bridge when OAuth-only", () => {
    expect(
      resolveVoiceDistillModel(
        {
          voice_distill_model: "gpt-5.4-mini",
          selected_model: "glm-5.3",
          selected_model_provider: "z-ai",
        },
        true,
      ),
    ).toEqual({ model: "gpt-5.4-mini", transport: "codex", error: null });
  });

  it("uses the active selection when it is an OpenAI model", () => {
    expect(
      resolveVoiceDistillModel({
        selected_model: "gpt-5.4",
        selected_model_provider: "openai",
      }),
    ).toEqual({ model: "gpt-5.4", transport: "api", error: null });
  });

  it("carries an OpenAI selection over the Codex bridge when OAuth-only", () => {
    expect(
      resolveVoiceDistillModel(
        { selected_model: "gpt-5.4", selected_model_provider: "openai" },
        true,
      ),
    ).toEqual({ model: "gpt-5.4", transport: "codex", error: null });
  });

  it("falls back to the Codex default distill model when OAuth-only and no OpenAI selection", () => {
    const result = resolveVoiceDistillModel(
      { selected_model: "glm-5.3", selected_model_provider: "z-ai" },
      true,
    );
    expect(result.model).toBe("gpt-5.5");
    expect(result.transport).toBe("codex");
    expect(result.error).toBeNull();
  });

  it("returns a surfaced error when the selection is a non-OpenAI model and no OAuth", () => {
    const result = resolveVoiceDistillModel({
      selected_model: "deepseek-v4-pro",
      selected_model_provider: "deepseek",
    });
    expect(result.model).toBeNull();
    expect(result.error).toMatch(/OpenAI model or a ChatGPT sign-in/i);
  });

  it("returns a surfaced error when nothing is configured", () => {
    const result = resolveVoiceDistillModel({});
    expect(result.model).toBeNull();
    expect(result.error).toMatch(/voice_distill_model/i);
  });
});

// ---------------------------------------------------------------------------
// Handoff enrichment target (replaces getDefaultModelForProvider)
// ---------------------------------------------------------------------------

describe("resolveHandoffTarget", () => {
  it("prefers the legacy explicit http_model override", () => {
    expect(
      resolveHandoffTarget({
        http_model: "deepseek-v4-flash",
        http_provider: "deepseek",
        selected_model: "glm-5.2",
        selected_model_provider: "z-ai",
      }),
    ).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      source: "legacy-http-model",
    });
  });

  it("uses the user's active selection when no legacy override exists", () => {
    expect(
      resolveHandoffTarget({
        selected_model: "glm-5.2",
        selected_model_provider: "z-ai",
      }),
    ).toEqual({
      provider: "z-ai",
      model: "glm-5.2",
      source: "selection",
    });
  });

  it("returns null when nothing is configured — skips, doesn't invent", () => {
    expect(resolveHandoffTarget({})).toBeNull();
    expect(resolveHandoffTarget(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeProvider
// ---------------------------------------------------------------------------

describe("normalizeProvider", () => {
  it("strips -api suffixes", () => {
    expect(normalizeProvider("anthropic-api")).toBe("anthropic");
    expect(normalizeProvider("gemini-api")).toBe("gemini");
    expect(normalizeProvider("anthropic")).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Background/foreground consistency — resolveActiveModel reads disk
// ---------------------------------------------------------------------------

describe("resolveActiveModel (disk IO)", () => {
  const realHomedir = os.homedir;
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pane-resolver-"));
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = realHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reads the same settings the foreground sends with each turn", async () => {
    const { resolveActiveModel } = await import("../model-resolver.mjs");
    fs.mkdirSync(path.join(tmpHome, ".pane"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".pane", "settings.json"),
      JSON.stringify({
        selected_model: "deepseek-v4-pro",
        selected_model_provider: "deepseek",
      }),
    );
    const sel = await resolveActiveModel();
    expect(sel).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      source: "selection",
    });
  });

  it("returns null (no error) when settings are unreadable", async () => {
    const { resolveActiveModel } = await import("../model-resolver.mjs");
    const sel = await resolveActiveModel();
    expect(sel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HttpBackend.resolveRequestModel — background calls land on the foreground
// model (imported via dynamic import so electron imports don't run)
// ---------------------------------------------------------------------------

describe("HttpBackend.resolveRequestModel (bg/fg consistency)", () => {
  const realHomedir = os.homedir;
  let tmpHome;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pane-resolver-"));
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = realHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("explicit request model wins over the active selection", async () => {
    const mod = await import("../http-backend.mjs");
    fs.mkdirSync(path.join(tmpHome, ".pane"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".pane", "settings.json"),
      JSON.stringify({
        selected_model: "deepseek-v4-pro",
        selected_model_provider: "deepseek",
      }),
    );
    const backend = new mod.ApiBackend(() => {});
    const model = await backend.resolveRequestModel(
      { provider: "deepseek", model: "deepseek-v4-flash" },
      "deepseek",
    );
    expect(model).toBe("deepseek-v4-flash");
  });

  it("background call with null provider/model lands on the selected model", async () => {
    const mod = await import("../http-backend.mjs");
    fs.mkdirSync(path.join(tmpHome, ".pane"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".pane", "settings.json"),
      JSON.stringify({
        selected_model: "deepseek-v4-pro",
        selected_model_provider: "deepseek",
      }),
    );
    const backend = new mod.ApiBackend(() => {});
    // getApiConfig(null) resolves provider from the selection
    const apiConfig = await backend.getApiConfig(null);
    expect(apiConfig.provider).toBe("deepseek");
    const model = await backend.resolveRequestModel(
      { provider: null, model: null },
      apiConfig.provider,
    );
    expect(model).toBe("deepseek-v4-pro");
  });

  it("returns null (→ surfaced error) when no model is configured at all", async () => {
    const mod = await import("../http-backend.mjs");
    const backend = new mod.ApiBackend(() => {});
    const model = await backend.resolveRequestModel(
      { provider: null, model: null },
      "deepseek",
    );
    expect(model).toBeNull();
  });

  it("mapModelName throws a clear error on missing model — no silent default", async () => {
    const mod = await import("../http-backend.mjs");
    const backend = new mod.ApiBackend(() => {});
    expect(() => backend.mapModelName("deepseek", null)).toThrow(
      /No model configured for provider "deepseek"/,
    );
  });
});

// ---------------------------------------------------------------------------
// LLM_PROVIDERS boundary
// ---------------------------------------------------------------------------

describe("LLM_PROVIDERS", () => {
  it("contains every chat provider and excludes tool providers", () => {
    for (const p of [
      "openrouter", "deepseek", "z-ai", "stepfun", "kimi",
      "xiaomi", "openai", "anthropic", "gemini",
    ]) {
      expect(LLM_PROVIDERS.has(p)).toBe(true);
    }
    expect(LLM_PROVIDERS.has("tavily")).toBe(false);
    expect(LLM_PROVIDERS.has("jina")).toBe(false);
  });
});
