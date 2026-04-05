/**
 * pricing.mjs — Model pricing data and utilities for Pane.
 *
 * Prices in USD per million tokens ($/Mtok).
 *
 * Used for:
 *   1. Cost tracking during conversations (calculateCost)
 *   2. Enriching model data with pricing (model-manager enrichWithPricing)
 *
 * OpenRouter models get pricing from the API directly. These entries are
 * used for native providers (Anthropic, DeepSeek, Gemini) and as fallback.
 *
 * Entries are matched by prefix — most specific match wins.
 */

export const MODEL_PRICING = {
  // ── Anthropic ────────────────────────────────────────────────────────────
  // Claude 4.6 (Opus/Sonnet)
  "claude-opus-4-6":              { input: 5.0,   output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "claude-sonnet-4-6":            { input: 3.0,   output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  // Claude 4.5
  "claude-opus-4-5":              { input: 5.0,   output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "claude-sonnet-4-5":            { input: 3.0,   output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  // Claude 4
  "claude-opus-4":                { input: 5.0,   output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "claude-sonnet-4":              { input: 3.0,   output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  // Haiku
  "claude-haiku":                 { input: 0.8,   output: 4.0,  cache_read: 0.08, cache_write: 1.0 },
  // SDK aliases (short names from Claude Code CLI)
  "opus":                         { input: 5.0,   output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  "sonnet":                       { input: 3.0,   output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  "haiku":                        { input: 0.8,   output: 4.0,  cache_read: 0.08, cache_write: 1.0 },
  "default":                      { input: 5.0,   output: 25.0, cache_read: 0.5,  cache_write: 6.25 },
  // Legacy
  "claude-3-5-sonnet":            { input: 3.0,   output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  "claude-3-5-haiku":             { input: 0.8,   output: 4.0,  cache_read: 0.08, cache_write: 1.0 },
  "claude-3-opus":                { input: 15.0,  output: 75.0, cache_read: 1.5,  cache_write: 18.75 },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  "deepseek-chat":                { input: 0.14,  output: 0.28, cache_read: 0.014 },
  "deepseek-reasoner":            { input: 0.55,  output: 2.19, cache_read: 0.14 },

  // ── Gemini ───────────────────────────────────────────────────────────────
  // Gemini 3.x (90% cache discount on 2.5+)
  // NOTE: entries must cover all version variants (3, 3.1, etc.)
  "gemini-3-pro":                 { input: 1.25,  output: 10.0, cache_read: 0.125 },
  "gemini-3.1-pro":               { input: 1.25,  output: 10.0, cache_read: 0.125 },
  "gemini-3-flash-preview":       { input: 0.15,  output: 0.6,  cache_read: 0.015 },
  "gemini-3-flash":               { input: 0.15,  output: 0.6,  cache_read: 0.015 },
  "gemini-3.1-flash":             { input: 0.15,  output: 0.6,  cache_read: 0.015 },
  "gemini-3.1-flash-lite":        { input: 0.02,  output: 0.1,  cache_read: 0.002 },
  // Gemini 2.5
  "gemini-2.5-pro":               { input: 1.25,  output: 10.0, cache_read: 0.125 },
  "gemini-2.5-flash":             { input: 0.15,  output: 0.6,  cache_read: 0.015 },
  "gemini-2.5-flash-lite":        { input: 0.02,  output: 0.1,  cache_read: 0.002 },
  // Gemini 2.0 (75% discount)
  "gemini-2.0-flash":             { input: 0.1,   output: 0.4,  cache_read: 0.025 },
  "gemini-2.0-pro":               { input: 1.25,  output: 5.0,  cache_read: 0.3125 },
  // Gemini 1.5
  "gemini-1.5-flash":             { input: 0.075, output: 0.3,  cache_read: 0.01875 },
  "gemini-1.5-pro":               { input: 1.25,  output: 5.0,  cache_read: 0.3125 },

  // ── Kimi / Moonshot ──────────────────────────────────────────────────────
  "moonshot-v1":                  { input: 1.6,   output: 1.6,  cache_read: 0.4 },

  // ── StepFun ──────────────────────────────────────────────────────────────
  "step-3.5-flash":               { input: 0.07,  output: 0.28, cache_read: 0.014 },

  // ── Xiaomi MiMo ────────────────────────────────────────────────────────
  "mimo-v2-pro":                  { input: 1.0,   output: 3.0 },
  "mimo-v2-flash":                { input: 0,     output: 0 },
  "mimo-v2-omni":                 { input: 1.0,   output: 3.0 },
};

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
  apiReportedCost = null
}) {
  // If API already gave us the cost (OpenRouter), trust it.
  if (apiReportedCost !== null && apiReportedCost >= 0) {
    return +apiReportedCost.toFixed(6);
  }

  if (!model) return 0;

  // Free-tier models (OpenRouter :free suffix) cost nothing
  if (model.endsWith(":free")) return 0;

  // Find the MOST SPECIFIC matching pricing rule (longest prefix wins).
  // This prevents short prefixes like "flash" from matching before
  // the correct "gemini-3.1-flash" entry.
  const modelLower = model.toLowerCase();
  let bestMatch = null;
  let bestLength = 0;
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    const prefixLower = prefix.toLowerCase();
    if (modelLower.includes(prefixLower) && prefixLower.length > bestLength) {
      bestMatch = pricing;
      bestLength = prefixLower.length;
    }
  }

  if (!bestMatch) {
    console.warn(`[pricing] No pricing for model "${model}" — cost will show as $0`);
    return 0;
  }

  const pricing = bestMatch;

  // Anthropic reports input_tokens as the NON-cached portion.
  // cache_read_input_tokens is SEPARATE — they're additive, not overlapping.
  // input_tokens = tokens charged at full input rate
  // cache_read_input_tokens = tokens charged at cache_read rate
  // So: DO NOT subtract cacheReadTokens from inputTokens.
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * (pricing.input || 0);
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * (pricing.output || 0);

  // Cache read cost (discounted rate)
  const cacheReadCost = (Math.max(0, cacheReadTokens) / 1_000_000) * (pricing.cache_read || pricing.input || 0);

  // Cache write cost (sometimes more expensive, e.g. Anthropic)
  const cacheWriteCost = (Math.max(0, cacheWriteTokens) / 1_000_000) * (pricing.cache_write || pricing.input || 0);

  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  return +totalCost.toFixed(6);
}

/**
 * Get the list price ($/Mtok) for a model.
 * Returns { input, output } rates, or null if unknown.
 */
export function getModelRates(model) {
  if (!model) return null;
  if (model.endsWith(":free")) return { input: 0, output: 0 };
  const modelLower = model.toLowerCase();
  let bestMatch = null;
  let bestLength = 0;
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    const prefixLower = prefix.toLowerCase();
    if (modelLower.includes(prefixLower) && prefixLower.length > bestLength) {
      bestMatch = pricing;
      bestLength = prefixLower.length;
    }
  }
  return bestMatch ? { input: bestMatch.input || 0, output: bestMatch.output || 0 } : null;
}
