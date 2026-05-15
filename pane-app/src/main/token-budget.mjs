/**
 * Token Budget Manager — centralized token estimation and budget allocation for Pane.
 *
 * All token estimation in Pane goes through this module. This provides:
 *  1. A single heuristic to tune (~4 chars/token with language-specific adjustments)
 *  2. Budget allocation: given a model limit, compute system/conversation/output budgets
 *  3. Request-level tracking: how many tokens are used by each component
 *
 * Why not tiktoken? It adds ~4MB and requires a WASM/native binding. The 4-char
 * heuristic is within ~10% for English prose and code — close enough for budget
 * decisions. If we ever need exact counts, swap estimateTokens() here and every
 * caller benefits.
 *
 * Usage:
 *   import { estimateTokens, allocateBudget, getModelLimit } from "./token-budget.mjs";
 */

import { MODEL_CONTEXT_LIMITS } from "./pane-system-prompt.mjs";
import { lookupModelContext } from "./model-registry.mjs";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Base ratio: ~4 characters per token for English text.
 * Code tends to be slightly more efficient (variable names, symbols compress
 * well), but markdown formatting adds overhead. 4.0 is the sweet spot.
 */
const CHARS_PER_TOKEN = 4.0;

/**
 * Per-message overhead: role header, formatting tokens, separators.
 * Claude uses ~4 tokens per message for role/formatting.
 */
const MESSAGE_OVERHEAD = 4;

/**
 * Estimate token count for a string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate token count for a conversation message.
 * Accounts for role header overhead.
 * @param {{ role: string, content: string | object }} message
 * @returns {number}
 */
export function estimateMessageTokens(message) {
  if (!message) return 0;
  const content = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
  return estimateTokens(content) + MESSAGE_OVERHEAD;
}

/**
 * Estimate total tokens for a conversation history.
 * @param {Array<{ role: string, content: string | object }>} messages
 * @returns {number}
 */
export function estimateConversationTokens(messages) {
  if (!messages || messages.length === 0) return 0;
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Model limits
// ---------------------------------------------------------------------------

/**
 * Get the context window limit for a model identifier.
 * Tries exact match → prefix match → provider heuristic → 128k fallback.
 *
 * @param {string} model
 * @returns {number}
 */
export function getModelLimit(model) {
  if (!model) return 128000;

  // 1. Live registry — API-reported context_length from model-manager.
  //    This is the single source of truth for models fetched from
  //    OpenRouter, DeepSeek, Anthropic, Gemini, etc. Every model object
  //    from the API includes its real context_length.
  const registryLimit = lookupModelContext(model);
  if (registryLimit !== null) return registryLimit;

  // 2. Static map — known model aliases (opus/sonnet/haiku, etc.)
  //    Fallback for models not yet in the registry (cold start race).
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];

  const modelLower = model.toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelLower.startsWith(key.toLowerCase())) return limit;
  }

  // 3. Provider-based heuristic — catch unknown models by provider family.
  //    Only reached when neither registry nor static map has the model.
  if (modelLower.includes("gemini")) return 1000000;
  if (modelLower.includes("haiku")) return 200000;
  if (modelLower.includes("claude") || modelLower.includes("opus") || modelLower.includes("sonnet")) return 1000000;
  if (modelLower.includes("qwen")) return 262144;

  return 128000;
}

/**
 * Get the default output token budget for a model.
 * Mirrors http-backend.mjs output limits.
 *
 * @param {string} model
 * @returns {number}
 */
export function getDefaultOutputBudget(model) {
  if (!model) return 8192;
  const m = model.toLowerCase();
  if (m.includes("deepseek-reasoner") || m.includes("deepseek-r1")) return 32768;
  if (m.includes("deepseek")) return 8192;
  if (m.includes("stepfun") || m.includes("step-")) return 16384;
  return 8192;
}

// ---------------------------------------------------------------------------
// Budget allocation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BudgetAllocation
 * @property {number} contextLimit - Total model context window
 * @property {number} outputBudget - Reserved for model output
 * @property {number} systemBudget - Available for system prompt
 * @property {number} conversationBudget - Available for conversation history
 * @property {number} conversationUsed - Already used by conversation
 * @property {number} conversationRemaining - Space left for conversation growth
 * @property {string} pressure - "low" | "medium" | "high" | "critical"
 */

/**
 * Allocate token budget across system prompt, conversation, and output.
 *
 * Strategy:
 *   1. Output budget is fixed (model's default or override)
 *   2. System prompt gets what it needs up to a cap
 *   3. Conversation gets the rest
 *
 * The system prompt cap prevents runaway context from starving conversation:
 *   - 128k models: system ≤ 40k (31%)
 *   - 200k models: system ≤ 60k (30%)
 *   - 1M+ models:  system ≤ 100k (10%)
 *
 * @param {object} options
 * @param {string} options.model - Model identifier
 * @param {number} [options.systemTokens] - Actual/estimated system prompt tokens
 * @param {number} [options.conversationTokens] - Actual/estimated conversation tokens
 * @param {number} [options.outputBudget] - Override output budget
 * @returns {BudgetAllocation}
 */
