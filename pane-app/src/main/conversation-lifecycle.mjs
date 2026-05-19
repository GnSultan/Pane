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

import { estimateTokens, getDefaultOutputBudget, SLIDING_WINDOW_SIZE } from "./token-budget.mjs";
import { buildSummary, restoreRaw, pruneOldTurns } from "./tool-result-cache.mjs";
import { contextStore } from "./context-store.mjs";

// Tier boundaries (by turn index from end of messages[])
export const FRESH_DEPTH = SLIDING_WINDOW_SIZE;  // last N turns stay raw (tied to V4 sliding window)
const RECENT_DEPTH = FRESH_DEPTH + 7;  // next 7 turns get summarized



// Tools/framing overhead on top of max_tokens (tool definitions, [Pane context] preamble, formatting)
const TOOLS_FRAMING_OVERHEAD = 5000;

/**
 * Compute the output reserve for a model: max_tokens + tools/framing overhead.
 * This is what must be reserved from the context window for non-conversation content.
 * @param {string|null} model
 * @returns {number}
 */
function getOutputReserve(model) {
  const outputBudget = model ? getDefaultOutputBudget(model) : 8192;
  return outputBudget + TOOLS_FRAMING_OVERHEAD;
}

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
  const { projectId, turnIndex, cache = false, conversationId = null } = options;
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
  // If messages[0] is already the system prompt, systemTokens double-counts it.
  // Only add systemTokens separately when the system prompt is NOT in messages.
  const hasSystemInMessages = messages.length > 0 && messages[0].role === "system";
  if (hasSystemInMessages) {
    return estimateTokens(JSON.stringify(messages));
  }
  return systemTokens + estimateTokens(JSON.stringify(messages));
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
export function storeTurnSummary(projectId, summary, conversationId = null) {
  try {
    const key = conversationId || projectId;
    const existing = contextStore.getTurnSummaries(key) || [];
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
    contextStore.updateTurnSummaries(key, existing);
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
function dropOldestTurn(messages, turns, freshDepth, projectId, conversationId = null) {
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
      storeTurnSummary(projectId, extracted, conversationId);
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
 * @param {string|null} [conversationId] - conversation-scoped key for turn summary storage
 * @returns {{ tokensSaved: number, droppedTurns: Array }}
 */
export function dropIrrelevantTurns(messages, turns, selection, projectId, conversationId = null) {
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
      storeTurnSummary(projectId, extracted, conversationId);
    }

    const archivalTokens = estimateTokens(marker.content);
    tokensSaved += turnTokens - archivalTokens;
    droppedTurns.push(extracted);
  }

  return { tokensSaved, droppedTurns };
}

/**
 * Main entry point: manage conversation lifecycle.
 * Call this instead of manageContextWindow().
 *
 * Prunes to the model's HARD limit (maxContextTokens - outputReserve),
 * not a soft utilization target. Uses a progressive loop:
 *   Phase 1: Summarize tool results (archival → recent)
 *   Phase 2: Drop turns (chronological by default, or semantic when turnSelection provided)
 *   Stops as soon as the total is under the hard limit.
 *
 * @param {Array} messages - The messages[] array (mutated in place)
 * @param {object} options
 * @param {string} options.projectId
 * @param {string|null} options.model - Model identifier for computing output budget
 * @param {number} options.systemTokens - Token count of system prompt
 * @param {number} options.maxContextTokens - Model's context window size
 * @param {number} options.currentTurnIndex - Current turn number in session
 * @param {import("./semantic-turn-selector.mjs").TurnSelection} [options.turnSelection] - Pre-computed turn selection for semantic pruning
 * @returns {{ action: string, tokensSaved: number, details: string }}
 */
export function manageConversation(messages, options = {}) {
  const {
    projectId = "unknown",
    model = null,
    systemTokens = 0,
    maxContextTokens = 128000,
    currentTurnIndex = 0,
    turnSelection = null, // Optional: pre-computed TurnSelection for semantic pruning
    conversationId = null, // Optional: conversation-scoped key for turn summary storage
  } = options;

  // HARD limit: model's max minus what we need for output + tools + framing
  const hardLimit = maxContextTokens - getOutputReserve(model);
  // Soft trigger: start pruning when we exceed 50% of hard limit
  const triggerThreshold = Math.floor(hardLimit * 0.5);

  let totalTokens = computeTotalTokens(messages, systemTokens);

  // No pressure — nothing to do
  if (totalTokens <= triggerThreshold) {
    return { action: "none", tokensSaved: 0, details: "under 50% of hard limit", droppedTurns: [] };
  }

  // Detect turns
  let turns = detectTurns(messages);
  let totalSaved = 0;
  let actionsSummary = [];
  let iterations = 0;
  const MAX_ITERATIONS = 50; // Safety valve
  /** @type {Array<{ turnIndex: number, request: string, tools: string[], conclusion: string }>} */
  const droppedTurns = [];

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
        conversationId,
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

    // If still over limit after Phase 1, drop entire turns
    if (totalTokens > hardLimit) {
      // Refresh turn boundaries (they changed due to splicing)
      turns = detectTurns(messages);

      if (turnSelection && turnSelection.droppedTurnIndices?.length > 0) {
        // NEW PATH: semantic turn selection — drop least relevant turns first
        const result = dropIrrelevantTurns(messages, turns, turnSelection, projectId, conversationId);
        if (result.tokensSaved > 0) {
          totalSaved += result.tokensSaved;
          savedThisRound += result.tokensSaved;
          actionsSummary.push(`semantic drop: ${result.droppedTurns.length} turns (-${result.tokensSaved}t)`);
          droppedTurns.push(...result.droppedTurns);
          totalTokens = computeTotalTokens(messages, systemTokens);
        } else {
          actionsSummary.push("semantic drop gave no savings — falling back to chronological");
          // Fall through to chronological fallback
          turns = detectTurns(messages);
          const fallbackResult = dropOldestTurn(messages, turns, FRESH_DEPTH, projectId, conversationId);
          if (fallbackResult.tokensSaved > 0) {
            totalSaved += fallbackResult.tokensSaved;
            savedThisRound += fallbackResult.tokensSaved;
            actionsSummary.push(`dropped turn ${fallbackResult.droppedTurn?.turnIndex}: -${fallbackResult.tokensSaved}t (fallback)`);
            if (fallbackResult.droppedTurn) droppedTurns.push(fallbackResult.droppedTurn);
            totalTokens = computeTotalTokens(messages, systemTokens);
          } else {
            actionsSummary.push("no more turns to drop — giving up");
            break;
          }
        }
      } else {
        // CHRONOLOGICAL PATH: drop oldest turns (existing behavior)
        const result = dropOldestTurn(messages, turns, FRESH_DEPTH, projectId, conversationId);
        if (result.tokensSaved > 0) {
          totalSaved += result.tokensSaved;
          savedThisRound += result.tokensSaved;
          actionsSummary.push(`dropped turn ${result.droppedTurn?.turnIndex}: -${result.tokensSaved} tokens`);
          if (result.droppedTurn) {
            droppedTurns.push(result.droppedTurn);
          }
          totalTokens = computeTotalTokens(messages, systemTokens);
        } else {
          // Can't save any more — break to avoid infinite loop
          actionsSummary.push("no more turns to drop — giving up");
          break;
        }
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
    droppedTurns,
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
export function forcePruneToBudget(messages, maxTokens, projectId = "unknown", conversationId = null) {
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
        conversationId,
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
      const result = dropOldestTurn(messages, refreshedTurns, FRESH_DEPTH, projectId, conversationId);
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
