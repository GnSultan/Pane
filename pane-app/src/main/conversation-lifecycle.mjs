/**
 * Conversation Lifecycle — semantic turn pruning with relevance scoring.
 *
 * Prunes conversation turns by relevance (V4 semantic selection), not by
 * position or token budget heuristics. Turns scored as irrelevant are dropped
 * and replaced with extractive summary markers for semantic retrieval.
 * Remaining non-fresh turns get their tool results summarized.
 *
 * Three tiers:
 *   FRESH  — last N turns: full raw content (model needs these verbatim)
 *   RECENT — turns past fresh window: tool results replaced with summaries
 *   ARCHIVAL — old cached turns pruned from disk, available via semantic recall
 *
 * Entry point: applyV4TurnSelection() — called from http-backend.mjs.
 * Fallback: forcePruneToBudget() — pre-flight guardrail with safety multiplier.
 */

import { estimateTokens, SLIDING_WINDOW_SIZE } from "./token-budget.mjs";
import { buildSummary, pruneOldTurns } from "./tool-result-cache.mjs";
import { contextStore } from "./context-store.mjs";

// Tier boundaries (by turn index from end of messages[])
export const FRESH_DEPTH = SLIDING_WINDOW_SIZE;  // last N turns stay raw (tied to V4 sliding window)
const RECENT_DEPTH = FRESH_DEPTH + 7;  // next 7 turns get summarized



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
    // Skip messages that already have _resultRef — they were summarized at
    // push time in http-backend.mjs. Full content is in ToolResultStore.
    // Re-summarizing would just replace the summary with the same value.
    if (msg._resultRef) continue;

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
 * Build an extractive summary marker from a dropped turn's messages.
 * Extracts the user request, tool calls made, and key assistant conclusion
 * — all from the raw messages, no LLM call needed. This gives the model
 * real context about what was discussed instead of a one-line void.
 *
 * @param {Array} messages
 * @param {number} startIdx - first message in the turn
 * @param {number} endIdx - last message in the turn
 * @param {number} turnIndex - sequential turn number
 * @returns {{ marker: { role: string, content: string }, extracted: { turnIndex: number, request: string, tools: string[], conclusion: string } }}
 */
function buildTurnSummaryMarker(messages, startIdx, endIdx, turnIndex) {
  // ── Extract user request ──────────────────────────────────────────────
  const userMsg = messages[startIdx];
  let requestText = "(system/init)";
  if (userMsg?.role === "user") {
    const content =
      typeof userMsg.content === "string"
        ? userMsg.content
        : JSON.stringify(userMsg.content || "");
    requestText = content.length > 160 ? content.slice(0, 157) + "..." : content;
  }

  // ── Collect tool calls + assistant texts ──────────────────────────────
  const toolNames = [];
  const assistantTexts = [];
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "assistant" && msg.content) {
      const text = typeof msg.content === "string" ? msg.content.trim() : "";
      if (text) assistantTexts.push(text);
    }
    if (msg.role === "tool" && msg.name) {
      toolNames.push(msg.name);
    }
  }

  // ── Extract key conclusion ────────────────────────────────────────────
  let conclusion = "";
  if (assistantTexts.length > 0) {
    // Take the last substantial assistant text as the "result"
    const last = assistantTexts[assistantTexts.length - 1];
    conclusion = last.length > 250 ? last.slice(0, 247) + "..." : last;
  }

  const uniqueTools = [...new Set(toolNames)];
  const toolLine =
    uniqueTools.length > 0
      ? `Tools used: ${uniqueTools.slice(0, 10).join(", ")}${uniqueTools.length > 10 ? ` +${uniqueTools.length - 10} more` : ""}`
      : "(conversation only — no tools)";

  // ── Assemble summary ──────────────────────────────────────────────────
  const lines = [`[Context archived — turn ${turnIndex}]`, `Request: ${requestText}`, toolLine];

  if (conclusion) {
    lines.push(`Result: ${conclusion}`);
  }

  const markerContent = lines.join("\n");
  const marker = {
    role: "user",
    content: markerContent,
  };

  const extracted = {
    turnIndex,
    request: requestText,
    tools: uniqueTools,
    conclusion,
    compressedText: markerContent,
    tokenCount: estimateTokens(markerContent),
    rawTokenCount: 0, // filled by caller when available
  };

  return { marker, extracted };
}

