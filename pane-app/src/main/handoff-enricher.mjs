/**
 * Handoff Enricher — augments the session handoff with LLM-generated context.
 *
 * Problem: The handoff captures WHAT happened (one-line action summaries
 * from state.recentActions) but not WHY. A model starting a new session
 * with only the handoff has to reverse-engineer intent, re-discover
 * patterns, and re-trace the reasoning chain, wasting turns on recon.
 *
 * Solution: After session end, run an LLM pass over the conversation
 * journal to generate richer handoff fields: reasoning chain, failed
 * approaches, patterns discovered, user preferences, architectural tensions.
 *
 * This runs as fire-and-forget. The basic handoff is already written.
 * Enrichment just makes the next session's handoff more useful.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readSettings() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PANE_DIR, "settings.json"), "utf-8"),
    );
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Core: enrich handoff with LLM
// ---------------------------------------------------------------------------

/**
 * Enrich the latest handoff using an LLM pass over the conversation journal.
 *
 * @param {string} projectId
 * @param {Function} updateLatestHandoffFn
 * @returns {Promise<boolean>}
 */
export async function enrichHandoff(projectId, updateLatestHandoffFn) {
  const settings = readSettings();
  const provider = settings.http_provider || "deepseek";
  const apiKey =
    settings.http_api_keys?.[provider] || settings.http_api_key || "";
  const baseUrl =
    settings.http_base_urls?.[provider] ||
    (provider === "deepseek" ? "https://api.deepseek.com/v1" :
     provider === "z-ai" ? "https://api.z.ai/api/paas/v4" :
     provider === "anthropic" ? "https://api.anthropic.com/v1" :
     "");
  const model = settings.http_model || getDefaultModelForProvider(provider);

  if (!apiKey || !baseUrl) {
    console.log("[handoff-enricher] No API config, skipping enrichment");
    return false;
  }

  const journalText = readJournal(projectId);
  if (!journalText) {
    console.log("[handoff-enricher] No journal found, skipping enrichment");
    return false;
  }

  let handoff = null;
  try {
    handoff = JSON.parse(
      fs.readFileSync(
        path.join(SESSION_DIR, projectId, "handoff.json"),
        "utf-8",
      ),
    );
  } catch {
    return false;
  }

  const prompt = buildEnrichmentPrompt(journalText, handoff);

  try {
    const result = await callLLM(provider, apiKey, baseUrl, model, prompt);
    if (!result) return false;

    const enrichment = parseEnrichmentResponse(result);
    if (!enrichment) return false;

    mergeEnrichment(projectId, handoff, enrichment, updateLatestHandoffFn);
    console.log("[handoff-enricher] Handoff enriched successfully");
    return true;
  } catch (err) {
    console.warn(
      "[handoff-enricher] Enrichment failed:",
      err.message,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Journal reading
// ---------------------------------------------------------------------------

function readJournal(projectId) {
  try {
    const journalPath = path.join(SESSION_DIR, projectId, "journal.jsonl");
    if (!fs.existsSync(journalPath)) return null;

    const raw = fs.readFileSync(journalPath, "utf-8");
    const lines = raw.trim().split("\n");
    const recentLines = lines.slice(-200);

    const entries = [];
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        if (!entry) continue;

        if (entry.type === "user_message" && entry.content) {
          const text =
            typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
          entries.push("User: " + text.slice(0, 300));
        } else if (entry.type === "assistant_message" && entry.content) {
          const text =
            typeof entry.content === "string"
              ? entry.content
              : JSON.stringify(entry.content);
          entries.push("Assistant: " + text.slice(0, 400));
        } else if (entry.type === "tool_result" && entry.summary) {
          entries.push(
            "Tool (" + (entry.toolName || "unknown") + "): " + entry.summary,
          );
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries.length > 0 ? entries.join("\n") : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildEnrichmentPrompt(journalText, handoff) {
  const handoffSummary = JSON.stringify(
    {
      accomplishments: handoff.accomplishment || [],
      decisions: handoff.decisionsLocked || [],
      findings: handoff.findings || [],
      objective: handoff.currentObjective || "",
      nextSteps: handoff.nextSteps || [],
      blockers: handoff.blockers || [],
    },
    null,
    2,
  );

  const schemaLines = [
    "  \"reasoningChain\": [\"string\", \"...\"]     // Step-by-step reasoning path",
    "  \"failedApproaches\": [\"string\", \"...\"]   // What was tried and did not work",
    "  \"patternsDiscovered\": [\"string\", \"...\"] // Patterns found in the codebase",
    "  \"userPreferences\": [\"string\", \"...\"]    // User implicit preferences",
    "  \"architecturalTensions\": [\"string\", \"...\"] // Design tensions or tradeoffs",
    "  \"summary\": \"string\"                     // 2-5 sentence narrative of the session",
  ];

  return [
    "You are enriching a development session handoff for an AI coding assistant. The next session's model will use this to understand what happened.",
    "",
    "Below is a conversation journal from a coding session, plus the current handoff. Your job: extract what the FACTS miss - reasoning, patterns, preferences.",
    "",
    "Output ONLY valid JSON with these exact fields:",
    "{",
    schemaLines.join("\n"),
    "}",
    "",
    "Rules:",
    "- Every array field must have at least 1 meaningful item, at most 5",
    "- Be specific - reference actual code, files, or decisions from the journal",
    "- 'summary' should be a flowing narrative, not bullet points",
    "- Don't repeat what's already in the handoff accomplishments",
    "- If a field has nothing meaningful to say, use an empty array []",
    "",
    "=== CURRENT HANDOFF (facts already recorded) ===",
    handoffSummary,
    "",
    "=== CONVERSATION JOURNAL (truncated) ===",
    journalText,
    "",
    "ENRICHMENT JSON:",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM call (supports OpenAI-compatible + Anthropic)
// ---------------------------------------------------------------------------

async function callLLM(provider, apiKey, baseUrl, model, prompt) {
  if (provider === "anthropic") {
    return callAnthropic(apiKey, baseUrl, model, prompt);
  }
  return callOpenAICompatible(apiKey, baseUrl, model, prompt);
}

async function callOpenAICompatible(apiKey, baseUrl, model, prompt) {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error("API error " + response.status + ": " + text);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

async function callAnthropic(apiKey, baseUrl, model, prompt) {
  const url = baseUrl.replace(/\/+$/, "") + "/messages";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || "claude-3-haiku-20240307",
      max_tokens: 1500,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error("Anthropic error " + response.status + ": " + text);
  }

  const data = await response.json();
  return data.content?.[0]?.text || null;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseEnrichmentResponse(text) {
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return validateEnrichment(parsed);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return validateEnrichment(parsed);
      } catch {
        // Failed to parse
      }
    }
  }

  return null;
}

function validateEnrichment(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  return {
    reasoningChain: ensureArray(parsed.reasoningChain, 5),
    failedApproaches: ensureArray(parsed.failedApproaches, 5),
    patternsDiscovered: ensureArray(parsed.patternsDiscovered, 5),
    userPreferences: ensureArray(parsed.userPreferences, 5),
    architecturalTensions: ensureArray(parsed.architecturalTensions, 5),
    summary:
      typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "",
  };
}

function ensureArray(val, maxItems) {
  if (!Array.isArray(val)) return [];
  return val
    .filter(function (v) {
      return typeof v === "string" && v.trim();
    })
    .slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// Merge into handoff
// ---------------------------------------------------------------------------

function mergeEnrichment(projectId, handoff, enrichment, updateFn) {
  const enriched = { ...handoff };

  if (enrichment.reasoningChain.length > 0) {
    const existing = new Set(
      (enriched.findings || []).map(function (f) {
        return f.toLowerCase().slice(0, 40);
      }),
    );
    for (const r of enrichment.reasoningChain) {
      if (!existing.has(r.toLowerCase().slice(0, 40))) {
        enriched.findings = [...(enriched.findings || []), "Reasoning: " + r];
      }
    }
  }

  if (enrichment.failedApproaches.length > 0) {
    for (const f of enrichment.failedApproaches) {
      enriched.findings = [
        ...(enriched.findings || []),
        "AVOID (failed approach): " + f,
      ];
    }
  }

  if (enrichment.patternsDiscovered.length > 0) {
    for (const p of enrichment.patternsDiscovered) {
      enriched.findings = [...(enriched.findings || []), "Pattern: " + p];
    }
  }

  if (enrichment.architecturalTensions.length > 0) {
    for (const t of enrichment.architecturalTensions) {
      enriched.findings = [...(enriched.findings || []), "Tension: " + t];
    }
  }

  if (enrichment.userPreferences.length > 0) {
    for (const p of enrichment.userPreferences) {
      enriched.findings = [...(enriched.findings || []), "Preference: " + p];
    }
  }

  if (enrichment.summary) {
    enriched.findings = [...(enriched.findings || []), enrichment.summary];
  }

  if (enriched.findings.length > 20) {
    enriched.findings = enriched.findings.slice(-20);
  }

  if (updateFn) {
    updateFn(projectId, enriched);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultModelForProvider(provider) {
  const defaults = {
    deepseek: "deepseek-v4-flash",
    kimi: "moonshot-v1-8k",
    openrouter: "openai/gpt-4o-mini",
    anthropic: "claude-3-haiku-20240307",
    gemini: "gemini-2.0-flash",
    "z-ai": "glm-5.2",
  };
  return defaults[provider] || "deepseek-v4-flash";
}
