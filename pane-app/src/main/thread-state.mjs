/**
 * thread-state.mjs — Per-project escalation state persistence
 *
 * Manages consecutive failure tracking, approach history, and prompt hashes
 * for the heuristic router. State lives in ~/.pane/session/{projectId}/thread.json
 * separate from session-context to avoid circular dependencies.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE_PATH = join(homedir(), '.pane', 'session');

/**
 * @typedef {Object} ThreadState
 * @property {number} consecutiveFailures - 0..N failure count
 * @property {number} escalationStage - 0-4, derived from consecutiveFailures
 * @property {string|null} lastFailureType - "user_explicit" | "near_duplicate" | "tool_error" | "score_low" | "incomplete" | null
 * @property {string[]} approachesTried - e.g. ["direct", "self_review", "explore_first"]
 * @property {string|null} lastResponseSummary - first 200 chars of last response
 * @property {number|null} lastUserPromptHash - djb2 hash
 * @property {string|null} lastUserPromptText - last prompt text, max 500 chars
 * @property {number|null} struggleStartedAt - timestamp when streak began
 * @property {"think"|"build"|"idle"} currentPhase - sticky phase for this project
 */

/** @returns {ThreadState} */
function defaults() {
  return {
    consecutiveFailures: 0,
    escalationStage: 0,
    lastFailureType: null,
    approachesTried: [],
    lastResponseSummary: null,
    lastUserPromptHash: null,
    lastUserPromptText: null,
    struggleStartedAt: null,
    // Phase system
    currentPhase: 'idle',
  };
}

/**
 * Returns the file path for a project's thread state.
 * @param {string} projectId
 * @returns {string}
 */
function threadPath(projectId) {
  return join(BASE_PATH, projectId, 'thread.json');
}

/**
 * Derive escalation stage from consecutive failure count.
 * 0 failures → stage 0, 1 → 1, 2 → 2, 3 → 3, 4+ → 4 (capped).
 * @param {number} n - consecutive failure count
 * @returns {number} stage 0-4
 */
export function stageFromCount(n) {
  return Math.min(Math.max(0, n), 4);
}

/**
 * Read the thread state for a project.
 * Returns defaults if the file doesn't exist or contains invalid JSON.
 * @param {string} projectId
 * @returns {ThreadState}
 */
export function readThreadState(projectId) {
  const filePath = threadPath(projectId);

  if (!existsSync(filePath)) {
    return defaults();
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so missing keys get filled in
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

/**
 * Write full thread state to disk.
 * Creates the directory tree if it doesn't exist.
 * @param {string} projectId
 * @param {ThreadState} state
 */
export function writeThreadState(projectId, state) {
  const filePath = threadPath(projectId);
  const dir = join(BASE_PATH, projectId);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[thread-state] failed to write ${filePath}:`, err.message);
  }
}

/**
 * Increment the failure counter and update escalation stage.
 * Sets struggleStartedAt on the first failure in a streak.
 * @param {string} projectId
 * @param {string} failureType - "user_explicit" | "near_duplicate" | "tool_error" | "score_low" | "incomplete"
 * @returns {ThreadState} updated state
 */
export function incrementFailure(projectId, failureType) {
  const state = readThreadState(projectId);

  state.consecutiveFailures += 1;
  state.lastFailureType = failureType;
  state.escalationStage = stageFromCount(state.consecutiveFailures);

  // Mark when the struggle streak began
  if (state.struggleStartedAt === null) {
    state.struggleStartedAt = Date.now();
  }

  writeThreadState(projectId, state);
  return state;
}

/**
 * Record a successful outcome — resets the entire failure streak.
 * @param {string} projectId
 * @returns {ThreadState} updated (clean) state
 */
export function recordSuccess(projectId) {
  const state = readThreadState(projectId);

  state.consecutiveFailures = 0;
  state.escalationStage = 0;
  state.lastFailureType = null;
  state.approachesTried = [];
  state.struggleStartedAt = null;

  writeThreadState(projectId, state);
  return state;
}

/**
 * Add an approach to the tried list (deduped).
 * @param {string} projectId
 * @param {string} approach - e.g. "direct", "self_review", "explore_first"
 */
export function recordApproach(projectId, approach) {
  const state = readThreadState(projectId);

  if (!state.approachesTried.includes(approach)) {
    state.approachesTried.push(approach);
  }

  writeThreadState(projectId, state);
}

/**
 * Store the latest user prompt text and its djb2 hash for Jaccard comparison.
 * Prompt text is capped at 500 characters.
 * @param {string} projectId
 * @param {string} promptText
 * @param {number} promptHash - djb2 hash of the prompt
 */
export function updateLastPrompt(projectId, promptText, promptHash) {
  const state = readThreadState(projectId);

  state.lastUserPromptHash = promptHash;
  state.lastUserPromptText = promptText ? promptText.slice(0, 500) : null;

  writeThreadState(projectId, state);
}

/**
 * Store a summary of the last assistant response.
 * Capped at 200 characters.
 * @param {string} projectId
 * @param {string} responseSummary
 */
export function updateLastResponse(projectId, responseSummary) {
  const state = readThreadState(projectId);

  state.lastResponseSummary = responseSummary ? responseSummary.slice(0, 200) : null;

  writeThreadState(projectId, state);
}

// ── Phase system helpers ──────────────────────────────────────────────────────

/**
 * Update the sticky phase for a project.
 * @param {string} projectId
 * @param {"think"|"build"|"verify"|"idle"} phase
 * @returns {ThreadState} updated state
 */
export function updatePhase(projectId, phase) {
  const state = readThreadState(projectId);
  state.currentPhase = phase;
  writeThreadState(projectId, state);
  return state;
}

