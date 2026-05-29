/**
 * Semantic Turn Selector — per-query turn relevance scoring for DeepSeek V4-inspired context.
 *
 * Problem: conversation-lifecycle.mjs Phase 2 drops the OLDEST turns first. This is wrong —
 * an old turn about authentication is more relevant to a new question about auth than
 * the most recent turn about UI styling. We drop the wrong thing, losing context the
 * model needs while keeping fluff it doesn't.
 *
 * Solution: embed the current user query, compute cosine similarity against all past-turn
 * compressed summaries, and drop the LEAST RELEVANT turns first. This is the "lightning
 * indexer" equivalent from DeepSeek V4's Compressed Sparse Attention (CSA).
 *
 * Three tiers:
 *   TIER 1 — Sliding window (last N turns): always included, always exact, always cached.
 *   TIER 2 — Semantic pool: compressed summaries, sorted by relevance to current query.
 *   TIER 3 — Heavily compressed knowledge: brain memories, handled by context-orchestrator.
 *
 * Integration:
 *   - ContextStore stores TurnSummaryRecords with optional embeddings
 *   - Brain-engine provides embedBatch() for computing embeddings
 *   - Conversation-lifecycle calls selectTurns() for Phase 2 pruning
 *   - Context-orchestrator calls scoreTurnsByRelevance() for TIER 2 pool injection
 *
 * Fallback:
 *   When embeddings aren't available (cold start, embedder not loaded), falls back to
 *   chronological ordering identical to current behavior. Zero behavior change.
 */

import { estimateTokens } from "./token-budget.mjs";

// How much weight to give recency vs semantic relevance (0-1)
// 0.85 semantic + 0.15 recency ensures relevant old turns aren't buried by recent noise
const SEMANTIC_WEIGHT = 0.85;

// --- Public API ---

/**
 * Score every turn by relevance to the current query embedding.
 * TIER 1 (sliding window) turns get score = Infinity — always included.
 *
 * @param {string|null} queryEmbeddingBase64 - base64-encoded Float32Array of query embedding, or null if embedder not ready
 * @param {Array<import("./context-store.mjs").TurnSummaryRecord>} turnSummaries - all past-turn summaries
 * @param {number} slidingWindowCount - how many recent turns are protected (TIER 1, default 5)
 * @returns {Array<ScoredTurn>} scored turns, sorted by score descending (highest relevance first)
 */
