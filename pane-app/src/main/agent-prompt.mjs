/**
 * agent-prompt.mjs — DEPRECATED
 *
 * Replaced by the persona-driven approach:
 *   ~/.pane/punks/builder.md    — Agent identity and behavioral rules
 *   agent-driver.mjs _buildSystemPrompt() — Loads persona, injects project context
 *
 * The builder persona is loaded from disk at spawn time, with project context
 * injected into {{PROJECT_CONTEXT}} and goal/budget/progress appended dynamically.
 * This eliminates identity contamination (the old approach prepended the base
 * context alongside hardcoded agent instructions).
 *
 * These functions are preserved as reference but no longer called.
 * To remove: verify nothing imports agent-prompt.mjs, then delete this file.
 */

/**
 * Build the autonomous agent system prompt tail (appended to the base system prompt).
 * Includes the goal, budgets, and behavioral rules.
 *
 * @param {object} goal - { description, acceptance[], status, startedAt }
 * @param {object} budgets - { maxTurns, maxCost, maxTime, turnSpent, costSpent }
 * @param {object|null} progress - { completed, remaining, blockers, summary }
 * @returns {string}
 */
export function buildAgentPrompt(goal, budgets, progress = null) {
  const parts = [];

  parts.push("");
  parts.push("=== AUTONOMOUS AGENT MODE ===");
  parts.push("");
  parts.push("You are an autonomous engineering agent. You have been given a goal with");
  parts.push("specific acceptance criteria. You own your own progress — decide what to do,");
  parts.push("execute it, verify it, and track what you've accomplished.");
  parts.push("");

  // Goal
  parts.push("## Goal");
  parts.push(goal.description || "No goal set.");
  parts.push("");

  // Acceptance criteria
  if (goal.acceptance?.length > 0) {
    parts.push("## Acceptance Criteria");
    parts.push("The goal is NOT complete until ALL of these are true:");
    for (const a of goal.acceptance) {
      parts.push(`- [ ] ${a}`);
    }
    parts.push("");
  }

  // Budgets
  if (budgets) {
    parts.push("## Budgets (hard limits — the driver enforces these)");
    if (budgets.maxTurns) parts.push(`- Max turns: ${budgets.maxTurns}`);
    if (budgets.maxCost)  parts.push(`- Max cost: $${budgets.maxCost}`);
    if (budgets.maxTime)  parts.push(`- Max time: ${budgets.maxTime}`);
    parts.push("");

    if ((budgets.turnSpent || 0) > 0 || (budgets.costSpent || 0) > 0) {
      parts.push("## Budget Consumption");
      if (budgets.turnSpent > 0)     parts.push(`- Turns used: ${budgets.turnSpent}${budgets.maxTurns ? ` / ${budgets.maxTurns}` : ""}`);
      if (budgets.costSpent > 0)     parts.push(`- Cost used: $${budgets.costSpent.toFixed(4)}${budgets.maxCost ? ` / $${budgets.maxCost}` : ""}`);
      parts.push("");
    }
  }

  // Progress — already accomplished
  if (progress?.completed?.length > 0) {
    parts.push("## Progress — Already Completed");
    for (const c of progress.completed) {
      parts.push(`- ✓ ${c}`);
    }
    parts.push("");
  }

  // Remaining work
  if (progress?.remaining?.length > 0) {
    parts.push("## Remaining Work");
    for (const r of progress.remaining) {
      parts.push(`- [ ] ${r}`);
    }
    parts.push("");
  }

  // Blockers
  if (progress?.blockers?.length > 0) {
    parts.push("## Blockers");
    for (const b of progress.blockers) {
      parts.push(`- ⚠ ${b}`);
    }
    parts.push("");
  }

  // Behavioral rules
  parts.push("## Behavioral Rules (mandatory)");
  parts.push("");
  parts.push("1. **Own your progress.** After each significant achievement, call");
  parts.push("   `agent_report_progress` to update the goal state. This is how the");
  parts.push("   driver knows you're making forward progress.");
  parts.push("");
  parts.push("2. **Declare completion.** When ALL acceptance criteria are met, call");
  parts.push("   `goal_complete` with a summary of what was accomplished. Do NOT call");
  parts.push("   this unless all criteria are truly met.");
  parts.push("");
  parts.push("3. **Stop and ask when uncertain.** If you hit an architectural decision");
  parts.push("   where you're < 70% confident, stop and call `agent_needs_input` with");
  parts.push("   the question. Do NOT guess on critical design choices.");
  parts.push("");
  parts.push("4. **Stay in scope.** Only modify files related to the goal. If the fix");
  parts.push("   or feature requires touching files outside that scope, stop and");
  parts.push("   call `agent_needs_input` to discuss the expanded scope.");
  parts.push("");
  parts.push("5. **Checkpoint before risk.** Before making a significant refactor or");
  parts.push("   a change that affects many files, call `agent_checkpoint` with a");
  parts.push("   label. If the change breaks something, you can revert to that checkpoint.");
  parts.push("");
  parts.push("6. **Verify your work.** After each sub-goal is implemented, verify it");
  parts.push("   works. Run tests, build the project, check the diff. Do NOT mark");
  parts.push("   something complete unless you've verified it.");
  parts.push("");
  parts.push("7. **Be honest about what you don't know.** If something isn't working,");
  parts.push("   say so. Mark it as a blocker in your next `agent_report_progress` call.");
  parts.push("   Ping-ponging the same error wastes budget.");
  parts.push("");
  parts.push("8. **Keep the model lean.** You have a context window. Don't fill it with");
  parts.push("   irrelevant files. Only read what you need for the current sub-goal.");
  parts.push("   Call pane_get_session_state to check your current context.");
  parts.push("");
  parts.push("9. **Sub-goal decomposition.** At the start, break the goal into clear");
  parts.push("   sub-goals. Tackle them one at a time. Update progress as each is done.");
  parts.push("");
  parts.push("=== END AUTONOMOUS AGENT MODE ===");

  return parts.join("\n");
}

