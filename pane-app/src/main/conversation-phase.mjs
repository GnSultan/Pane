/**
 * Conversation Phase Detection — determines where in a work cycle the
 * conversation is, and filters system atoms accordingly.
 *
 * Today the same method atoms (ORIENT, SCOPE, UNDERSTAND, PLAN, EXECUTE,
 * VERIFY, RECORD) fire every turn regardless of context. On turn 8 of a
 * debug session, ORIENT and SCOPE waste ~200 tokens on instructions the
 * model already followed on turn 1.
 *
 * This module detects the conversation phase and strips irrelevant atoms,
 * saving 200-400 tokens per turn in mid-work and closing phases.
 */

/**
 * Detect the current conversation phase from session signals.
 *
 * @param {object} signals
 * @param {number} signals.turnCount - Current conversation turn
 * @param {string[]} signals.lastToolActions - Tool names from recent actions (e.g. ["read_file", "write_file"])
 * @param {string} signals.taskType - Current task type from router
 * @param {string} signals.mode - Current routing mode
 * @param {number} signals.pendingTodos - Count of incomplete todos
 * @param {number} signals.completedTodos - Count of completed todos
 * @param {boolean} signals.hasNewFiles - Whether working set changed since last turn
 * @returns {"opening"|"mid-work"|"review"|"pivot"|"closing"}
 */
export function detectPhase(signals) {
  const {
    turnCount = 0,
    lastToolActions = [],
    taskType = "other",
    mode = "direct",
    pendingTodos = 0,
    completedTodos = 0,
    hasNewFiles = false,
  } = signals;

  // Pivot: working set changed mid-conversation — needs re-orientation
  if (hasNewFiles && turnCount > 3) {
    return "pivot";
  }

  // Opening: first turns or fresh scope
  if (turnCount < 2) {
    return "opening";
  }

  // Closing: more done than remaining
  if (completedTodos > pendingTodos && completedTodos > 0 && turnCount > 4) {
    return "closing";
  }

  // Review: explicit review task, or last actions were all read-only
  if (taskType === "review") {
    return "review";
  }
  if (lastToolActions.length >= 2) {
    const readOnlyTools = new Set(["read_file", "glob", "grep_search", "search", "list_directory", "pane_recall", "pane_find_symbol", "pane_codebase_compass"]);
    const allReadOnly = lastToolActions.every(t => readOnlyTools.has(t));
    if (allReadOnly) {
      return "review";
    }
  }

  // Mid-work: actively executing
  if (pendingTodos > 0 && (mode === "direct" || mode === "orchestrate" || mode === "execute")) {
    return "mid-work";
  }

  // Default: treat as mid-work if past opening
  if (turnCount >= 2) {
    return "mid-work";
  }

  return "opening";
}

/**
 * Filter method atoms based on conversation phase.
 * Atoms are identified by their `id` field (e.g. "method-orient", "method-execute").
 *
 * @param {string} phase - Current conversation phase
 * @param {Array<{id: string, [key: string]: any}>} atoms - Method atoms from system-atoms.mjs
 * @returns {Array<{id: string, [key: string]: any}>} Filtered atoms
 */
export function filterAtomsForPhase(phase, atoms) {
  if (!atoms || atoms.length === 0) return atoms;

  switch (phase) {
    case "opening":
      // Full method atoms — model needs orientation
      return atoms;

    case "mid-work":
      // Drop ORIENT and SCOPE — already established. Keep EXECUTE, VERIFY, RECORD.
      return atoms.filter(a => {
        const id = a.id || a.name || "";
        return !id.includes("orient") && !id.includes("scope");
      });

    case "review":
      // Keep ORIENT (for re-reading), VERIFY, RECORD. Drop EXECUTE, PLAN.
      return atoms.filter(a => {
        const id = a.id || a.name || "";
        return !id.includes("execute") && !id.includes("plan");
      });

    case "pivot":
      // Re-include ORIENT and SCOPE (need re-orientation). Keep everything.
      return atoms;

    case "closing":
      // Only VERIFY and RECORD — wrapping up.
      return atoms.filter(a => {
        const id = a.id || a.name || "";
        return id.includes("verify") || id.includes("record") || id.includes("identity");
      });

    default:
      return atoms;
  }
}