/**
 * Store a turn summary record for semantic retrieval.
 * Writes to contextStore for in-memory access; persisted to disk via debounce.
 * Fire-and-forget — never throws.
 *
 * @param {string} projectId
 * @param {{ turnIndex: number, request: string, tools: string[], conclusion: string, compressedText: string, tokenCount: number, rawTokenCount: number }} summary
 */
export function storeTurnSummary(projectId, summary) {
  try {
    const existing = contextStore.getTurnSummaries(projectId) || [];
    // Replace existing entry for this turn index, or append
    const idx = existing.findIndex(s => s.turnIndex === summary.turnIndex);
    const record = {
      ...summary,
      embedding: null, // filled lazily by semantic-turn-selector
    };
    if (idx >= 0) {
      existing[idx] = record;
    } else {
      existing.push(record);
    }
    contextStore.updateTurnSummaries(projectId, existing);
  } catch (err) {
    console.warn(`[conversation-lifecycle] storeTurnSummary failed: ${err.message}`);
  }
}

/**
 * Drop the oldest non-fresh, non-system turn entirely and replace
 * it with an extractive summary marker. Mutates messages in place.
 * Stores the summary via contextStore for later semantic retrieval.
 *
 * @param {Array} messages - mutated in place
 * @param {Array} turns - turn boundaries (from detectTurns)
 * @param {number} freshDepth - how many recent turns to protect
 * @param {string} [projectId] - project for turn summary persistence
 * @returns {{ tokensSaved: number, droppedTurn: { turnIndex, request, tools, conclusion } | null }}
 */
function dropOldestTurn(messages, turns, freshDepth, projectId) {
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

    // Build extractive summary BEFORE removing messages
    const { marker, extracted } = buildTurnSummaryMarker(
      messages,
      turn.start,
      turn.end,
      turn.turnIndex,
    );

    // Fill raw token count and persist
    extracted.rawTokenCount = turnTokens;

    // Remove all messages in this turn (splice in reverse order to preserve indices)
    for (let i = turn.end; i >= turn.start; i--) {
      messages.splice(i, 1);
    }

    // Insert the extractive summary marker at the start position
    messages.splice(turn.start, 0, marker);

    // Persist turn summary for semantic retrieval
    if (projectId) {
      storeTurnSummary(projectId, extracted);
    }

    const archivalTokens = estimateTokens(marker.content);
    return {
      tokensSaved: turnTokens - archivalTokens, // positive = saved
      droppedTurn: extracted,
    };
  }

  return { tokensSaved: 0, droppedTurn: null };
}

/**
 * Drop turns with the lowest relevance to the current query, preserving
 * the sliding window. Mutates messages in place. This replaces the
 * chronological dropOldestTurn() when semantic selection is available.
 *
 * Uses a pre-computed TurnSelection from semantic-turn-selector.mjs.
 * Each dropped turn is replaced with an extractive summary marker
 * (reuses buildTurnSummaryMarker) and persisted via contextStore.
 *
 * @param {Array} messages - mutated in place
 * @param {Array} turns - from detectTurns()
 * @param {import("./semantic-turn-selector.mjs").TurnSelection} selection - from selectTurns()
 * @param {string} [projectId] - project for turn summary persistence
 * @returns {{ tokensSaved: number, droppedTurns: Array }}
 */
export function dropIrrelevantTurns(messages, turns, selection, projectId) {
  const droppedTurns = [];
  let tokensSaved = 0;

  // Map turnIndex → { start, end } for fast lookup
  const turnByIndex = {};
  for (const t of turns) {
    turnByIndex[t.turnIndex] = t;
  }

  // Sort dropped turns by position descending (splice from end to preserve indices)
  const toDrop = (selection.droppedTurnIndices || [])
    .map(ti => turnByIndex[ti])
    .filter(Boolean)
    .sort((a, b) => b.start - a.start);

  for (const turn of toDrop) {
    // Calculate tokens before removal
    let turnTokens = 0;
    for (let i = turn.start; i <= turn.end; i++) {
      const content = typeof messages[i]?.content === "string"
        ? messages[i].content : JSON.stringify(messages[i]?.content || "");
      turnTokens += estimateTokens(content);
    }

    // Build extractive summary BEFORE removing messages
    const { marker, extracted } = buildTurnSummaryMarker(
      messages, turn.start, turn.end, turn.turnIndex
    );

    // Fill raw token count
    extracted.rawTokenCount = turnTokens;

    // Remove all messages in this turn (reverse order preserves indices)
    for (let i = turn.end; i >= turn.start; i--) {
      messages.splice(i, 1);
    }

    // Insert summary marker at the start position
    messages.splice(turn.start, 0, marker);

    // Persist turn summary for semantic retrieval
    if (projectId) {
      storeTurnSummary(projectId, extracted);
    }

    const archivalTokens = estimateTokens(marker.content);
    tokensSaved += turnTokens - archivalTokens;
    droppedTurns.push(extracted);
  }

  return { tokensSaved, droppedTurns };
}

