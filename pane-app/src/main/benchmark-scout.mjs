// ============================================================================
// Benchmark Scout
// ============================================================================
//
// Seeds model capability priors into routing-store.
// Runs once at startup; re-seeds weekly.
//
// Two phases:
//   1. Embedded priors  — always available, curated from public benchmarks.
//                         These are the cold-start foundation. Conservative
//                         by design — real Pane experience overrides them
//                         within a few dozen interactions.
//
//   2. Live refresh     — periodic attempt to pull fresh data from provider
//                         APIs and public leaderboards. Gracefully no-ops on
//                         failure so offline/airgapped setups work fine.
//

import { routingStore } from "./routing-store.mjs";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const STATE_PATH         = join(homedir(), ".pane", "benchmark-scout.json");
const REFRESH_INTERVAL   = 7 * 24 * 60 * 60 * 1000; // weekly

// ── Embedded priors ────────────────────────────────────────────────────────
//
// Normalized scores 0–1. Sources: HumanEval, SWE-bench, MMLU, LMSYS Arena,
// provider pricing pages — all public, as of early 2026.
//
// Scores are intentionally modest because a prior should lose to real
// experience quickly. They exist to prevent cold-start total-blindness,
// not to be the final word.

const EMBEDDED_PRIORS = [
  // ── Anthropic ──────────────────────────────────────────────────────────
  // Scores grounded in public benchmarks (Mar 2026):
  //   SWE-bench Verified, HumanEval, GPQA Diamond, MMLU-Pro, Aider Polyglot
  //   Arena ELO: Opus 4.6 ≈ 1503 (#1), Sonnet 4.6 ≈ 1438 (#2-3)
  //   Pricing: Opus 4.6/4.5 dropped to $5/$25 (Anthropic Mar 2026 re-pricing)
  //            Opus 4/4.1 remain at $15/$75 (original release price)
  {
    // Frontier leader — SWE-bench 80.8%, Arena ELO #1 (~1503), GPQA 74.5%
    // 1M context, 128k output — best for long-range agentic work
    model: "claude-opus-4-6",    provider: "anthropic",
    codingScore: 0.93, reasoningScore: 0.94, generalScore: 0.92,
    costInputMtok: 5.0,  costOutputMtok: 25.0, arenaRank: 1,
  },
  {
    // SWE-bench 80.9% (first to break 80%), Aider Polyglot 89.4%
    // Near-identical capability to 4.6, slightly lower context cap
    model: "claude-opus-4-5",    provider: "anthropic",
    codingScore: 0.93, reasoningScore: 0.93, generalScore: 0.91,
    costInputMtok: 5.0,  costOutputMtok: 25.0, arenaRank: 3,
  },
  {
    // Original Opus 4 (May 2025) — still premium, $15/$75 pricing
    model: "claude-opus-4-1",    provider: "anthropic",
    codingScore: 0.89, reasoningScore: 0.93, generalScore: 0.90,
    costInputMtok: 15.0, costOutputMtok: 75.0, arenaRank: 5,
  },
  {
    // Original Opus 4 (May 2025)
    model: "claude-opus-4",      provider: "anthropic",
    codingScore: 0.88, reasoningScore: 0.92, generalScore: 0.89,
    costInputMtok: 15.0, costOutputMtok: 75.0, arenaRank: 6,
  },
  {
    // SWE-bench 79.6%, HumanEval 92.1%, GPQA 74.1%, MMLU-Pro 79.1%
    // "Near-Opus performance at 5x lower cost" — Arena ELO #2-3 (~1438)
    model: "claude-sonnet-4-6",  provider: "anthropic",
    codingScore: 0.90, reasoningScore: 0.90, generalScore: 0.88,
    costInputMtok: 3.0,  costOutputMtok: 15.0, arenaRank: 2,
  },
  {
    // SWE-bench 77.2%, HumanEval 88.7%, Aider Polyglot 78.8%, GPQA 65.0%
    model: "claude-sonnet-4-5",  provider: "anthropic",
    codingScore: 0.88, reasoningScore: 0.87, generalScore: 0.86,
    costInputMtok: 3.0,  costOutputMtok: 15.0, arenaRank: 4,
  },
  {
    // Sonnet 4 original (May 2025), 1M context window
    model: "claude-sonnet-4",    provider: "anthropic",
    codingScore: 0.84, reasoningScore: 0.86, generalScore: 0.84,
    costInputMtok: 3.0,  costOutputMtok: 15.0, arenaRank: 8,
  },
  {
    // HumanEval 85.2%, GSM8K 95.3% — fast and cheap
    model: "claude-haiku-4-5",   provider: "anthropic",
    codingScore: 0.80, reasoningScore: 0.79, generalScore: 0.78,
    costInputMtok: 1.0,  costOutputMtok: 5.0,  arenaRank: 15,
  },
  {
    // Previous-gen haiku — still fast, cheapest option
    model: "claude-haiku-3-5",   provider: "anthropic",
    codingScore: 0.72, reasoningScore: 0.74, generalScore: 0.73,
    costInputMtok: 0.8,  costOutputMtok: 4.0,  arenaRank: 22,
  },
  // CLI short names — resolve to latest model in each family (Mar 2026: 4.6 series)
  {
    model: "opus",   provider: "anthropic",
    codingScore: 0.93, reasoningScore: 0.94, generalScore: 0.92,
    costInputMtok: 5.0,  costOutputMtok: 25.0, arenaRank: 1,
  },
  {
    model: "sonnet", provider: "anthropic",
    codingScore: 0.90, reasoningScore: 0.90, generalScore: 0.88,
    costInputMtok: 3.0,  costOutputMtok: 15.0, arenaRank: 2,
  },
  {
    // Haiku 4.5 remains the latest haiku as of Mar 2026
    model: "haiku",  provider: "anthropic",
    codingScore: 0.80, reasoningScore: 0.79, generalScore: 0.78,
    costInputMtok: 1.0,  costOutputMtok: 5.0,  arenaRank: 15,
  },
  // ── Google ─────────────────────────────────────────────────────────────
  {
    model: "gemini-2.5-pro",     provider: "google",
    codingScore: 0.87, reasoningScore: 0.90, generalScore: 0.88,
    costInputMtok: 1.25, costOutputMtok: 10.0, arenaRank: 7,
  },
  {
    model: "gemini-2.0-pro",     provider: "google",
    codingScore: 0.82, reasoningScore: 0.85, generalScore: 0.83,
    costInputMtok: 1.25, costOutputMtok: 5.0,  arenaRank: 12,
  },
  {
    model: "gemini-2.0-flash",   provider: "google",
    codingScore: 0.77, reasoningScore: 0.78, generalScore: 0.77,
    costInputMtok: 0.10, costOutputMtok: 0.40, arenaRank: 19,
  },
  {
    model: "gemini-1.5-pro",     provider: "google",
    codingScore: 0.78, reasoningScore: 0.80, generalScore: 0.79,
    costInputMtok: 1.25, costOutputMtok: 5.0,  arenaRank: 18,
  },
  // Gemini CLI auto-routing alias
  {
    model: "gemini-3-flash-preview",      provider: "gemini",
    codingScore: 0.82, reasoningScore: 0.85, generalScore: 0.83,
    costInputMtok: 0,    costOutputMtok: 0,    arenaRank: 12,
  },
  // ── OpenAI ─────────────────────────────────────────────────────────────
  {
    model: "gpt-4o",             provider: "openai",
    codingScore: 0.83, reasoningScore: 0.85, generalScore: 0.84,
    costInputMtok: 2.5,  costOutputMtok: 10.0, arenaRank: 10,
  },
  {
    model: "gpt-4o-mini",        provider: "openai",
    codingScore: 0.71, reasoningScore: 0.72, generalScore: 0.71,
    costInputMtok: 0.15, costOutputMtok: 0.60, arenaRank: 25,
  },
  {
    model: "o3",                 provider: "openai",
    codingScore: 0.91, reasoningScore: 0.95, generalScore: 0.92,
    costInputMtok: 10.0, costOutputMtok: 40.0, arenaRank: 9,
  },
  {
    model: "o4-mini",            provider: "openai",
    codingScore: 0.86, reasoningScore: 0.89, generalScore: 0.87,
    costInputMtok: 1.1,  costOutputMtok: 4.4,  arenaRank: 11,
  },
  {
    model: "o3-mini",            provider: "openai",
    codingScore: 0.84, reasoningScore: 0.88, generalScore: 0.85,
    costInputMtok: 1.1,  costOutputMtok: 4.4,  arenaRank: 13,
  },
  // ── DeepSeek ───────────────────────────────────────────────────────────
  {
    model: "deepseek/deepseek-v4-flash", provider: "deepseek",
    codingScore: 0.84, reasoningScore: 0.88, generalScore: 0.85,
    costInputMtok: 0.07, costOutputMtok: 0.28, arenaRank: 12,
  },
];