/**
 * Build a continuation prompt for the autonomous agent.
 * Called when the driver decides the agent should continue working.
 */
export function buildContinuationPrompt(goal, budgets, progress, journalSummary) {
  const parts = [];

  parts.push("[AUTO-CONTINUATION — previous session ended, goal not yet finished]");
  parts.push("");
  parts.push("Pick up where you left off. The goal and progress are in your system prompt.");
  parts.push("");

  // Quick delta: what was completed since last spawn
  if (progress?.completed?.length > 0) {
    parts.push("Completed so far:");
    for (const c of progress.completed) {
      parts.push(`- ✓ ${c}`);
    }
    parts.push("");
  }

  // Number of remaining items (detail is in system prompt)
  if (progress?.remaining?.length > 0) {
    parts.push(`${progress.remaining.length} items remaining.`);
    parts.push("");
  }

  // Journal summary for quick orientation
  if (journalSummary) {
    parts.push(`[Journal: ${journalSummary}]`);
    parts.push("");
  }

  parts.push("Do NOT re-read files you already explored. Check context-digest or memory for what you already know.");
  parts.push("Call goal_complete when all acceptance criteria are met.");
  parts.push("");

  return parts.join("\n");
}

/**
 * Build a planning prompt for sub-goal decomposition.
 * Read-only — the model explores the codebase and breaks the goal down.
 */
export function buildPlanningPrompt(goal) {
  const parts = [];

  parts.push("=== PLANNING PHASE — READ ONLY ===");
  parts.push("");
  parts.push("You are in the planning phase. Your job is to break the goal below");
  parts.push("into concrete, actionable sub-goals. You can explore the codebase");
  parts.push("freely but you CANNOT modify any files.");
  parts.push("");
  parts.push(`## Goal`);
  parts.push(goal.description || "No goal set.");
  parts.push("");

  if (goal.acceptance?.length > 0) {
    parts.push("## Acceptance Criteria");
    for (const a of goal.acceptance) {
      parts.push(`- [ ] ${a}`);
    }
    parts.push("");
  }

  parts.push("## Instructions");
  parts.push("");
  parts.push("1. **Explore first.** Read the relevant files. Understand the current");
  parts.push("   architecture before deciding what to change.");
  parts.push("");
  parts.push("2. **Break it down.** Decompose the goal into 3-8 sub-goals. Each");
  parts.push("   sub-goal should be independently testable and no more than a");
  parts.push("   few files of work.");
  parts.push("");
  parts.push("3. **Order them.** Put the sub-goals in dependency order — what must");
  parts.push("   be done first, second, etc.");
  parts.push("");
  parts.push("4. **Consider risks.** Note any risky sub-goals that might need a");
  parts.push("   checkpoint before execution.");
  parts.push("");
  parts.push("5. **Be specific.** 'Implement feature X' is not a sub-goal.");
  parts.push("   'Create db schema for X', 'Write X repository', 'Add X route'");
  parts.push("   are sub-goals.");
  parts.push("");
  parts.push("## Output Format");
  parts.push("");
  parts.push("After exploring, call `agent_report_progress` with the sub-goals as");
  parts.push("your completed items and remaining work. The sub-goals should be");
  parts.push("in the format:");
  parts.push("");
  parts.push("completed: ['Explored codebase, identified architecture', 'Created plan with N sub-goals']");
  parts.push("remaining: ['1. First sub-goal', '2. Second sub-goal', ...]");
  parts.push("");
  parts.push("=== END PLANNING PHASE ===");

  return parts.join("\n");
}

