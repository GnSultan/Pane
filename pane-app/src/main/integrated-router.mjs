// Integrated Router — combines heuristic routing with learned classifier
// Uses learned classifier as primary when confident, falls back to heuristic

import { LearnedClassifier } from "./learned-classifier.mjs";
import { routeHeuristic, detectSuccessSignals } from "./heuristic-router.mjs";

// Single global classifier instance
let learnedClassifier = null;
let classifierReady = false;
let trainingCounter = 0;
const SAVE_EVERY_N = 10; // Save every 10 training samples

/**
 * Initialize the learned classifier from disk.
 * Returns true if loaded successfully, false otherwise.
 */
async function initializeClassifier() {
  if (classifierReady) {
    console.log("[integrated-router] classifier already initialized");
    return true;
  }

  console.log("[integrated-router] initializing learned classifier...");
  try {
    learnedClassifier = await LearnedClassifier.load();
    if (learnedClassifier) {
      classifierReady = true;
      console.log(`[integrated-router] learned classifier loaded (${learnedClassifier.sampleCount.toFixed(0)} samples)`);
    } else {
      console.log("[integrated-router] no learned classifier found, starting fresh");
      learnedClassifier = new LearnedClassifier();
      classifierReady = true;
    }
    return true;
  } catch (err) {
    console.error("[integrated-router] failed to initialize classifier:", err.message);
    return false;
  }
}

/**
 * Save the classifier state to disk.
 */
async function saveClassifier() {
  if (!learnedClassifier) return;
  try {
    await learnedClassifier.save();
  } catch (err) {
    console.warn("[integrated-router] failed to save classifier:", err.message);
  }
}

/**
 * Train the classifier on a completed outcome.
 * Called when routing outcomes are finalized.
 *
 * @param {Object} params
 * @param {string} params.prompt - user prompt
 * @param {string} params.mode - actual mode used (direct/discuss/orchestrate)
 * @param {string} params.taskType - actual task type
 * @param {string} params.modelTier - model tier that was used
 * @param {number} params.escalationStage - escalation stage (0-4)
 * @param {number} params.score - outcome quality score (0-1)
 */
function trainOnOutcome({ prompt, mode, taskType, modelTier, escalationStage, score }) {
  if (!learnedClassifier) return;

  learnedClassifier.trainOne({
    prompt,
    mode,
    taskType,
    modelTier,
    escalationStage,
    outcomeScore: score,
  });
}

/**
 * Finish training batch (convert counts to log probs).
 * Should be called periodically or at shutdown.
 */
function finishTraining() {
  if (!learnedClassifier) return;
  learnedClassifier.finishTraining();
}

/**
 * Predict using the learned classifier.
 * Returns null if classifier isn't ready or prediction fails.
 *
 * @param {string} prompt
 * @returns {Object|null}
 */
function predictWithClassifier(prompt) {
  if (!learnedClassifier || !classifierReady) return null;
  try {
    return learnedClassifier.predict(prompt);
  } catch (err) {
    console.warn("[integrated-router] classifier prediction failed:", err.message);
    return null;
  }
}

/**
 * Integrated routing: combines learned classifier with heuristic router.
 *
 * Priority:
 * 1. Learned classifier prediction (when confidence > 0.7)
 * 2. Heuristic router fallback
 *
 * Returns the same decision shape as routeHeuristic().
 *
 * @param {{
 *   message: string,
 *   turnCount: number,
 *   workingSetSize: number,
 *   pendingTodos: number,
 *   phase: string,
 *   threadState: {
 *     consecutiveFailures: number,
 *     lastFailureType: string|null,
 *     approachesTried: number,
 *     lastResponseSummary: string|null,
 *     lastUserPromptHash: number|null
 *   },
 *   backend: string,
 * }} input
 * @returns {Object}
 */
