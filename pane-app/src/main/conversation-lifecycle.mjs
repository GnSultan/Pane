/**
 * Conversation Lifecycle — three-tier message management with budget integration.
 *
 * Problem: The current system either keeps everything (expensive) or binary-prunes
 * tool results (loses context). We need a middle ground: progressively summarize
 * old content while keeping recent turns exact.
 *
 * Three tiers:
 *   FRESH  — last 2-3 turns: full raw content (model needs these verbatim)
 *   RECENT — turns 3-10: tool results replaced with summaries, user/assistant kept
 *   ARCHIVAL — turns 10+: tool results cached on disk, messages[] only has summaries
 *
 * Budget integration: token-budget.mjs tells us when we're under pressure.
 * This module responds by promoting messages from fresh→recent→archival.
 *
 * Replaces: manageContextWindow() binary pruning in http-backend.mjs
 */

import { estimateTokens } from "./token-budget.mjs";
import { buildSummary, restoreRaw, pruneOldTurns } from "./tool-result-cache.mjs";

// Tier boundaries (by turn index from end of messages[])
const FRESH_DEPTH = 3;   // last 3 turns stay raw
const RECENT_DEPTH = 10;  // turns 3-10 get summarized

// Output/reserve overhead: max_tokens + tools definitions + stop sequences + formatting
const OUTPUT_RESERVE = 10000;

/**
 * Extract turn boundaries from messages array.
 * Returns array of { start, end, userMsgIdx } where each "turn" is
 * a user message + assistant response + any tool calls between them.
 *
 * @param {Array} messages
 * @returns {Array<{ start: number, end: number, turnIndex: number }>}
 */
export function detectTurns(messages) {
  const turns = [];
  let currentStart = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user" || msg.role === "system") {
      if (currentStart >= 0) {
        turns.push({ start: currentStart, end: i - 1, turnIndex: turns.length });
      }
      currentStart = i;
    }
  }

  // Close the last turn
  if (currentStart >= 0) {
    turns.push({
      start: currentStart,
      end: messages.length - 1,
      turnIndex: turns.length,
    });
  }

  return turns;
}

/**
 * Classify a turn into a lifecycle tier based on its position from the end.
 * @param {number} turnFromEnd - 0 = most recent turn
 * @returns {"fresh" | "recent" | "archival"}
 */
export function classifyTier(turnFromEnd) {
  if (turnFromEnd < FRESH_DEPTH) return "fresh";
  if (turnFromEnd < RECENT_DEPTH) return "recent";
  return "archival";
}

/**
 * Summarize tool messages in a turn. Mutates messages in place.
 * Returns the number of tokens saved.
 *
 * @param {Array} messages
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {object} options - { projectId, turnIndex, cache: boolean }
 * @returns {number} tokensSaved
 */
export function summarizeTurn(messages, startIdx, endIdx, options = {}) {
  const { projectId, turnIndex, cache = false } = options;
  let tokensSaved = 0;
  let seq = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;

    const originalContent =
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const originalTokens = estimateTokens(originalContent);

    // Build summary (and optionally cache raw on disk)
    const toolName = msg.name || "unknown";
    const entry = {
      toolName,
      toolId: msg.tool_call_id,
      content: originalContent,
    };

    const { summary } = buildSummary(
      projectId || "unknown",
      turnIndex || 0,
      seq++,
      entry,
      { cache },
    );

    const summaryTokens = estimateTokens(summary);
    msg.content = summary;

    // Track savings
    const saved = originalTokens - summaryTokens;
    if (saved > 0) tokensSaved += saved;
  }

  return tokensSaved;
}

/**
 * Compute total token estimate for the messages array.
 * Adds system prompt overhead and serialization framing.
 *
 * @param {Array} messages
 * @param {number} systemTokens
 * @returns {number}
 */
function computeTotalTokens(messages, systemTokens) {
  return systemTokens + estimateTokens(JSON.stringify(messages));
}

/**
 * Drop the oldest non-fresh, non-system turn entirely and replace
 * the user message with a short archival marker. Mutates messages in place.
 *
 * @param {Array} messages - mutated in place
 * @param {Array} turns - turn boundaries (from detectTurns)
 * @param {number} freshDepth - how many recent turns to protect
 * @returns {number} tokens saved (negative = messages got shorter)
 */