// ── State ──────────────────────────────────────────────────────────────────

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastSeededAt: 0, lastFetchedAt: 0 };
  }
}

function saveState(state) {
  mkdirSync(join(homedir(), ".pane"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Seed ───────────────────────────────────────────────────────────────────

function seedEmbedded() {
  for (const p of EMBEDDED_PRIORS) {
    routingStore.upsertPrior({ ...p, source: "embedded" });
  }
  console.log(`[benchmark-scout] seeded ${EMBEDDED_PRIORS.length} embedded priors`);
}

// ── Live refresh ───────────────────────────────────────────────────────────
//
// Fetches fresh cost data from LiteLLM's community-maintained model price
// registry. This is the most reliable public source for token pricing across
// all major providers — updated frequently as models change their pricing.
//
// Maps our internal model names to LiteLLM keys, updates cost fields in
// benchmark_priors. Benchmark scores are NOT overwritten — only pricing.
// Any failure is silently swallowed; the app works fine on stale/embedded data.

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Maps our model identifiers to the keys LiteLLM uses.
// Each entry is a list of candidates — first match wins.
const LITELLM_MAP = {
  // Anthropic — current (Mar 2026)
  "claude-opus-4-6":   ["claude-opus-4-6-v1",                "claude-opus-4-6"],
  "claude-opus-4-5":   ["claude-opus-4-5-20251101-v1:0",     "claude-opus-4-5-20251101", "claude-opus-4-5"],
  "claude-opus-4-1":   ["claude-opus-4-1-20250805-v1:0",     "claude-opus-4-1-20250805", "claude-opus-4-1"],
  "claude-opus-4":     ["claude-opus-4-20250514-v1:0",       "claude-opus-4-20250514",   "claude-opus-4"],
  "claude-sonnet-4-6": ["claude-sonnet-4-6",                 "claude-sonnet-4-6-v1"],
  "claude-sonnet-4-5": ["claude-sonnet-4-5-20250929-v1:0",   "claude-sonnet-4-5-20251101","claude-sonnet-4-5"],
  "claude-sonnet-4":   ["claude-sonnet-4-20250514-v1:0",     "claude-sonnet-4-20250514", "claude-sonnet-4"],
  "claude-haiku-4-5":  ["claude-haiku-4-5-20251001-v1:0",    "claude-haiku-4-5-20251001","claude-haiku-4-5"],
  "claude-haiku-3-5":  ["claude-3-5-haiku-20241022-v1:0",    "claude-3-5-haiku-20241022","claude-haiku-3-5"],
  // CLI short names — resolve to latest in each family (4.6 series as of Mar 2026)
  "opus":              ["claude-opus-4-6-v1",                "claude-opus-4-6"],
  "sonnet":            ["claude-sonnet-4-6",                 "claude-sonnet-4-6-v1"],
  "haiku":             ["claude-haiku-4-5-20251001-v1:0",    "claude-haiku-4-5-20251001"],
  // OpenAI
  "gpt-4o":            ["gpt-4o-2024-11-20",                 "gpt-4o"],
  "gpt-4o-mini":       ["gpt-4o-mini-2024-07-18",            "gpt-4o-mini"],
  "o3":                ["o3-2025-04-16",                     "o3"],
  "o4-mini":           ["o4-mini-2025-04-16",                "o4-mini"],
  "o3-mini":           ["o3-mini-2025-01-31",                "o3-mini"],
  // Google (LiteLLM uses "gemini/" prefix)
  "gemini-2.5-pro":    ["gemini/gemini-2.5-pro",             "gemini-2.5-pro"],
  "gemini-2.0-pro":    ["gemini/gemini-2.0-pro",             "gemini-2.0-pro-exp"],
  "gemini-2.0-flash":  ["gemini/gemini-2.0-flash",           "gemini-2.0-flash"],
  "gemini-1.5-pro":    ["gemini/gemini-1.5-pro",             "gemini-1.5-pro"],
  // DeepSeek
  "deepseek-v4-flash": ["deepseek-v4-flash", "deepseek-v4-flash"],
};

// Provider lookup for our model names (needed for updatePriorCost)
const MODEL_PROVIDER = {
  "claude-opus-4-6": "anthropic", "claude-opus-4-5": "anthropic",
  "claude-opus-4-1": "anthropic", "claude-opus-4": "anthropic",
  "claude-sonnet-4-6": "anthropic", "claude-sonnet-4-5": "anthropic",
  "claude-sonnet-4": "anthropic",
  "claude-haiku-4-5": "anthropic", "claude-haiku-3-5": "anthropic",
  "opus": "anthropic", "sonnet": "anthropic", "haiku": "anthropic",
  "gpt-4o": "openai", "gpt-4o-mini": "openai",
  "o3": "openai", "o4-mini": "openai", "o3-mini": "openai",
  "gemini-2.5-pro": "google", "gemini-2.0-pro": "google",
  "gemini-2.0-flash": "google", "gemini-1.5-pro": "google",
  "deepseek-v4-flash": "deepseek",
};

async function tryLiveRefresh() {
  try {
    console.log("[benchmark-scout] fetching LiteLLM price data...");

    const res = await fetch(LITELLM_URL, {
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "pane-benchmark-scout/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    let updated = 0;

    for (const [ourModel, litellmKeys] of Object.entries(LITELLM_MAP)) {
      let entry = null;
      for (const key of litellmKeys) {
        entry = data[key];
        if (entry) break;
      }
      if (!entry) continue;

      const inputMtok  = (entry.input_cost_per_token  ?? 0) * 1_000_000;
      const outputMtok = (entry.output_cost_per_token ?? 0) * 1_000_000;
      if (inputMtok <= 0 && outputMtok <= 0) continue;

      const provider = MODEL_PROVIDER[ourModel];
      if (!provider) continue;

      routingStore.updatePriorCost(ourModel, provider, inputMtok, outputMtok);
      updated++;
    }

    console.log(`[benchmark-scout] updated costs for ${updated} models from LiteLLM`);
  } catch (err) {
    // Non-fatal — embedded priors and stale cost data still work fine
    console.warn("[benchmark-scout] live refresh failed (non-fatal):", err.message);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function ensurePriors() {
  const state     = readState();
  const now       = Date.now();
  const needsSeed = routingStore.priorCount() === 0;
  const stale     = (now - (state.lastSeededAt ?? 0)) > REFRESH_INTERVAL;

  if (needsSeed || stale) {
    seedEmbedded();
    await tryLiveRefresh();
    saveState({ ...state, lastSeededAt: now, lastFetchedAt: now });
  }
}

// ── Manual update ──────────────────────────────────────────────────────────
//
// Called by IPC handler if we ever expose "refresh benchmarks" in UI.

export function forceRefresh() {
  seedEmbedded();
  saveState({ lastSeededAt: Date.now(), lastFetchedAt: 0 });
  console.log("[benchmark-scout] forced refresh complete");
  return routingStore.stats();
}
