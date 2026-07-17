/**
 * Compaction Driver — manages a worker_threads Worker for context compaction.
 *
 * Uses a hybrid approach:
 *   - Fast path: runs compaction inline for conversations <200 messages
 *     (avoids structuredClone serialization overhead, which is ~10-50ms for
 *      a 50MB messages array)
 *   - Worker path: offloads to worker_threads for very large conversations
 *     where the synchronous work might still block the event loop
 *
 * Usage:
 *   import { compactMessages } from "./compaction-driver.mjs";
 *   const result = await compactMessages("forcePruneToBudget", {
 *     messages, maxTokens, projectId
 *   });
 *   // result.messages — mutated messages array
 *   // result.summaries — turn summaries to sync into main thread's contextStore
 */

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  forcePruneToBudget,
  applyV4TurnSelection,
  dropAllNonFreshTurns,
} from "./conversation-lifecycle.mjs";
import { contextStore } from "./context-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "compact-worker.mjs");

// Conversations with fewer messages than this run inline (fast path).
// 200 messages covers 99%+ of real conversations. The structuredClone
// serialization overhead (~10-50ms) exceeds the actual compaction time
// for conversations under this threshold.
const FAST_PATH_MAX_MESSAGES = 200;

let _worker = null;
let _requestId = 0;
const _pending = new Map();

/**
 * Start the compaction worker. Called once at application startup.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startCompactionWorker() {
  if (_worker) return;
  _worker = new Worker(WORKER_PATH);
  _worker.on("message", (msg) => {
    const { _id } = msg;
    const pending = _pending.get(_id);
    if (pending) {
      _pending.delete(_id);
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.resolve(msg);
    }
  });
  _worker.on("error", (err) => {
    console.error("[compaction-driver] Worker error:", err);
    for (const [, pending] of _pending) {
      pending.reject(err);
    }
    _pending.clear();
    _worker = null;
  });
  _worker.on("exit", (code) => {
    console.warn(`[compaction-driver] Worker exited (code ${code})`);
    for (const [, pending] of _pending) {
      pending.reject(new Error("compaction worker exited unexpectedly"));
    }
    _pending.clear();
    _worker = null;
  });
}

/**
 * Stop the compaction worker. Called at application shutdown.
 */
export function stopCompactionWorker() {
  if (!_worker) return;
  _worker.terminate();
  _worker = null;
  for (const [, pending] of _pending) {
    pending.reject(new Error("compaction worker terminated"));
  }
  _pending.clear();
}

/**
 * Run a compaction operation.
 *
 * Fast path (inline): for conversations with <200 messages, runs the
 * compaction function directly in the main thread. Avoids structuredClone
 * serialization of the messages array (the dominant cost for small convos).
 *
 * Worker path: for conversations with >=200 messages, offloads to the
 * worker thread to prevent event-loop blocking.
 *
 * @param {"forcePruneToBudget"|"applyV4TurnSelection"|"dropAllNonFreshTurns"} type
 * @param {object} params — { messages, maxTokens?, projectId, turnSelection? }
 * @returns {Promise<object>} — { messages, tokensSaved, messagesRemaining?, action?, droppedTurns?, dropped?, summaries }
 */
export function compactMessages(type, params) {
  const { messages } = params;

  // Fast path: run inline for small conversations.
  // The token cache + one-pass compaction makes this fast enough that
  // the structuredClone serialization to the worker is the dominant cost.
  if (messages && messages.length < FAST_PATH_MAX_MESSAGES) {
    return runInline(type, params);
  }

  // Worker path: offload to worker for large conversations
  return runOnWorker(type, params);
}

/**
 * Run compaction inline in the main thread.
 * Mutates messages in place and returns the result synchronously-wrapped
 * in a Promise for API compatibility with runOnWorker.
 *
 * @param {string} type
 * @param {object} params
 * @returns {Promise<object>}
 */
function runInline(type, params) {
  const { messages, maxTokens, projectId, turnSelection } = params;

  let result;

  switch (type) {
    case "forcePruneToBudget":
      result = forcePruneToBudget(messages, maxTokens, projectId);
      break;
    case "applyV4TurnSelection":
      result = applyV4TurnSelection(messages, turnSelection, projectId);
      break;
    case "dropAllNonFreshTurns":
      result = dropAllNonFreshTurns(messages, projectId, maxTokens ?? null);
      break;
    default:
      return Promise.reject(new Error(`Unknown compaction type: ${type}`));
  }

  // Collect summaries from the main thread's contextStore
  const summaries = contextStore.getTurnSummaries(projectId) || [];

  // The messages are already mutated in place — return the same reference
  // plus metadata (callers expect result.messages to be the mutated array)
  return Promise.resolve({
    success: true,
    messages,
    summaries,
    ...result,
  });
}

/**
 * Run compaction on the worker thread.
 * Falls back to this path for very large conversations.
 *
 * @param {string} type
 * @param {object} params
 * @returns {Promise<object>}
 */
function runOnWorker(type, params) {
  return new Promise((resolve, reject) => {
    if (!_worker) {
      startCompactionWorker();
    }

    const id = ++_requestId;

    // 60-second timeout — compaction can be slow for very large conversations
    // (200+ messages with 50+ tool results at 2-5MB each). Even with the
    // _tokenEstimate cache and skipped disk writes, Phase 1 summarization
    // + Phase 2 turn dropping + structuredClone round-trip can take 20-40s.
    const timeout = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        reject(new Error(`compaction worker timed out for ${type}`));
      }
    }, 60000);

    _pending.set(id, { resolve, reject, timeout });

    _worker.postMessage({
      _id: id,
      type,
      ...params,
    });
  }).then((result) => {
    if (!result.success) {
      throw new Error(result.error || "compaction worker returned failure");
    }
    return result;
  });
}

/**
 * Check if the compaction worker is healthy.
 */
export function isCompactionWorkerHealthy() {
  return _worker !== null && _worker.threadId > 0;
}
