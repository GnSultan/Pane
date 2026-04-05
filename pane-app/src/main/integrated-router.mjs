// Integrated Router — thin wrapper around heuristic routing + outcome recording.
//
// The learned classifier (Naive Bayes) and LLM classifier were removed:
// - LearnedClassifier was undertrained (near-zero vocabulary on cold start)
// - LLM classifier was dead code (imported but never called)
// - Both could disagree with the heuristic, causing inconsistent system prompts
//
// The mode pill on the renderer is now the single classification authority.
// The heuristic router is demoted to "pill auto-detect helper" — it suggests
// the initial pill value via previewRoute(), not per-message routing.

import { routeHeuristic } from "./heuristic-router.mjs";

/**
 * Route a message. Now just calls routeHeuristic directly.
 * Kept as a named export so callers (punk-engine, previewRoute) don't need changes.
 */
export async function routeIntegrated(input) {
  return {
    ...routeHeuristic(input),
    routedBy: "heuristic",
  };
}

/**
 * Record a completed routing outcome.
 * Kept for punk-engine's outcome tracking (feeds routing-store).
 * No longer trains a classifier — just a pass-through for future analytics.
 */
export async function recordOutcome(params) {
  // Outcome data is still recorded in routing-store.mjs via punk-engine.
  // This function existed to train the learned classifier, which is removed.
  // Keep the export so punk-engine doesn't break.
}

/** Stats — returns empty now that the learned classifier is removed. */
export function getClassifierStats() {
  return { sampleCount: 0, vocabSize: 0, classCount: 0, accuracy: null, lastTrained: null };
}

/** Shutdown — no-op now. */
export async function shutdownClassifier() {}