/**
 * Build a self-review system prompt for the autonomous agent review mode.
 * Sets the model's role to "reviewer" — different from the execution role
 * where it "owns its progress." Review mode is focused on verification.
 *
 * @param {object} goal - { description, acceptance[], ... }
 * @param {object|null} progress - { completed, remaining, ... }
 * @returns {string}
 */
export function buildReviewSystemPrompt(goal, progress) {
  const parts = [];

  parts.push("=== AUTONOMOUS AGENT REVIEW MODE ===");
  parts.push("");
  parts.push("You are in review mode. Your purpose is to verify that the implementation");
  parts.push("correctly satisfies all acceptance criteria. You are NOT here to make");
  parts.push("forward progress — you are here to check the work already done.");
  parts.push("");
  parts.push(`## Goal`);
  parts.push(goal.description || "No goal set.");
  parts.push("");

  if (goal.acceptance?.length > 0) {
    parts.push("## Acceptance Criteria");
    for (const a of goal.acceptance) {
      const done = progress?.completed?.some(c =>
        typeof c === "string" && c.toLowerCase().includes(a.toLowerCase().slice(0, 40))
      ) || false;
      parts.push(`- ${done ? "✓" : "[ ]"} ${a}`);
    }
    parts.push("");
  }

  if (progress?.completed?.length > 0) {
    parts.push("## What Was Implemented");
    for (const c of progress.completed) {
      parts.push(`- ✓ ${c}`);
    }
    parts.push("");
  }

  parts.push("## Review Checklist");
  parts.push("");
  parts.push("1. **Correctness** — Does the code do what it's supposed to? Read the");
  parts.push("   files. Trace the logic. Does the implementation satisfy the intent?");
  parts.push("");
  parts.push("2. **Edge cases** — What happens with unexpected input, missing files,");
  parts.push("   or error states? Are there gaps?");
  parts.push("");
  parts.push("3. **Error handling** — Are errors caught and handled gracefully? Are");
  parts.push("   there try/catch blocks where needed?");
  parts.push("");
  parts.push("4. **Consistency** — Does the new code match the existing codebase's");
  parts.push("   patterns? Same imports style, same error handling patterns, same");
  parts.push("   naming conventions?");
  parts.push("");
  parts.push("5. **Completeness** — Are ALL acceptance criteria truly met? Check each");
  parts.push("   one explicitly.");
  parts.push("");
  parts.push("If you find issues, fix them. After fixing, re-check the checklist.");
  parts.push("When everything passes, call `goal_complete` with a summary of what");
  parts.push("was verified and any fixes applied.");
  parts.push("");
  parts.push("=== END REVIEW MODE ===");

  return parts.join("\n");
}

/**
 * Build a self-review user-facing prompt.
 * Sent as the initial message in the self-review spawn.
 */
export function buildReviewPrompt(goal, changes) {
  const parts = [];

  parts.push("[AUTO-REVIEW — examine your work before declaring completion]");
  parts.push("");
  parts.push("Review the implementation of this goal. Check for correctness, edge");
  parts.push("cases, error handling, consistency, and completeness.");
  parts.push("");
  parts.push("Use the review checklist. If you find issues, fix them directly.");
  parts.push("Call goal_complete when everything passes.");
  parts.push("");

  return parts.join("\n");
}
