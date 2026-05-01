/**
 * Model Registry — live context window data from provider APIs.
 *
 * The only authoritative source for model context windows.
 * Populated by model-manager.mjs when models are fetched from provider APIs
 * (OpenRouter, DeepSeek, Anthropic, Gemini, etc.). Each model object from
 * the API includes its true `context_length` — this registry makes that
 * data available to every budget/planning function without circular deps.
 *
 * Import chain: model-registry → leaf module (zero Pane dependencies)
 *   model-manager → model-registry ✓ (populates)
 *   token-budget → model-registry ✓ (reads)
 *   pane-system-prompt → model-registry ✓ (reads)
 *
 * @module model-registry
 */

// Map<lowercase model ID string, context_length number>
const _registry = new Map();

/**
 * Register a model's context window.
 * Called by model-manager.mjs when models are loaded from API or disk cache.
 *
 * @param {string} modelId - Full model ID (e.g. "deepseek/deepseek-chat", "claude-sonnet-4-6")
 * @param {number} contextLength - Context window in tokens from the API
 */
export function registerModelContext(modelId, contextLength) {
  if (!modelId || typeof contextLength !== "number" || contextLength <= 0) return;
  _registry.set(modelId.toLowerCase(), contextLength);
}

/**
 * Batch-register multiple models at once.
 *
 * @param {Array<{id: string, context_length?: number}>} models
 */
export function registerModels(models) {
  if (!Array.isArray(models)) return;
  for (const m of models) {
    if (m.id && typeof m.context_length === "number" && m.context_length > 0) {
      _registry.set(m.id.toLowerCase(), m.context_length);
    }
  }
}

/**
 * Look up a model's context window from the live registry.
 * Checks exact match first, then prefix match.
 *
 * @param {string} modelId
 * @returns {number|null} context length in tokens, or null if not found
 */
export function lookupModelContext(modelId) {
  if (!modelId) return null;

  const lower = modelId.toLowerCase();

  // Exact match
  if (_registry.has(lower)) return _registry.get(lower);

  // Prefix match — longest prefix wins (most specific)
  let best = null;
  let bestLen = 0;
  for (const [key, val] of _registry) {
    if (lower.startsWith(key) && key.length > bestLen) {
      best = val;
      bestLen = key.length;
    }
  }
  if (best !== null) return best;

  // Partial match — model ID contains the key
  best = null;
  bestLen = 0;
  for (const [key, val] of _registry) {
    if (lower.includes(key) && key.length > bestLen) {
      best = val;
      bestLen = key.length;
    }
  }

  return best;
}

/**
 * How many models are currently registered (diagnostic).
 * @returns {number}
 */
export function getRegisteredModelCount() {
  return _registry.size;
}

/**
 * Clear all registered models (testing/diagnostics).
 */
export function clearRegistry() {
  _registry.clear();
}