export function scoreTurnsByRelevance(queryEmbeddingBase64, turnSummaries, slidingWindowCount = 5) {
  if (!turnSummaries || turnSummaries.length === 0) return [];

  // If no query embedding (cold start), use chronological fallback
  const queryEmb = queryEmbeddingBase64 ? base64ToFloat32Array(queryEmbeddingBase64) : null;
  if (!queryEmb) {
    return fallbackChronological(turnSummaries, slidingWindowCount);
  }

  const totalTurns = turnSummaries.length;
  const scored = [];

  for (let i = 0; i < totalTurns; i++) {
    const turnFromEnd = totalTurns - 1 - i;
    const summary = turnSummaries[i];

    // TIER 1 sliding window: always included regardless of relevance
    if (turnFromEnd < slidingWindowCount) {
      scored.push({
        turnIndex: summary.turnIndex,
        score: Infinity,
        compressedText: summary.compressedText,
        tokenCount: summary.tokenCount || estimateTokens(summary.compressedText),
        tier: "sliding_window",
        request: summary.request || "",
        conclusion: summary.conclusion || "",
        tools: summary.tools || [],
      });
      continue;
    }

    // TIER 2: score by semantic relevance
    let semanticScore = 0;
    if (summary.embedding && queryEmb) {
      semanticScore = cosineSimilarity(queryEmb, summary.embedding);
    }

    // Hybrid: blend with recency bonus (turns closer to current get slight boost)
    // Normalized position: 0 = oldest, 1 = newest within TIER 2
    const tier2Turns = totalTurns - slidingWindowCount;
    const posInTier2 = Math.max(0, i - slidingWindowCount);
    const recencyFactor = tier2Turns > 0 ? posInTier2 / tier2Turns : 0;
    const recencyBonus = recencyFactor * 0.15; // max +0.15 for newest TIER 2 turn

    const finalScore = (semanticScore * SEMANTIC_WEIGHT) + recencyBonus;

    scored.push({
      turnIndex: summary.turnIndex,
      score: finalScore,
      compressedText: summary.compressedText,
      tokenCount: summary.tokenCount || estimateTokens(summary.compressedText),
      tier: "semantic_pool",
      request: summary.request || "",
      conclusion: summary.conclusion || "",
      tools: summary.tools || [],
    });
  }

  // Sort by score descending (most relevant first)
  // TIER 1 (Infinity) naturally sorts to the top
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Select which turns to include in the conversation given a token budget.
 * TIER 1 turns are always included. TIER 2 turns compete by relevance score.
 *
 * @param {Array<ScoredTurn>} scored - from scoreTurnsByRelevance()
 * @param {number} maxTier2Tokens - token budget for TIER 2 compressed turns (default 20000)
 * @param {number} minTurns - minimum number of TIER 2 turns to always include (default 3)
 * @param {number} maxTier2Turns - maximum TIER 2 turns to include (default 15)
 * @returns {TurnSelection}
 */
export function selectTurns(scored, maxTier2Tokens = 20000, minTurns = 3, maxTier2Turns = 15) {
  if (!scored || scored.length === 0) {
    return { includedTurnIndices: [], droppedTurnIndices: [], relevanceScores: [], tokensUsed: 0, totalTurns: 0 };
  }

  // Separate by tier (scored should already be sorted by score descending)
  const tier1 = scored.filter(s => s.tier === "sliding_window");
  const tier2 = scored.filter(s => s.tier === "semantic_pool");

  const included = tier1.map(s => s.turnIndex);
  const includedSet = new Set(included);
  const dropped = [];
  let tokensUsed = 0;

  // TIER 1 tokens always consumed
  for (const s of tier1) {
    tokensUsed += s.tokenCount;
  }

  // TIER 2: add by relevance score until budget or max turns
  // minTurns guarantees at least N compressed context turns
  let tier2Included = 0;

  for (const s of tier2) {
    if (tier2Included >= maxTier2Turns) {
      dropped.push(s.turnIndex);
      continue;
    }

    if (tier2Included < minTurns) {
      // Always include up to minTurns
      included.push(s.turnIndex);
      includedSet.add(s.turnIndex);
      tokensUsed += s.tokenCount;
      tier2Included++;
      continue;
    }

    // Check budget
    if (tokensUsed + s.tokenCount <= maxTier2Tokens) {
      included.push(s.turnIndex);
      includedSet.add(s.turnIndex);
      tokensUsed += s.tokenCount;
      tier2Included++;
    } else {
      dropped.push(s.turnIndex);
    }
  }

  return {
    includedTurnIndices: included,
    droppedTurnIndices: dropped,
    relevanceScores: scored.map(s => ({ turnIndex: s.turnIndex, score: s.score })),
    tokensUsed,
    totalTurns: scored.length,
  };
}

/**
 * Get top-N most relevant turn summaries for a given query.
 * Used by context-orchestrator to inject the semantic turn pool into the system prompt.
 *
 * @param {string|null} queryEmbeddingBase64
 * @param {Array<import("./context-store.mjs").TurnSummaryRecord>} turnSummaries
 * @param {number} topN - max summaries to return (default 8)
 * @returns {Array<{ turnIndex: number, request: string, conclusion: string, relevanceScore: number }>}
 */
export function getTopRelevantSummaries(queryEmbeddingBase64, turnSummaries, topN = 8) {
  const scored = scoreTurnsByRelevance(queryEmbeddingBase64, turnSummaries);
  const selection = selectTurns(scored, Infinity, 0, topN);

  return selection.includedTurnIndices
    .map(ti => {
      const summary = turnSummaries.find(s => s.turnIndex === ti);
      const scoreData = selection.relevanceScores.find(r => r.turnIndex === ti);
      if (!summary) return null;
      return {
        turnIndex: summary.turnIndex,
        request: summary.request || "",
        conclusion: summary.conclusion || "",
        tools: summary.tools || [],
        relevanceScore: scoreData?.score ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Format top relevant turn summaries into a compact system prompt layer.
 * Designed for the session tier — concise enough to not dominate the
 * system prompt budget, rich enough to give the model context.
 *
 * Auto-caching providers (DeepSeek, Kimi, etc.) benefit from prefix
 * stability: the session tier changes per-query at the system/message
 * boundary rather than mid-conversation, keeping the message body
 * chronological and cache-friendly.
 *
 * @param {Array<{ turnIndex: number, request: string, conclusion: string, tools: string[], relevanceScore: number }>} summaries
 * @param {number} [maxTokens=5000] — token budget cap (SESSION_TIER_MAX_TOKENS = 6000, leave headroom)
 * @returns {string}
 */
export function formatSemanticPool(summaries, maxTokens = 5000) {
  if (!summaries?.length) return "";

  const lines = ["\n\n[Contextually relevant past turns]"];
  let totalEstimate = estimateTokens(lines.join("\n"));

  for (const s of summaries) {
    const tools = s.tools?.length ? ` [tools: ${s.tools.join(", ")}]` : "";
    const line = `Turn ${s.turnIndex}: ${s.request} → ${s.conclusion}${tools}`;
    const lineTokens = estimateTokens(line);

    if (totalEstimate + lineTokens > maxTokens) break;

    lines.push(line);
    totalEstimate += lineTokens;
  }

  if (lines.length <= 1) return ""; // no summaries fit
  lines.push("[End relevant turns]\n");
  return lines.join("\n");
}

// --- Fallback ---

/**
 * Fallback when embeddings aren't available: use chronological ordering
 * identical to current behavior (most recent = most relevant).
 */
function fallbackChronological(turnSummaries, slidingWindowCount) {
  const totalTurns = turnSummaries.length;
  return turnSummaries.map((s, i) => {
    const turnFromEnd = totalTurns - 1 - i;
    return {
      turnIndex: s.turnIndex,
      // score = recency position (higher = more recent)
      score: totalTurns - i,
      compressedText: s.compressedText,
      tokenCount: s.tokenCount || estimateTokens(s.compressedText),
      tier: turnFromEnd < slidingWindowCount ? "sliding_window" : "semantic_pool",
      request: s.request || "",
      conclusion: s.conclusion || "",
      tools: s.tools || [],
    };
  }).sort((a, b) => b.score - a.score);
}

// --- Helpers ---

/**
 * Decode a base64-encoded Float32Array.
 * The brain-engine sends embeddings as base64 strings over IPC.
 */
export function base64ToFloat32Array(b64) {
  try {
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) return null;
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } catch {
    return null;
  }
}

/**
 * Compute cosine similarity between two normalized vectors.
 * Both vectors must already be L2-normalized (as bge-base-en-v1.5 output is).
 * Since they're normalized, dot product = cosine similarity.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// --- Type Definitions ---

/**
 * @typedef {object} ScoredTurn
 * @property {number} turnIndex
 * @property {number} score - Infinity for TIER 1, 0-1 for TIER 2
 * @property {string} compressedText
 * @property {number} tokenCount
 * @property {"sliding_window"|"semantic_pool"} tier
 * @property {string} request
 * @property {string} conclusion
 * @property {string[]} tools
 */

/**
 * @typedef {object} TurnSelection
 * @property {number[]} includedTurnIndices
 * @property {number[]} droppedTurnIndices
 * @property {Array<{ turnIndex: number, score: number }>} relevanceScores
 * @property {number} tokensUsed
 * @property {number} totalTurns
 */
