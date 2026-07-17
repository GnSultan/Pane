/**
 * Compact Worker — offloads context compaction from the main process.
 *
 * Runs in a worker_threads Worker so expensive synchronous operations
 * (forcePruneToBudget, applyV4TurnSelection, dropAllNonFreshTurns) don't
 * block the Electron main process event loop for 1-3 seconds.
 *
 * Protocol:
 *   Main → Worker: { type, messages, maxTokens?, projectId, turnSelection? }
 *   Worker → Main: { messages, tokensSaved, messagesRemaining?, action?, droppedTurns?, dropped?, summaries }
 *
 * Types:
 *   - "forcePruneToBudget":   messages, maxTokens, projectId
 *   - "applyV4TurnSelection": messages, turnSelection, projectId
 *   - "dropAllNonFreshTurns": messages, projectId, maxTokens?
 */

import { parentPort } from "node:worker_threads";
import {
  forcePruneToBudget,
  applyV4TurnSelection,
  dropAllNonFreshTurns,
} from "./conversation-lifecycle.mjs";
import { contextStore } from "./context-store.mjs";

if (!parentPort) throw new Error("compact-worker must be run as a Worker thread");

parentPort.on("message", (msg) => {
  try {
    const { type, messages, maxTokens, projectId, turnSelection } = msg;

    // The messages array is already a fresh deep copy from worker.postMessage's
    // structured clone serialization — no need to clone again.
    const msgs = messages;

    let result;

    switch (type) {
      case "forcePruneToBudget": {
        result = forcePruneToBudget(msgs, maxTokens, projectId);
        break;
      }
      case "applyV4TurnSelection": {
        result = applyV4TurnSelection(msgs, turnSelection, projectId);
        break;
      }
      case "dropAllNonFreshTurns": {
        result = dropAllNonFreshTurns(msgs, projectId, maxTokens ?? null);
        break;
      }
      default:
        throw new Error(`Unknown compaction type: ${type}`);
    }

    // Collect summaries that were stored in the worker's isolated
    // contextStore so the main thread can sync them.
    const summaries = contextStore.getTurnSummaries(projectId) || [];

    parentPort.postMessage({
      success: true,
      messages: msgs,
      summaries,
      ...result,
    });
  } catch (err) {
    parentPort.postMessage({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
