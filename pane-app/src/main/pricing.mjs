/**
 * pricing.mjs — Dynamic model pricing for Pane.
 *
 * Pricing is fetched from OpenRouter's public model catalog (no auth required)
 * on startup and cached to disk. No hardcoded pricing values — the map is built
 * dynamically from live API data covering 367+ models across all providers.
 *
 * Used for:
 *   1. Cost tracking during conversations (calculateCost)
 *   2. Enriching model data with pricing for UI display (getPricingForModel)
 *   3. Analytics rate display (getModelRates)
 *
 * Pipeline: disk cache → OpenRouter API → cold-start seed
 * Cache: ~/.pane/cache/pricing.json (24h TTL, survives restarts)
 * Cold-start seed: ~10 common model prices, used only when
 *                  cache is empty AND network is unreachable AND
 *                  a lookup is needed immediately.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_FILE = path.join(os.homedir(), ".pane", "cache", "pricing.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Internal State ──────────────────────────────────────────────────────────
/** @type {Map<string, {input:number, output:number, cache_read?:number, cache_write?:number}>} */
let _pricingMap = new Map();
let _cacheLoaded = false;
let _initStarted = false;
let _lastFetchTime = 0;

// ── Internal Model Aliases ───────────────────────────────────────────────────
// Pane uses internal names for some models that don't match OpenRouter's IDs.
// Map them to their OpenRouter equivalents so pricing resolves correctly.
const MODEL_ALIASES = {
  "deepseek-reasoner":  "deepseek/deepseek-r1-0528",
  "deepseek-r1":        "deepseek/deepseek-r1-0528",
  "step-3.5-flash":     "stepfun/step-3-5-flash",
  "kimi-k2":            "moonshotai/kimi-k2",
  "mimo-v2-flash":      "xiaomi/mimo-v2-flash",
  "mimo-v2-pro":        "xiaomi/mimo-v2-pro",
  "mimo-v2-omni":       "xiaomi/mimo-v2-omni",
  "mimo-v2.5-pro":      "xiaomi/mimo-v2.5-pro",
};

