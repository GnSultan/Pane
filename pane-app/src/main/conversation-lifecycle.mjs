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
 * Main entry point: manage conversation lifecycle.
 * Call this instead of manageContextWindow().
 *
 * @param {Array} messages - The messages[] array (mutated in place)
 * @param {object} options
 * @param {string} options.projectId
 * @param {number} options.systemTokens - Token count of system prompt
 * @param {number} options.maxContextTokens - Model's context window size
 * @param {number} options.targetUtilization - Fraction of context to use (default 0.7)
 * @param {number} options.currentTurnIndex - Current turn number in session
 * @returns {{ action: string, tokensSaved: number, details: string }}
 */
export function manageConversation(messages, options = {}) {
  const {
    projectId = "unknown",
    systemTokens = 0,
    maxContextTokens = 128000,
    targetUtilization = 0.7,
    currentTurnIndex = 0,
  } = options;

  const totalTokens = systemTokens + estimateTokens(JSON.stringify(messages));
  const budget = maxContextTokens * targetUtilization;
  const utilization = totalTokens / budget;

  // No pressure — nothing to do
  if (utilization < 0.5) {
    return { action: "none", tokensSaved: 0, details: "under 50% budget" };
  }

  // Detect turns
  const turns = detectTurns(messages);
  let totalSaved = 0;
  let actionsSummary = [];

  // Process each turn from oldest to newest
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    const turnFromEnd = turns.length - 1 - t;
    const tier = classifyTier(turnFromEnd);

    if (tier === "fresh") continue; // Keep fresh turns raw

    const saved = summarizeTurn(messages, turn.start, turn.end, {
      projectId,
      turnIndex: turn.turnIndex,
      cache: tier === "archival",
    });

    if (saved > 0) {
      totalSaved += saved;
      actionsSummary.push(`turn ${turn.turnIndex}: -${saved} tokens (${tier})`);
    }
  }

  // If still under pressure after tier-based pruning, force-summarize recent turns too
  const afterTierTokens = totalTokens - totalSaved;
  if (afterTierTokens / budget > 0.85) {
    // Find the most recent "recent" tier turn and summarize it
    for (let t = turns.length - FRESH_DEPTH - 1; t >= 0; t--) {
      if (t < 0 || t >= turns.length) continue;
      const turn = turns[t];
      const saved = summarizeTurn(messages, turn.start, turn.end, {
        projectId,
        turnIndex: turn.turnIndex,
        cache: true,
      });
      if (saved > 0) {
        totalSaved += saved;
        actionsSummary.push(`forced turn ${turn.turnIndex}: -${saved} tokens`);
        break; // One at a time
      }
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

  return {
    action: totalSaved > 0 ? "summarized" : "none",
    tokensSaved: totalSaved,
    details: actionsSummary.join("; ") || "no tool results to summarize",
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