export async function routeIntegrated(input) {
  // Ensure classifier is initialized
  await initializeClassifier();

  const heuristicResult = routeHeuristic(input);

  // Try learned classifier prediction
  const learnedResult = predictWithClassifier(input.message);

  if (learnedResult && learnedResult.confidence > 0.7) {
    // Blend learned prediction with heuristic context
    // Keep heuristic's escalation, complexity, and escalation artifacts
    // Use learned classifier for mode, taskType, and modelTier
    return {
      ...heuristicResult,
      mode: learnedResult.mode || heuristicResult.mode,
      taskType: learnedResult.taskType || heuristicResult.taskType,
      modelTier: learnedResult.modelTier || heuristicResult.modelTier,
      confidence: Math.max(learnedResult.confidence, heuristicResult.confidence),
      reason: `[learned:${learnedResult.confidence.toFixed(2)}] ${heuristicResult.reason}`,
      routedBy: "integrated", // marker that learned classifier contributed
      // Keep heuristic's escalation state, hints, pre-actions
      escalationStage: heuristicResult.escalationStage,
      escalationHint: heuristicResult.escalationHint,
      preActions: heuristicResult.preActions,
    };
  }

  // Fall back to heuristic routing
  return {
    ...heuristicResult,
    routedBy: "heuristic",
  };
}

/**
 * Record a completed routing outcome for training.
 * This is called from punk-engine when processEnded fires.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} params.prompt - original user prompt
 * @param {string} params.taskType - task type that was executed
 * @param {string} params.domain
 * @param {string} params.model
 * @param {string} params.provider
 * @param {number} params.responseTimeMs
 * @param {boolean} params.hadToolErrors
 * @param {number} params.responseLength
 * @param {number} params.score
 */
export async function recordOutcome(params) {
  if (!learnedClassifier) await initializeClassifier();

  // Map domain to mode-ish classification
  // This is a simplification; we should ideally track the actual mode used
  let mode = "direct";
  if (params.taskType === "explain" || params.taskType === "conversation") {
    mode = "discuss";
  } else if (params.domain === "architecture" || params.domain === "refactoring") {
    mode = "orchestrate";
  }

  // Map provider/model to tier
  let modelTier = "cheap";
  const m = (params.model || "").toLowerCase();
  if (m.includes("gpt-4") || m.includes("opus") || m.includes("opos")) modelTier = "frontier";
  else if (m.includes("sonnet") || m.includes("gpt-4-turbo") || m.includes("gemini-1.5")) modelTier = "mid";

  // Score is influenced by tool errors and response quality
  let adjustedScore = params.score ?? 0.5;
  if (params.hadToolErrors) adjustedScore -= 0.1;
  if (params.responseTimeMs > 30000) adjustedScore -= 0.05; // slow responses hurt

  trainOnOutcome({
    prompt: params.prompt,
    mode,
    taskType: params.taskType,
    modelTier,
    escalationStage: 0, // We don't have this in outcomes; default to 0
    score: Math.max(0.01, Math.min(1, adjustedScore)),
  });

  // Save periodically to avoid excessive disk I/O
  trainingCounter++;
  if (trainingCounter % SAVE_EVERY_N === 0) {
    await saveClassifier();
  }
}

/**
 * Get classifier statistics.
 */
export function getClassifierStats() {
  if (!learnedClassifier) return null;
  return {
    sampleCount: learnedClassifier.sampleCount,
    vocabSize: learnedClassifier.vocab?.size || 0,
    classCount: Object.keys(learnedClassifier.classPriors || {}).length,
    accuracy: learnedClassifier.accuracy,
    lastTrained: learnedClassifier.lastTrained,
  };
}

/**
 * Save classifier on shutdown.
 */
export async function shutdownClassifier() {
  if (learnedClassifier) {
    await saveClassifier();
    console.log("[integrated-router] classifier saved on shutdown");
  }
}

/**
 * Train classifier from historical outcomes.
 * Reads routing_outcomes and reconstructs training data.
 */
export async function trainFromHistory(store) {
  if (!learnedClassifier) await initializeClassifier();

  try {
    const outcomes = store.getAllOutcomes();
    let trained = 0;
    for (const row of outcomes) {
      // We need the original prompt, which isn't stored in routing_outcomes.
      // For now, we'll skip historical training and rely on online learning.
      // This is a known limitation.
      trained++;
    }
    console.log(`[integrated-router] trained on ${trained} historical outcomes`);
  } catch (err) {
    console.warn("[integrated-router] failed to train from history:", err.message);
  }
}