function dropOldestTurn(messages, turns, freshDepth) {
  // Find the oldest turn that isn't fresh and isn't the system prompt
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    const turnFromEnd = turns.length - 1 - t;
    if (turnFromEnd < freshDepth) break; // protected — stop here (rest are fresher)

    // Skip system message — never drop the system prompt
    const userMsg = messages[turn.start];
    if (userMsg?.role === "system") continue;

    // Calculate how many tokens this turn uses
    let turnTokens = 0;
    for (let i = turn.start; i <= turn.end; i++) {
      const msg = messages[i];
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      turnTokens += estimateTokens(content);
    }

    // Remove all messages in this turn (splice in reverse order to preserve indices)
    for (let i = turn.end; i >= turn.start; i--) {
      messages.splice(i, 1);
    }

    // Insert a single archival summary marker at the start position
    const archivalMsg = {
      role: "user",
      content: `[Archived turn ${turn.turnIndex} — summarized to fit context window. Original content available on disk.]`,
    };
    messages.splice(turn.start, 0, archivalMsg);

    const archivalTokens = estimateTokens(archivalMsg.content);
    return turnTokens - archivalTokens; // positive = saved
  }

  return 0;
}

/**
 * Main entry point: manage conversation lifecycle.
 * Call this instead of manageContextWindow().
 *
 * Prunes to the model's HARD limit (maxContextTokens - outputReserve),
 * not a soft utilization target. Uses a progressive loop:
 *   Phase 1: Summarize tool results (archival → recent)
 *   Phase 2: Drop entire old user turns (oldest first)
 *   Stops as soon as the total is under the hard limit.
 *
 * @param {Array} messages - The messages[] array (mutated in place)
 * @param {object} options
 * @param {string} options.projectId
 * @param {number} options.systemTokens - Token count of system prompt
 * @param {number} options.maxContextTokens - Model's context window size
 * @param {number} options.currentTurnIndex - Current turn number in session
 * @returns {{ action: string, tokensSaved: number, details: string }}
 */
export function manageConversation(messages, options = {}) {
  const {
    projectId = "unknown",
    systemTokens = 0,
    maxContextTokens = 128000,
    currentTurnIndex = 0,
  } = options;

  // HARD limit: model's max minus what we need for output + tools + framing
  const hardLimit = maxContextTokens - OUTPUT_RESERVE;
  // Soft trigger: start pruning when we exceed 50% of hard limit
  const triggerThreshold = Math.floor(hardLimit * 0.5);

  let totalTokens = computeTotalTokens(messages, systemTokens);

  // No pressure — nothing to do
  if (totalTokens <= triggerThreshold) {
    return { action: "none", tokensSaved: 0, details: "under 50% of hard limit" };
  }

  // Detect turns
  let turns = detectTurns(messages);
  let totalSaved = 0;
  let actionsSummary = [];
  let iterations = 0;
  const MAX_ITERATIONS = 50; // Safety valve

  // Progressive pruning loop: keep going until under hard limit
  while (totalTokens > hardLimit && iterations < MAX_ITERATIONS) {
    iterations++;
    let savedThisRound = 0;

    // Phase 1: Summarize tool results (archival → recent)
    // Skip fresh turns — model needs those verbatim
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t];
      const turnFromEnd = turns.length - 1 - t;
      const tier = classifyTier(turnFromEnd);

      if (tier === "fresh") continue;

      const saved = summarizeTurn(messages, turn.start, turn.end, {
        projectId,
        turnIndex: turn.turnIndex,
        cache: tier === "archival",
      });

      if (saved > 0) {
        savedThisRound += saved;
        totalSaved += saved;
      }
    }

    if (savedThisRound > 0) {
      actionsSummary.push(`summarized tools: -${savedThisRound} tokens`);
      totalTokens = computeTotalTokens(messages, systemTokens);
    }

    // If still over limit after Phase 1, drop entire turns (oldest first)
    if (totalTokens > hardLimit) {
      // Refresh turn boundaries (they changed due to splicing)
      turns = detectTurns(messages);
      const dropped = dropOldestTurn(messages, turns, FRESH_DEPTH);
      if (dropped > 0) {
        totalSaved += dropped;
        savedThisRound += dropped;
        actionsSummary.push(`dropped turn: -${dropped} tokens`);
        totalTokens = computeTotalTokens(messages, systemTokens);
      } else {
        // Can't save any more — break to avoid infinite loop
        actionsSummary.push("no more turns to drop — giving up");
        break;
      }
    }

    // If nothing saved this round, break to avoid infinite loop
    if (savedThisRound === 0) {
      actionsSummary.push("no savings possible — giving up");
      break;
    }
  }

  // Prune old cached turns on disk (keep last 10)
  if (totalSaved > 0) {
    try {
      pruneOldTurns(projectId, 10);
    } catch (err) {
      console.warn(`[conversation-lifecycle] pruneOldTurns failed: ${err.message}`);
    }
  }

  const finalTokens = computeTotalTokens(messages, systemTokens);
  const underLimit = finalTokens <= hardLimit;

  return {
    action: totalSaved > 0 ? "pruned" : "none",
    tokensSaved: totalSaved,
    tokensBefore: totalTokens + totalSaved,
    tokensAfter: finalTokens,
    underLimit,
    details: actionsSummary.join("; ") || "no pruning needed",
  };
}

