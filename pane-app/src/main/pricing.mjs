/**
 * pricing.mjs — Model pricing data and utilities for Pane.
 *
 * Prices in USD per million tokens ($/Mtok).
 *
 * NOTE: OpenRouter models usually return their own 'cost' field;
 * these are fallback rates for native providers (Anthropic, Gemini, DeepSeek).
 */

export const MODEL_PRICING = {
  // Anthropic (standard pricing)
  "claude-3-5-sonnet":            { input: 3.0,   output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  "claude-3-5-haiku":             { input: 1.0,   output: 5.0,  cache_read: 0.1,  cache_write: 1.25 },
  "claude-3-opus":                { input: 15.0,  output: 75.0, cache_read: 1.5,  cache_write: 18.75 },
  
  // DeepSeek (standard pricing)
  // DeepSeek Chat (V3): $0.14/$0.28 per Mtok. Cache hit is $0.014 (90% discount).
  "deepseek-chat":                { input: 0.14,  output: 0.28, cache_read: 0.014 },
  // DeepSeek Reasoner (R1): $0.55/$2.19 per Mtok. Cache hit is $0.14.
  "deepseek-reasoner":            { input: 0.55,  output: 2.19, cache_read: 0.14 },

  // Gemini (standard pricing for Flash/Pro)
  "gemini-2.0-flash":             { input: 0.1,   output: 0.4 },
  "gemini-2.0-pro":               { input: 1.25,  output: 5.0 },
  "gemini-1.5-flash":             { input: 0.075, output: 0.3 },
  "gemini-1.5-pro":               { input: 1.25,  output: 5.0 },

  // Kimi / Moonshot
  "moonshot-v1":                  { input: 1.6,   output: 1.6 },

  // StepFun
  "step-3.5-flash":               { input: 0.07,  output: 0.28 },
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

  // Find matching pricing rule (prefix match)
  const modelLower = model.toLowerCase();
  const entry = Object.entries(MODEL_PRICING).find(([prefix]) => 
    modelLower.includes(prefix.toLowerCase())
  );

  if (!entry) return 0;
  
  const pricing = entry[1];
  
  // Standard input/output cost (tokens NOT read from cache)
  const inputCost = ((inputTokens - cacheReadTokens) / 1_000_000) * (pricing.input || 0);
  const outputCost = (outputTokens / 1_000_000) * (pricing.output || 0);
  
  // Cache read cost (discounted rate)
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cache_read || pricing.input || 0);
  
  // Cache write cost (sometimes more expensive, e.g. Anthropic)
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cache_write || pricing.input || 0);

  const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  return +totalCost.toFixed(6);
}
