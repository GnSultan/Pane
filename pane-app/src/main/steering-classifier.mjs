/**
 * Steering classifier — decides whether a message sent while a task is
 * already running is a correction/refinement for THAT task (steer it in at
 * the next turn boundary) or an unrelated new topic (queue it for after).
 *
 * Deliberately separate from heuristic-router.mjs: that module classifies a
 * message in isolation (intent/complexity/escalation between independent
 * turns). This answers a different question — "is this about the task that
 * is currently running" — so it gets its own small module, the same way
 * code-arbiter.mjs keeps its correction detection separate from the router.
 *
 * Pure, local, zero-network — an ordered rule cascade rather than a scored
 * model, mirroring detectFailureSignals/detectSuccessSignals's style.
 * Defaults to "queue" on any ambiguity: steering something unrelated into a
 * running task corrupts its context, which is a much worse failure mode
 * than making the user wait a bit longer for an unrelated message.
 */

import { FAILURE_PATTERNS, jaccardSimilarity } from "./heuristic-router.mjs";
import { isUserCorrection } from "./code-arbiter.mjs";

// Explicit "this is a different thing" signals — override everything else,
// even if the message happens to share vocabulary with the running task.
const NEW_TOPIC_PATTERNS = [
  /\bnow (let'?s|can you|could you|I want)\b/i, // moving on to new topic
  /\b(separate|unrelated|different|new) (question|topic|issue|task)\b/i,
  /^(also|by the way|btw)[,:]?\s/i,
];

const JACCARD_STEER_THRESHOLD = 0.2;

/**
 * @param {string} message - the incoming message sent while a task is running
 * @param {string} anchorPrompt - the original prompt that started the running task
 * @returns {{ decision: "steer" | "queue", reason: string }}
 */
export function classifySteerIntent(message, anchorPrompt) {
  const trimmed = (message || "").trim();
  if (!trimmed) return { decision: "queue", reason: "empty" };

  for (const pat of NEW_TOPIC_PATTERNS) {
    if (pat.test(trimmed)) {
      return { decision: "queue", reason: "explicit-new-topic" };
    }
  }

  if (isUserCorrection(trimmed)) {
    return { decision: "steer", reason: "correction-negation" };
  }
  for (const pat of FAILURE_PATTERNS) {
    if (pat.test(trimmed)) {
      return { decision: "steer", reason: "failure-signal" };
    }
  }

  if (anchorPrompt) {
    const similarity = jaccardSimilarity(trimmed, anchorPrompt);
    if (similarity > JACCARD_STEER_THRESHOLD) {
      return { decision: "steer", reason: `jaccard:${similarity.toFixed(2)}` };
    }
  }

  return { decision: "queue", reason: "default" };
}