export function allocateBudget(options = {}) {
  const {
    model = null,
    systemTokens = 0,
    conversationTokens = 0,
    outputBudget: outputOverride = null,
  } = options;

  const contextLimit = getModelLimit(model);
  const outputBudget = outputOverride ?? getDefaultOutputBudget(model);

  // Available for system + conversation
  const available = contextLimit - outputBudget;

  // System prompt cap — prevents system prompt from eating all context
  const systemCap = contextLimit >= 500000
    ? 100000   // 1M+ models: generous cap
    : contextLimit >= 150000
      ? 60000  // 200k models
      : 40000; // 128k models

  // System gets what it needs up to the cap
  const systemBudget = Math.min(systemCap, Math.max(available * 0.4, 4000));

  // Conversation gets the rest
  const conversationBudget = available - Math.min(systemTokens, systemBudget);
  const conversationRemaining = conversationBudget - conversationTokens;

  // Pressure assessment
  const totalUsed = systemTokens + conversationTokens + outputBudget;
  const usagePercent = totalUsed / contextLimit;
  let pressure;
  if (usagePercent >= 0.95) pressure = "critical";
  else if (usagePercent >= 0.85) pressure = "high";
  else if (usagePercent >= 0.65) pressure = "medium";
  else pressure = "low";

  return {
    contextLimit,
    outputBudget,
    systemBudget,
    systemCap,
    systemTokens,
    conversationBudget,
    conversationUsed: conversationTokens,
    conversationRemaining: Math.max(0, conversationRemaining),
    totalUsed,
    usagePercent,
    pressure,
  };
}

// ---------------------------------------------------------------------------
// Budget tracking for a request lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a request-level budget tracker. Tracks running token usage
 * across system prompt assembly, tool calls, and conversation turns.
 *
 * @param {string} model
 * @param {number} [conversationTokens] - Pre-existing conversation tokens
 * @returns {RequestBudget}
 */
export function createRequestBudget(model, conversationTokens = 0) {
  const contextLimit = getModelLimit(model);
  const outputBudget = getDefaultOutputBudget(model);
  const available = contextLimit - outputBudget - conversationTokens;

  const tracker = {
    model,
    contextLimit,
    outputBudget,
    conversationTokens,
    systemTokens: 0,
    toolTokens: 0,

    /**
     * Record system prompt tokens.
     * @param {number} tokens
     */
    addSystem(tokens) {
      tracker.systemTokens += tokens;
    },

    /**
     * Record tool call/result tokens.
     * @param {number} tokens
     */
    addTool(tokens) {
      tracker.toolTokens += tokens;
    },

    /**
     * Add conversation tokens (new messages during this turn).
     * @param {number} tokens
     */
    addConversation(tokens) {
      tracker.conversationTokens += tokens;
    },

    /**
     * How many tokens remain for new content.
     * @returns {number}
     */
    remaining() {
      return Math.max(0,
        contextLimit - outputBudget - tracker.systemTokens - tracker.conversationTokens - tracker.toolTokens
      );
    },

    /**
     * Current usage as a fraction of context limit.
     * @returns {number}
     */
    usagePercent() {
      return (tracker.systemTokens + tracker.conversationTokens + tracker.toolTokens + outputBudget) / contextLimit;
    },

    /**
     * Current pressure level.
     * @returns {"low" | "medium" | "high" | "critical"}
     */
    pressure() {
      const pct = tracker.usagePercent();
      if (pct >= 0.95) return "critical";
      if (pct >= 0.85) return "high";
      if (pct >= 0.65) return "medium";
      return "low";
    },

    /**
     * Whether there's enough room for a given number of tokens.
     * @param {number} tokens
     * @returns {boolean}
     */
    canFit(tokens) {
      return tracker.remaining() >= tokens;
    },

    /**
     * Snapshot for logging/diagnostics.
     * @returns {object}
     */
    snapshot() {
      return {
        model: tracker.model,
        contextLimit: tracker.contextLimit,
        outputBudget: tracker.outputBudget,
        systemTokens: tracker.systemTokens,
        conversationTokens: tracker.conversationTokens,
        toolTokens: tracker.toolTokens,
        remaining: tracker.remaining(),
        usagePercent: Math.round(tracker.usagePercent() * 100),
        pressure: tracker.pressure(),
      };
    },
  };

  return tracker;
}

// ---------------------------------------------------------------------------
// Three-tier cache strategy constants (DeepSeek V4-inspired)
// ---------------------------------------------------------------------------

/**
 * Cache budget for each tier of the three-tier context architecture.
 * These constrain system prompt assembly and message selection to ensure
 * the cache prefix remains stable and within budget.
 *
 * FROZEN_TIER: identity, rules, brief, DNA, authoritative decisions.
 *   This forms the stable base of the cache prefix. Changes rarely.
 *
 * SESSION_TIER: intent directives, task context, recent work.
 *   Changes at session boundaries. Still cacheable for Anthropic.
 *
 * TURN_TIER: arbiter findings, quality, guidance.
 *   Changes every turn. NOT cached.
 *
 * TIER1_MESSAGE: sliding window messages (last N turns, exact).
 *   Stable across queries within the sliding window. Cache breakpoint AFTER this.
 *
 * TIER2_MESSAGE: semantic pool messages (compressed, query-relevant).
 *   Varies per query. NOT cached.
 */
export const CACHE_TIERS = {
  FROZEN_TIER_MAX_TOKENS: 8000,    // Max for frozen (identity, rules, brief)
  SESSION_TIER_MAX_TOKENS: 6000,   // Max for session (symbols, memories)
  TURN_TIER_MAX_TOKENS: 3000,      // Max for per-turn dynamic content
  TIER1_MESSAGE_TOKENS: 15000,     // Rough: ~5 turns × 3K avg
  TIER2_MESSAGE_TOKENS: 20000,     // Semantic pool: ~8 compressed turns × 2.5K
};

/**
 * Number of recent turns to keep in the sliding window (TIER 1).
 * These turns are always exact, never compressed, and form the stable
 * portion of the cache prefix alongside the system prompt.
 */
export const SLIDING_WINDOW_SIZE = 5;

/**
 * Number of compressed turns to include from the semantic pool (TIER 2).
 * These compete by relevance score and vary per query.
 */
export const SEMANTIC_POOL_MAX_TURNS = 15;
export const SEMANTIC_POOL_MIN_TURNS = 3;