/**
 * Truncate oversized message content when turn-level pruning is exhausted.
 *
 * Last resort: when all turns are fresh and total content still exceeds the
 * budget (single oversized tool result), halve the largest non-system message
 * content each iteration. Guarantees monotonic progress — each iteration
 * reduces the largest content by at least half. Stops when total estimated
 * tokens fit within budget or no truncatable message remains.
 *
 * Uses estimateTokens for the progress check. While the estimate can be off
 * by 5× for certain content mixes, each iteration halves real content,
 * so within 4-5 iterations the actual size shrinks below any reasonable
 * model limit regardless of estimation error.
 *
 * @param {Array} messages - mutated in place
 * @param {number} targetTokens - target total token budget
 * @returns {number} tokens saved
 */
function truncateOversizedMessages(messages, targetTokens) {
  let totalSaved = 0;
  let currentTokens = estimateTokens(JSON.stringify(messages));
  let iterations = 0;
  const MAX_ITER = 20;

  while (currentTokens > targetTokens && iterations < MAX_ITER) {
    iterations++;

    // Find the largest non-system message content
    let largestIdx = -1;
    let largestLen = 0;

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "system") continue;
      const content = typeof messages[i].content === "string" ? messages[i].content : "";
      if (content.length > largestLen) {
        largestLen = content.length;
        largestIdx = i;
      }
    }

    if (largestIdx === -1 || largestLen < 200) break; // nothing meaningful to truncate

    const msg = messages[largestIdx];
    const originalContent = typeof msg.content === "string" ? msg.content : "";
    if (!originalContent) break;

    const originalTokens = estimateTokens(originalContent);

    // Halve the content — aggressive but guarantees progress
    const halfLen = Math.floor(originalContent.length / 2);
    msg.content = originalContent.slice(0, halfLen) + "\n[...truncated]";

    const newTokens = estimateTokens(msg.content);
    const saved = originalTokens - newTokens;
    if (saved <= 0) break; // edge case: estimation says no savings

    totalSaved += saved;
    currentTokens = estimateTokens(JSON.stringify(messages));
  }

  return totalSaved;
}

/**
 * Force-prune messages to fit within a given token budget.
 * Drops oldest turns first, summarizes tool results second.
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
      const result = dropOldestTurn(messages, refreshedTurns, FRESH_DEPTH);
      if (result.tokensSaved > 0) {
        totalSaved += result.tokensSaved;
        totalTokens = estimateTokens(JSON.stringify(messages));
      } else {
        break; // nothing more to drop
      }
    }

    if (savedThisRound === 0 && totalTokens > maxTokens) {
      break;
    }
  }

  // Phase 3: Per-message content truncation — last resort when all turns are fresh
  // and turn-level pruning can't reduce further. Halves the largest non-system
  // message content each iteration. This is a nuclear option but prevents the
  // death loop where every turn is "fresh" but a single tool result exceeds budget.
  if (totalTokens > maxTokens) {
    const truncateSaved = truncateOversizedMessages(messages, maxTokens);
    totalSaved += truncateSaved;
    totalTokens = estimateTokens(JSON.stringify(messages));
  }

  return {
    tokensSaved: totalSaved,
    messagesRemaining: messages.length,
  };
}

/**
 * Apply V4 semantic turn selection to prune conversation by relevance.
 *
 * The old system gated on a 4-char/token heuristic that systematically
 * underestimated actual tokens, causing the 400 error. This function skips
 * token estimation entirely: V4 relevance scores determine what to drop.
 *
 *   1. Drop V4-selected irrelevant turns (inserts summary markers, persists for semantic retrieval)
 *   2. Summarize tool results for remaining non-fresh turns
 *   3. Prune old cached turns on disk
 *
 * @param {Array} messages - mutated in place
 * @param {import("./semantic-turn-selector.mjs").TurnSelection} turnSelection - from selectTurns()
 * @param {string} projectId
 * @returns {{ action: string, tokensSaved: number, droppedTurns: Array }}
 */