/**
 * Force-prune messages to fit within a given token budget.
 * More aggressive than manageConversation — drops turns first, summarizes second.
 * Used as pre-flight guardrail before API calls.
 *
 * @param {Array} messages - mutated in place
 * @param {number} maxTokens - Maximum allowed tokens for serialized messages
 * @param {string} projectId
 * @returns {{ tokensSaved: number, messagesRemaining: number }}
 */
export function forcePruneToBudget(messages, maxTokens, projectId = "unknown") {
  let totalTokens = estimateTokens(JSON.stringify(messages));
  let totalSaved = 0;
  let iterations = 0;
  const MAX_ITERATIONS = 50;

  while (totalTokens > maxTokens && iterations < MAX_ITERATIONS) {
    iterations++;
    const turns = detectTurns(messages);

    // Phase 1: Summarize tool results from oldest turns
    let savedThisRound = 0;
    for (let t = 0; t < turns.length; t++) {
      const turn = turns[t];
      const turnFromEnd = turns.length - 1 - t;
      if (turnFromEnd < FRESH_DEPTH) continue; // keep fresh

      const saved = summarizeTurn(messages, turn.start, turn.end, {
        projectId,
        turnIndex: turn.turnIndex,
        cache: true,
      });
      if (saved > 0) savedThisRound += saved;
    }

    if (savedThisRound > 0) {
      totalSaved += savedThisRound;
      totalTokens = estimateTokens(JSON.stringify(messages));
    }

    // Phase 2: Drop oldest turns if still over budget
    if (totalTokens > maxTokens) {
      const refreshedTurns = detectTurns(messages);
      const dropped = dropOldestTurn(messages, refreshedTurns, FRESH_DEPTH);
      if (dropped > 0) {
        totalSaved += dropped;
        totalTokens = estimateTokens(JSON.stringify(messages));
      } else {
        break; // nothing more to drop
      }
    }

    if (savedThisRound === 0 && totalTokens > maxTokens) {
      break;
    }
  }

  return {
    tokensSaved: totalSaved,
    messagesRemaining: messages.length,
  };
}

/**
 * Restore full content for a specific turn's tool results.
 * Use this when the model references something from an earlier turn
 * and needs the raw data back.
 *
 * @param {Array} messages
 * @param {number} turnIndex
 * @param {string} projectId
 * @returns {boolean} true if any content was restored
 */
export function restoreTurnContent(messages, turnIndex, projectId) {
  const turns = detectTurns(messages);
  const turn = turns.find((t) => t.turnIndex === turnIndex);
  if (!turn) return false;

  let seq = 0;
  let restored = false;

  for (let i = turn.start; i <= turn.end; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;

    const raw = restoreRaw(projectId, turnIndex, seq++);
    if (raw && raw.content) {
      msg.content = raw.content;
      restored = true;
    }
  }

  return restored;
}