// Tiny cold-start seed — used only when cache is empty AND network fetch fails
// AND a lookup is requested immediately. Covers SDK aliases and common models.
// This is NOT hardcoded pricing to maintain — it's a bootstrap fallback.
const COLD_START_SEED = {
  "claude-opus-4-6":   { input: 5.0,  output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "claude-sonnet-4-6": { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  "claude-haiku":      { input: 0.8,  output: 4.0,  cache_read: 0.08, cache_write: 1.0 },
  "opus":              { input: 5.0,  output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "sonnet":            { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  "haiku":             { input: 0.8,  output: 4.0,  cache_read: 0.08, cache_write: 1.0 },
  "default":           { input: 5.0,  output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "deepseek-chat":     { input: 0.14, output: 0.28, cache_read: 0.014 },
  "gemini-2.5-flash":  { input: 0.15, output: 0.6,  cache_read: 0.015 },
  "gemini-2.5-pro":    { input: 1.25, output: 10.0, cache_read: 0.125 },
  "gpt-4o":            { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":       { input: 0.15, output: 0.6 },
};

// ── Name Normalization ──────────────────────────────────────────────────────

/**
 * Normalize a model name for matching against the OpenRouter cache.
 * Strips provider prefix (e.g. "anthropic/"), normalizes separators,
 * strips common suffixes like -preview, -latest, -image.
 */
function normalizeModelName(name) {
  if (!name) return "";
  let n = name.toLowerCase().trim();
  // Strip provider prefix (e.g., "anthropic/", "google/")
  const slashIdx = n.indexOf("/");
  if (slashIdx >= 0) n = n.slice(slashIdx + 1);
  // Normalize separators: dots → hyphens for consistency
  n = n.replace(/\./g, "-");
  // Strip common trailing suffixes that don't change identity
  n = n.replace(/-(preview|latest|image|customtools|thinking|extended)$/, "");
  // Strip trailing date stamps like "2024-11" or "0528"
  n = n.replace(/-\d{4,6}$/, "");
  return n;
}

// ── Cache Layer ─────────────────────────────────────────────────────────────

/**
 * Load pricing cache from disk synchronously (called at module init).
 */
function _loadCacheSync() {
  try {
    const data = fs.readFileSync(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed.timestamp && parsed.entries && typeof parsed.entries === "object") {
      const age = Date.now() - parsed.timestamp;
      for (const [key, val] of Object.entries(parsed.entries)) {
        _pricingMap.set(key, val);
      }
      _cacheLoaded = true;
      console.log(`[pricing] Loaded ${_pricingMap.size} entries from cache (age: ${Math.round(age / 1000 / 60)}min)`);
      return true;
    }
  } catch {
    // Cache file missing or corrupt — will fetch fresh
  }
  return false;
}

/**
 * Save pricing cache to disk.
 */
async function _saveCache(entries) {
  try {
    const cacheDir = path.dirname(CACHE_FILE);
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const data = JSON.stringify({
      timestamp: Date.now(),
      entries: Object.fromEntries(entries),
    });
    await fs.promises.writeFile(CACHE_FILE, data, "utf-8");
    console.log(`[pricing] Saved ${entries.size} entries to cache`);
  } catch (err) {
    console.error("[pricing] Failed to save cache:", err.message);
  }
}

// ── OpenRouter Fetch ────────────────────────────────────────────────────────

/**
 * Fetch model pricing from OpenRouter's public API.
 * Builds a normalized map keyed by model name for fast substring matching.
 */
export async function fetchOpenRouterPricing() {
  _lastFetchTime = Date.now();
  try {
    const resp = await fetch(OPENROUTER_MODELS_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    if (!body?.data || !Array.isArray(body.data)) {
      throw new Error("Unexpected response format");
    }

    const newMap = new Map();
    for (const model of body.data) {
      const p = model.pricing;
      if (!p) continue;

      const promptPerToken = parseFloat(p.prompt);
      const completionPerToken = parseFloat(p.completion);
      if (isNaN(promptPerToken) || isNaN(completionPerToken)) continue;

      // Convert per-token → per-million-token
      const entry = {
        input: +(promptPerToken * 1_000_000).toFixed(4),
        output: +(completionPerToken * 1_000_000).toFixed(4),
      };
      if (p.input_cache_read) {
        const cr = parseFloat(p.input_cache_read);
        if (!isNaN(cr)) entry.cache_read = +(cr * 1_000_000).toFixed(4);
      }
      if (p.input_cache_write) {
        const cw = parseFloat(p.input_cache_write);
        if (!isNaN(cw)) entry.cache_write = +(cw * 1_000_000).toFixed(4);
      }

      // Key by normalized model name (e.g., "claude-sonnet-4-6")
      const normalizedKey = normalizeModelName(model.id);
      if (normalizedKey) {
        // Keep longest key — most specific match
        const existing = newMap.get(normalizedKey);
        if (!existing || normalizedKey.length > (existing._keyLen || 0)) {
          entry._keyLen = normalizedKey.length;
          newMap.set(normalizedKey, entry);
        }
      }

      // Also key by raw model ID (e.g., "anthropic/claude-sonnet-4.6")
      const rawKey = model.id.toLowerCase();
      if (rawKey !== normalizedKey) {
        const existing = newMap.get(rawKey);
        if (!existing || rawKey.length > (existing._keyLen || 0)) {
          const rawEntry = { ...entry, _keyLen: rawKey.length };
          newMap.set(rawKey, rawEntry);
        }
      }
    }

    // Strip internal key length tracking
    for (const val of newMap.values()) {
      delete val._keyLen;
    }

    _pricingMap = newMap;
    _cacheLoaded = true;

    // Persist to disk (fire-and-forget)
    _saveCache(_pricingMap).catch(() => {});

    console.log(`[pricing] Fetched ${_pricingMap.size} entries from OpenRouter`);
    return _pricingMap.size;
  } catch (err) {
    console.error(`[pricing] OpenRouter fetch failed: ${err.message}`);
    return 0;
  }
}

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the pricing system. Called at import time.
 * Loads disk cache synchronously, then fetches fresh data from OpenRouter.
 * The synchronous cache load means pricing is available immediately for most
 * startup lookups. The async fetch updates it in the background.
 */
function _init() {
  if (_initStarted) return;
  _initStarted = true;

  // 1. Load from disk cache (synchronous — instant)
  const loadedFromCache = _loadCacheSync();

  // 2. Always fetch fresh from OpenRouter in background (cache validates freshness)
  //    This handles first-run, stale cache, and models added since cache was saved.
  fetchOpenRouterPricing().catch(() => {});
}

// Fire sync init at module load
_init();

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Find pricing for a model name. Returns the pricing object or null.
 * Uses longest-substring matching against the cache keys.
 * Falls back to cold-start seed if map is empty (first startup race).
 */
function _findPricing(model) {
  if (!model) return null;
  if (model.endsWith(":free")) return { input: 0, output: 0 };

  // Resolve Pane-internal aliases to OpenRouter model IDs
  const aliasTarget = MODEL_ALIASES[model.toLowerCase()];
  const resolved = aliasTarget || model;

  // Normalize for matching: lowercase, dots→hyphens
  const normalized = resolved.toLowerCase().replace(/\./g, "-");

  // If cache hasn't loaded yet, check cold-start seed
  if (_pricingMap.size === 0) {
    if (COLD_START_SEED[normalized]) return COLD_START_SEED[normalized];
  }

  let bestMatch = null;
  let bestLength = 0;

  for (const [key, pricing] of _pricingMap) {
    const keyLower = key.toLowerCase();
    if (normalized.includes(keyLower) && keyLower.length > bestLength) {
      bestMatch = pricing;
      bestLength = keyLower.length;
    }
  }

  return bestMatch;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get pricing for a model ID (used by model-manager for UI enrichment).
 * Returns { input_cost, output_cost } with nulls if unknown.
 */
export function getPricingForModel(modelId) {
  const pricing = _findPricing(modelId);
  if (!pricing) return { input_cost: null, output_cost: null };
  return {
    input_cost: pricing.input ?? null,
    output_cost: pricing.output ?? null,
  };
}

/**
 * Get the list price ($/Mtok) for a model.
 * Returns { input, output } rates, or null if unknown.
 */
export function getModelRates(model) {
  const pricing = _findPricing(model);
  if (!pricing) return null;
  return {
    input: typeof pricing.input === "number" ? pricing.input : 0,
    output: typeof pricing.output === "number" ? pricing.output : 0,
  };
}

/**
 * Calculate the cost of a turn in USD.
 * @param {Object} params
 * @param {string} params.model
 * @param {string} params.provider
 * @param {number} params.inputTokens
 * @param {number} params.outputTokens
 * @param {number} [params.cacheReadTokens]
 * @param {number} [params.cacheWriteTokens]
 * @param {number} [params.apiReportedCost] - If provided by API (OpenRouter), use it.
 * @returns {number}
 */
export function calculateCost({
  model,
  provider,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  apiReportedCost = null,
}) {
  // If API already gave us the cost (OpenRouter), trust it.
  if (apiReportedCost !== null && apiReportedCost >= 0) {
    return +apiReportedCost.toFixed(6);
  }

  if (!model) return 0;

  // Free-tier models (OpenRouter :free suffix) cost nothing
  if (model.endsWith(":free")) return 0;

  const pricing = _findPricing(model);

  if (!pricing) {
    console.warn(`[pricing] No pricing for model "${model}" — cost will show as $0`);
    return 0;
  }

  // Anthropic reports input_tokens as the NON-cached portion.
  // cache_read_input_tokens is SEPARATE — they're additive, not overlapping.
  // input_tokens = tokens charged at full input rate
  // cache_read_input_tokens = tokens charged at cache_read rate
  // So: DO NOT subtract cacheReadTokens from inputTokens.
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * (pricing.input || 0);
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * (pricing.output || 0);

  // Cache read cost (discounted rate)
  const cacheReadCost =
    (Math.max(0, cacheReadTokens) / 1_000_000) * (pricing.cache_read || pricing.input || 0);

  // Cache write cost (sometimes more expensive, e.g. Anthropic)
  const cacheWriteCost =
    (Math.max(0, cacheWriteTokens) / 1_000_000) * (pricing.cache_write || pricing.input || 0);

  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  return +totalCost.toFixed(6);
}

/**
 * Get cache diagnostics.
 */
export function getPricingCacheInfo() {
  return {
    size: _pricingMap.size,
    cacheLoaded: _cacheLoaded,
    lastFetchTime: _lastFetchTime,
    usingSeed: _pricingMap.size <= Object.keys(COLD_START_SEED).length,
  };
}