export function applyV4TurnSelection(messages, turnSelection, projectId) {
  if (!turnSelection || !turnSelection.droppedTurnIndices?.length) {
    return { action: "none", tokensSaved: 0, droppedTurns: [] };
  }

  // Detect turn boundaries for this message set
  const turns = detectTurns(messages);

  // Step 1: Drop V4-selected irrelevant turns
  // This inserts summary markers, persists turn summaries for semantic retrieval
  const dropResult = dropIrrelevantTurns(messages, turns, turnSelection, projectId);

  // Step 2: Summarize tool results for remaining non-fresh turns
  // Fresh turns (sliding window) keep full raw content — model needs them verbatim
  const refreshedTurns = detectTurns(messages);
  let summarySaved = 0;
  for (let t = 0; t < refreshedTurns.length; t++) {
    const turn = refreshedTurns[t];
    const turnFromEnd = refreshedTurns.length - 1 - t;
    if (turnFromEnd < FRESH_DEPTH) continue; // keep fresh turns raw

    summarySaved += summarizeTurn(messages, turn.start, turn.end, {
      projectId,
      turnIndex: turn.turnIndex,
      cache: true, // cache archival-sized tool results to disk
    });
  }

  // Prune old cached turns on disk (keep last 10)
  if (dropResult.tokensSaved > 0 || summarySaved > 0) {
    try {
      pruneOldTurns(projectId, 10);
    } catch (err) {
      console.warn(`[conversation-lifecycle] pruneOldTurns failed: ${err.message}`);
    }
  }

  const totalSaved = dropResult.tokensSaved + summarySaved;

  return {
    action: totalSaved > 0 ? "v4_pruned" : "none",
    tokensSaved: totalSaved,
    droppedTurns: dropResult.droppedTurns,
  };
}

/**
 * Drop ALL non-fresh turns (older than FRESH_DEPTH from the end).
 *
 * Used by the healable-400 path when the heuristic estimate is known to be
 * unreliable. This function guarantees the request fits by keeping only the
 * last FRESH_DEPTH fresh turns + system prompt — no token estimation, no
 * partial pruning, no early exit. Each dropped turn is replaced with an
 * extractive summary marker and persisted for semantic retrieval.
 *
 * Phase 2 (if maxTokens provided): per-message content truncation
 * when all remaining turns are fresh and total still exceeds budget.
 *
 * @param {Array} messages - mutated in place
 * @param {string} [projectId] - for turn summary persistence
 * @param {number} [maxTokens] - target max tokens. If provided, enables
 *   Phase 2 message-level truncation when turn dropping is exhausted.
 * @returns {{ dropped: number, tokensSaved: number }}
 */
export function dropAllNonFreshTurns(messages, projectId = "unknown", maxTokens = null) {
  let totalDropped = 0;
  let totalSaved = 0;
  let turns = detectTurns(messages);

  // Keep dropping oldest non-fresh turns until only fresh ones remain
  while (turns.length > FRESH_DEPTH) {
    const result = dropOldestTurn(messages, turns, FRESH_DEPTH, projectId);
    if (result.tokensSaved <= 0) break; // nothing more to drop (edge case)
    totalDropped++;
    totalSaved += result.tokensSaved;
    // Re-detect turns after mutation (splice shifts indices)
    turns = detectTurns(messages);
  }

  // Phase 2: Per-message truncation — all remaining turns are fresh,
  // but a single oversized tool result can still exceed the budget.
  if (maxTokens !== null) {
    const currentTokens = estimateTokens(JSON.stringify(messages));
    if (currentTokens > maxTokens) {
      const truncateSaved = truncateOversizedMessages(messages, maxTokens);
      totalSaved += truncateSaved;
    }
  }

  return { dropped: totalDropped, tokensSaved: totalSaved };
}
