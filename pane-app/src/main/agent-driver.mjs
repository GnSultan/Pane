/**
 * agent-driver.mjs — Autonomous Agent Driver
 *
 * Sits above the backend spawn() loop. Manages the high-level goal lifecycle:
 *   - Goal specification and persistence
 *   - Budget enforcement (turns, cost, wall clock)
 *   - Continuation decisions (continue / pause / complete)
 *   - Sub-goal decomposition (planning spawn before execution)
 *   - Stall detection (repeated files, no progress, error loops)
 *   - Self-review (verification spawn after implementation)
 *   - Cross-session learning (outcome indexing → brain)
 *   - Multi-model orchestration (plan model ≠ build model)
 *
 * The driver calls backend.spawn() in a loop. Each spawn() is a single
 * session with its own turn loop. The driver decides what comes next
 * based on session state after each spawn completes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readState, mergeState } from "./pane-system-prompt.mjs";
import { readLastProgress } from "./session-journal.mjs";

// ---------------------------------------------------------------------------
// Goal schema
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AgentGoal
 * @property {string} description - What the agent should accomplish
 * @property {string[]} acceptance - Acceptance criteria (list of statements)
 * @property {string[]} [subgoals] - Planned sub-goals (set by model during planning)
 * @property {'pending'|'planning'|'in_progress'|'paused'|'completed'|'failed'} status
 * @property {number} startedAt - Unix timestamp when the goal was set
 * @property {number} [completedAt] - Unix timestamp when the goal was completed
 * @property {string} [sessionSummary] - Summary of what was accomplished
 * @property {string} [planModel] - Model used for planning (Phase 3)
 * @property {string} [buildModel] - Model used for execution (Phase 3)
 * @property {string} [reviewModel] - Model used for review (Phase 3)
 */

/**
 * @typedef {Object} AgentBudgets
 * @property {number} [maxTurns] - Maximum turns for this goal
 * @property {number} [maxCost] - Maximum cost in USD
 * @property {number} [maxTime] - Maximum wall clock time in milliseconds
 * @property {number} turnSpent - Turns consumed so far
 * @property {number} costSpent - Cost consumed so far
 * @property {number} startTime - When budgets started tracking
 */

/**
 * @typedef {Object} AgentProgress
 * @property {string[]} completed - Things accomplished
 * @property {string[]} remaining - Remaining work
 * @property {string[]} blockers - Blockers encountered
 * @property {string} [summary] - Brief status summary
 */

/**
 * @typedef {Object} AgentResult
 * @property {'completed'|'paused'|'failed'|'interrupted'} status
 * @property {string} [summary] - Summary of what happened
 * @property {string} [reason] - Why the agent stopped
 * @property {AgentProgress} [progress] - Final progress state
 * @property {AgentBudgets} [budgets] - Final budget state
 * @property {AgentGoal} [goal] - Goal reference
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SPAWNS = 20;
const DEFAULT_MAX_TURNS = 500;
const STALL_NO_PROGRESS_THRESHOLD = 3; // Spawns with no new accomplishments
const STALL_FILE_PING_PONG_WINDOW = 10; // Check last N actions for ping-pong
const STALL_FILE_PING_PONG_THRESHOLD = 3; // Same file touched this many times = ping-pong
const STALL_ERROR_WINDOW = 10; // Check last N actions for repeated errors
const STALL_ERROR_THRESHOLD = 3; // Same error appearing this many times

// ── Provider mapping for API backend routing ─────────────────────────────────
// Agent tools (goal_complete, agent_report_progress, agent_needs_input,
// agent_checkpoint) are only defined in http-backend.mjs's TOOL_DEFINITIONS.
// Agent spawns MUST route to the API backend.
//
// Map raw provider names to their API backend variants:
const API_PROVIDER_MAP = {
  "anthropic": "anthropic-api",
  "gemini": "gemini-api",
  // API variants and OpenRouter stay as-is
  "anthropic-api": "anthropic-api",
  "gemini-api": "gemini-api",
  "openrouter": "openrouter",
};

/**
 * Map a provider to the API backend-compatible variant.
 * Agent mode requires the API backend for its custom tool set.
 * @param {string|null} provider
 * @returns {string}
 */
function mapToApiProvider(provider) {
  if (!provider) return "anthropic-api"; // Default to Anthropic API
  return API_PROVIDER_MAP[provider] || "openrouter";
}

// ---------------------------------------------------------------------------
// Agent Driver
// ---------------------------------------------------------------------------

export class AgentDriver {
  /**
   * @param {object} punk - The PunkEngine instance (used to call spawn())
   */
  constructor(punk) {
    this.punk = punk;
    this._active = false;
    this._aborted = false;
    this._actionHistory = []; // Rolling buffer of actions for stall detection
    this._goal = null;
    this._budgets = null;
    this._progress = null;
    this._model = null;
    this._provider = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Start autonomous execution toward a goal.
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.workingDir
   * @param {string} params.description - Goal description
   * @param {string[]} params.acceptance - Acceptance criteria
   * @param {object} [params.budgets] - { maxTurns, maxCost, maxTime }
   * @param {string} [params.model] - Model to use
   * @param {string} [params.provider] - Provider to use
   * @param {Function} [params.onEvent] - Callback for status events
   * @returns {Promise<AgentResult>}
   */
  async run({
    projectId,
    workingDir,
    description,
    acceptance,
    budgets = {},
    model = null,
    provider = null,
    onEvent = null,
  }) {
    this._active = true;
    this._aborted = false;
    this._actionHistory = [];
    this._onEvent = onEvent;
    this._model = model;
    this._provider = provider;

    // 1. Set up goal with optional multi-model orchestration (Phase 3)
    const planModel = budgets.planModel || model;
    const buildModel = budgets.buildModel || model;
    const reviewModel = budgets.reviewModel || model;
    this._planModel = planModel;
    this._buildModel = buildModel;
    this._reviewModel = reviewModel;

    this._goal = {
      description,
      acceptance: acceptance || [],
      subgoals: [],
      status: "pending",
      startedAt: Date.now(),
      planModel,
      buildModel,
      reviewModel,
    };
    this._budgets = {
      maxTurns: budgets.maxTurns || DEFAULT_MAX_TURNS,
      maxCost: budgets.maxCost || null,
      maxTime: budgets.maxTime || null,
      turnSpent: 0,
      costSpent: 0,
      startTime: Date.now(),
    };
    this._progress = {
      completed: [],
      remaining: [...(acceptance || [])],
      blockers: [],
      summary: "Starting...",
    };

    // 2. Persist initial goal state
    mergeState(projectId, {
      agentGoal: this._goal,
      agentBudgets: this._budgets,
      agentProgress: this._progress,
      phase: "execution",
    });

    this._emit("status", { message: "Agent goal set, starting autonomous execution..." });

    // 3. Run the agent loop
    const result = await this._agentLoop({
      projectId,
      workingDir,
      model,
      provider,
    });

    // 4. Cleanup
    this._active = false;

    return result;
  }

  /**
   * Abort the current agent execution.
   */
  abort() {
    this._aborted = true;
  }

  /**
   * Resume a paused agent (after needs_input was triggered).
   *
   * @param {object} params
   * @param {string} params.projectId
   * @param {string} params.answer - The human's answer
   * @returns {Promise<AgentResult>}
   */
  async resume({ projectId, answer }) {
    const state = readState(projectId);
    if (!state.agentGoal || state.agentGoal.status !== "paused") {
      return { status: "failed", reason: "No paused goal to resume" };
    }

    this._goal = state.agentGoal;
    this._budgets = state.agentBudgets || this._budgets;
    this._progress = state.agentProgress || this._progress;
    this._goal.status = "in_progress";

    mergeState(projectId, { agentGoal: this._goal });
    this._emit("status", { message: "Resuming agent execution..." });

    const result = await this._agentLoop({
      projectId,
      workingDir: null,
      model: null,
      provider: state.lastProvider || null,
      answer,
    });

    return result;
  }

  // ── Persona System Prompt Builder ────────────────────────────────────────

  /**
   * Build the complete system prompt for an agent spawn.
   * Loads the builder persona from disk, injects project context, and appends
   * the current goal, budgets, and progress as dynamic state.
   *
   * The persona file (~/.pane/punks/builder.md) defines the agent's identity
   * and behavioral rules. Project context is injected into {{PROJECT_CONTEXT}}
   * placeholder. Goal/budget/progress are appended dynamically since they
   * change between spawns within the same goal.
   *
   * This replaces the old buildAgentPrompt() which hardcoded identity alongside
   * the base system context, causing identity contamination.
   *
   * @param {string} workingDir - Project root directory
   * @param {string} projectId - Project identifier (for reading about.md from ~/.pane/memory/{projectId}/about.md)
   * @returns {Promise<string>} Complete system prompt
   */
  async _buildSystemPrompt(workingDir, projectId) {
    const PANE_DIR = process.env.PANE_DATA_DIR || path.join(os.homedir(), ".pane");
    const PERSONA_PATH = path.join(PANE_DIR, "punks", "builder.md");

    // 1. Load the builder persona from disk
    let persona;
    try {
      persona = await fs.readFile(PERSONA_PATH, "utf-8");
    } catch {
      // Fallback persona if file doesn't exist — should not happen in normal
      // operation since Phase 2 creates the file, but handle gracefully.
      persona = `# Builder

## Identity

You are an autonomous engineering agent. You plan, edit, verify, and ship code.
You work systematically through a goal, executing one step at a time.

## Mission

{{PROJECT_CONTEXT}}

## Methodology

1. Understand before acting. Read relevant files before making edits.
2. Execute one step at a time. Verify each change before proceeding.
3. Report progress after each significant step.
4. Declare completion when ALL acceptance criteria are satisfied.

## Principles

- Fix root causes, never suppress errors
- Start simple, add complexity only when proven necessary
- Build on existing decisions — don't re-derive
- Verify every change before marking it complete`;
    }

    // 2. Load project context from about.md
    // about.md is stored at ~/.pane/memory/{projectId}/about.md (set via pane_set_about tool).
    // The workingDir is the project root filesystem path, but about.md lives in Pane's
    // internal memory directory, keyed by projectId.
    let projectContext = "";
    try {
      const MEMORY_DIR = path.join(PANE_DIR, "memory");
      const aboutPath = path.join(MEMORY_DIR, projectId || "", "about.md");
      const about = await fs.readFile(aboutPath, "utf-8");
      projectContext = about.trim();
    } catch {
      // No about.md — that's fine, just use the goal description
    }

    // 3. Inject project context into persona
    const contextBlock = projectContext
      ? `## Project\n\n${projectContext}\n\n## Current Goal\n\n${this._goal?.description || "No goal set."}`
      : `## Current Goal\n\n${this._goal?.description || "No goal set."}`;

    let systemPrompt = persona.replace("{{PROJECT_CONTEXT}}", contextBlock);

    // 4. Append dynamic goal/budget/progress state
    // These change every spawn so they're appended, not part of the persona.
    const parts = [];

    // Acceptance criteria
    if (this._goal?.acceptance?.length > 0) {
      parts.push("");
      parts.push("## Acceptance Criteria");
      for (const a of this._goal.acceptance) {
        parts.push(`- [ ] ${a}`);
      }
    }

    // Budgets
    if (this._budgets) {
      parts.push("");
      parts.push("## Budgets");
      if (this._budgets.maxTurns) parts.push(`- Max turns: ${this._budgets.maxTurns}`);
      if (this._budgets.maxCost)  parts.push(`- Max cost: ${this._budgets.maxCost}`);
      if (this._budgets.maxTime)  parts.push(`- Max time: ${this._budgets.maxTime}`);
      if ((this._budgets.turnSpent || 0) > 0) {
        parts.push(`- Turns used: ${this._budgets.turnSpent}${this._budgets.maxTurns ? ` / ${this._budgets.maxTurns}` : ""}`);
      }
    }

    // Progress — completed
    if (this._progress?.completed?.length > 0) {
      parts.push("");
      parts.push("## Progress — Completed");
      for (const c of this._progress.completed) {
        parts.push(`- ✓ ${c}`);
      }
    }

    // Remaining
    if (this._progress?.remaining?.length > 0) {
      parts.push("");
      parts.push("## Remaining");
      for (const r of this._progress.remaining) {
        parts.push(`- [ ] ${r}`);
      }
    }

    // Blockers
    if (this._progress?.blockers?.length > 0) {
      parts.push("");
      parts.push("## Blockers");
      for (const b of this._progress.blockers) {
        parts.push(`- ⚠ ${b}`);
      }
    }

    if (parts.length > 0) {
      systemPrompt += parts.join("\n");
    }

    return systemPrompt;
  }

  // ── Internal Agent Loop ──────────────────────────────────────────────────

  /**
   * The core agent loop. Calls spawn() in a loop, checking budgets and
   * progress between runs. Optionally runs a planning spawn before
   * execution to decompose the goal into sub-goals.
   */
  async _agentLoop({ projectId, workingDir, model, provider, answer }) {
    let spawnCount = 0;
    let lastAccomplishmentCount = 0;
    let noProgressCount = 0;
    const maxSpawns = DEFAULT_MAX_SPAWNS;

    // ── Phase 2: Sub-goal decomposition (planning spawn) ─────────────
    // Before execution, let the model plan out sub-goals. This uses a
    // read-only spawn so the model can explore the codebase but not modify files.
    if (this._goal.subgoals.length === 0 && this._goal.acceptance.length > 0) {
      const planResult = await this._planPhase({
        projectId,
        workingDir,
        planModel: this._planModel || model,
      });

      if (planResult.subgoals?.length > 0) {
        this._goal.subgoals = planResult.subgoals;
        this._progress.remaining = [...planResult.subgoals];
        mergeState(projectId, {
          agentGoal: this._goal,
          agentProgress: this._progress,
        });
        this._emit("status", {
          message: `Planning complete: ${planResult.subgoals.length} sub-goals identified`,
          subgoals: planResult.subgoals,
        });
      } else {
        // Planning didn't produce sub-goals — fall back to acceptance criteria
        this._progress.remaining = [...this._goal.acceptance];
        this._emit("status", { message: "Planning did not produce sub-goals, falling back to acceptance criteria" });
      }
    }

    // ── Phase 3: Multi-model record ─────────────────────────────────
    if (this._planModel && this._buildModel && this._planModel !== this._buildModel) {
      this._emit("status", {
        message: `Multi-model orchestration: plan=${this._planModel}, build=${this._buildModel}${this._reviewModel !== this._buildModel ? `, review=${this._reviewModel}` : ""}`,
      });
    }

    // ── Execution loop ───────────────────────────────────────────────
    while (!this._aborted && spawnCount < maxSpawns) {
      spawnCount++;

      // ── Check budgets before spawning ─────────────────────────────
      const budgetCheck = this._checkBudgets();
      if (!budgetCheck.ok) {
        this._emit("status", { message: `Budget exhausted: ${budgetCheck.reason}` });
        return this._buildResult("failed", budgetCheck.reason);
      }

      // ── Build system prompt (persona + dynamic state) ─────────────
      // The system prompt is the builder persona with project context,
      // goal, budgets, and progress injected. This stays as the model's
      // identity across all spawns within this goal.
      const personaPrompt = await this._buildSystemPrompt(workingDir, projectId);

      // The user message is session-specific — instructs the model
      // what to do this spawn.
      let prompt;
      if (spawnCount === 1) {
        prompt = `Begin working toward the goal. Read the files you need, execute steps one at a time, and report progress. Call agent_report_progress after each significant step. Call goal_complete when ALL acceptance criteria are satisfied.`;
      } else {
        const lastProgress = this._readJournalProgress(projectId);
        const accomplishedCount = lastProgress?.accomplishments?.length || 0;
        prompt = `Continue working toward the goal.`;
        if (accomplishedCount > 0) {
          prompt += ` Last session had ${accomplishedCount} accomplishment${accomplishedCount > 1 ? "s" : ""}.`;
        }
        prompt += ` Pick up where you left off. Do NOT re-read files you already explored — check memory or context-digest for what you already know.`;
      }

      if (answer) {
        prompt += `\n\n[Human response: ${answer}]\nContinue working toward your goal.`;
        answer = null;
      }

      // ── Spawn ─────────────────────────────────────────────────────
      const spawnModel = spawnCount === 1
        ? (this._buildModel || model)
        : model;
      const spawnProvider = spawnCount === 1 ? (this._provider || provider) : provider;

      this._emit("status", {
        message: `Agent spawn ${spawnCount}/${maxSpawns} (model: ${spawnModel || "default"})...`,
        progress: this._progress,
        budgets: this._budgets,
      });

      // Agent tools only exist in the API backend. Force API routing by
      // mapping the provider to its API variant and disabling auto-route.
      const apiProvider = mapToApiProvider(spawnProvider);

      try {
        await this.punk.spawn({
          projectId,
          prompt,
          workingDir: workingDir || projectId,
          model: spawnModel || null,
          provider: apiProvider,
          autoRoute: false,
          intent: "execute",
          history: [],
          requestId: `agent-${projectId}-${spawnCount}-${Date.now()}`,
          systemPromptOverride: personaPrompt,
          _systemOverride: true,
          // Per-spawn cap: starts small (30), grows with experience, max 100.
          // This gives the AgentDriver frequent checkpoints to detect stalls
          // and enforce budgets. Remaining budget is also respected.
          maxTurns: Math.min(
            Math.max(0, (this._budgets.maxTurns || DEFAULT_MAX_TURNS) - (this._budgets.turnSpent || 0)),
            Math.min(30 + (spawnCount - 1) * 10, 100),
          ),
        });
      } catch (err) {
        this._emit("error", { message: `Spawn failed: ${err.message}` });
        return this._buildResult("failed", `Spawn error: ${err.message}`);
      }

      // ── Post-spawn analysis ───────────────────────────────────────
      const state = readState(projectId);
      const lastProgress = this._readJournalProgress(projectId);

      if (state.agentGoal) this._goal = state.agentGoal;
      if (state.agentBudgets) {
        this._budgets = state.agentBudgets;
        this._budgets.turnSpent = (this._budgets.turnSpent || 0) + 1;
      }
      if (state.agentProgress) this._progress = state.agentProgress;

      // Update turn count from session state
      if (state.turnCount > 0) {
        this._budgets.turnSpent = state.turnCount;
      }

      // ── Check: goal completed? ─────────────────────────────────────
      if (this._goal.status === "completed") {
        this._emit("status", { message: "Goal completed!", goal: this._goal });
        return {
          status: "completed",
          summary: this._goal.sessionSummary || this._progress?.summary || "Goal completed.",
          progress: this._progress,
          budgets: this._budgets,
          goal: this._goal,
        };
      }

      // ── Check: paused (needs input)? ──────────────────────────────
      // agent_needs_input tool sets agentGoal.status to "paused".
      // The driver must stop looping and return so the caller can
      // inspect the pause and call resume() with a human answer.
      if (this._goal.status === "paused") {
        const question = this._progress?.blockers?.[this._progress.blockers.length - 1] || "";
        this._emit("status", {
          message: "Agent paused: needs human input",
          needsInput: true,
          question,
        });
        return {
          status: "paused",
          summary: this._progress?.summary || "Agent paused: waiting for input",
          progress: this._progress,
          budgets: this._budgets,
          goal: this._goal,
          needsInput: true,
          question,
        };
      }

      // ── Phase 2: Stall detection ──────────────────────────────────
      const stallResult = this._detectStall(lastProgress, lastAccomplishmentCount);
      if (stallResult.stalled) {
        this._emit("status", { message: `Stall detected: ${stallResult.reason}` });
        return this._buildResult("failed", stallResult.reason);
      }

      // Update counters for stall detection
      const currentCount = this._progress?.completed?.length || 0;
      if (currentCount <= lastAccomplishmentCount) {
        noProgressCount++;
      } else {
        noProgressCount = 0;
        lastAccomplishmentCount = currentCount;
      }
      lastAccomplishmentCount = currentCount;

      // Record actions for ping-pong detection
      if (lastProgress?.accomplishments?.length > 0) {
        this._actionHistory.push({
          type: "accomplishment",
          count: lastProgress.accomplishments.length,
          ts: Date.now(),
        });
      }
      if (lastProgress?.blockers?.length > 0) {
        for (const b of lastProgress.blockers) {
          this._actionHistory.push({
            type: "blocker",
            content: typeof b === "string" ? b : b.text || "",
            ts: Date.now(),
          });
        }
      }

      // ── Phase 2: Sub-goal completion tracking ─────────────────────
      // Check if completed items match sub-goals and update remaining
      if (this._goal.subgoals?.length > 0 && this._progress?.completed?.length > 0) {
        const remaining = [];
        for (const sg of this._goal.subgoals) {
          const isDone = this._progress.completed.some(c =>
            typeof c === "string" && sg.toLowerCase().includes(c.toLowerCase().slice(0, 30))
          );
          if (!isDone) remaining.push(sg);
        }
        this._progress.remaining = remaining;
        mergeState(projectId, { agentProgress: this._progress });
      }

      // ── Phase 3: Self-review (when remaining is empty) ────────────
      const remainingWork = this._progress?.remaining || [];
      const hasRemainingSubtasks = remainingWork.length > 0;
      if (!hasRemainingSubtasks && this._progress?.completed?.length > 0) {
        this._emit("status", { message: "All items claimed done. Running self-review..." });

        // Use same builder persona for review — the user prompt tells it to
        // switch to verification mode. The persona's identity and methodology
        // remain consistent; the task focus changes.
        const reviewPersonaPrompt = await this._buildSystemPrompt(workingDir, projectId);
        const reviewUserPrompt = [
          "[SELF-REVIEW MODE]",
          "",
          "Verify that the implementation correctly satisfies all acceptance criteria.",
          "You are NOT here to make forward progress — you are here to check work already done.",
          "",
          "## Review Checklist",
          "1. Correctness — Does the code do what it's supposed to?",
          "2. Edge cases — What happens with unexpected input or error states?",
          "3. Error handling — Are errors caught gracefully?",
          "4. Consistency — Does the new code match the existing patterns?",
          "5. Completeness — Are ALL acceptance criteria truly met?",
          "",
          "If you find issues, fix them directly. After fixing, re-check.",
          "When everything passes, call goal_complete with a summary.",
        ].join("\n");

        const reviewModel = this._reviewModel || this._buildModel || model;

        try {
          const reviewApiProvider = mapToApiProvider(provider);
          await this.punk.spawn({
            projectId,
            prompt: reviewUserPrompt,
            workingDir: workingDir || projectId,
            model: reviewModel || null,
            provider: reviewApiProvider,
            autoRoute: false,
            intent: "execute",
            history: [],
            requestId: `agent-review-${projectId}-${spawnCount}-${Date.now()}`,
            systemPromptOverride: reviewPersonaPrompt,
            _systemOverride: true,
            maxTurns: 30,
          });

          const reviewState = readState(projectId);
          if (reviewState.agentGoal?.status === "completed") {
            return {
              status: "completed",
              summary: reviewState.agentGoal.sessionSummary || "Goal completed after review.",
              progress: reviewState.agentProgress || this._progress,
              budgets: this._budgets,
              goal: reviewState.agentGoal || this._goal,
            };
          }
        } catch (err) {
          this._emit("error", { message: `Review failed (non-fatal): ${err.message}` });
        }
      }

      // ── Phase 3: Cross-session learning ──────────────────────────
      if (lastProgress) {
        this._indexOutcomes(projectId, lastProgress).catch(() => {
          // Non-fatal — indexing is opportunistic; brain may not be available
        });
      }

      // Brief pause before next spawn
      await new Promise(r => setTimeout(r, 500));
    }

    // Loop ended — max spawns reached or aborted
    if (this._aborted) {
      return this._buildResult("interrupted", "Agent execution was aborted.");
    }

    return this._buildResult("failed", `Max spawns (${maxSpawns}) reached without completion.`);
  }

  // ── Phase 2: Sub-goal decomposition ─────────────────────────────────────

  /**
   * Run a planning spawn to decompose the goal into sub-goals.
   * Read-only phase — the model can explore but not modify files.
   */
  async _planPhase({ projectId, workingDir, planModel }) {
    try {
      // Use same builder persona as system prompt (with project context).
      // The planning user prompt tells it to explore and decompose.
      const planPersonaPrompt = await this._buildSystemPrompt(workingDir, projectId);
      const planningUserPrompt = [
        "[PLANNING PHASE — READ ONLY]",
        "",
        "Your job is to break the goal below into concrete, actionable sub-goals.",
        "You can explore the codebase freely but you CANNOT modify any files.",
        "",
        "## Instructions",
        "1. Explore first. Read relevant files. Understand the architecture.",
        "2. Break the goal into 3-8 sub-goals. Each should be independently testable.",
        "3. Order them by dependency — what must be done first.",
        "4. Be specific — 'Create X module', 'Add Y route', not 'Implement feature'.",
        "5. After exploring, call agent_report_progress with the sub-goals as your",
        "   completed items ('Explored codebase', 'Created plan with N sub-goals')",
        "   and remaining work (the sub-goals, numbered).",
      ].join("\n");

      const requestId = `agent-plan-${projectId}-${Date.now()}`;

      // Agent tools only exist in the API backend. Force API routing.
      const planApiProvider = mapToApiProvider(null);

      // Spawn with plan phase (read-only)
      await this.punk.spawn({
        projectId,
        prompt: planningUserPrompt,
        workingDir: workingDir || projectId,
        model: planModel || null,
        provider: planApiProvider,
        autoRoute: false,
        intent: "analyze",     // Read-only phase
        history: [],
        requestId,
        systemPromptOverride: planPersonaPrompt,
        _systemOverride: true,
        maxTurns: 20,
      });

      // Read the goal state after planning
      const state = readState(projectId);
      const progress = this._readJournalProgress(projectId);

      // Extract sub-goals from the planning output
      const subgoals = state.agentGoal?.subgoals?.length > 0
        ? state.agentGoal.subgoals
        : this._extractSubgoalsFromProgress(progress);

      return { subgoals };
    } catch (err) {
      this._emit("error", { message: `Planning phase failed: ${err.message}` });
      return { subgoals: [] };
    }
  }

  /**
   * Extract sub-goals from the planning spawn output.
   * Parses the journal progress for any sub-goal-like accomplishments.
   */
  _extractSubgoalsFromProgress(progress) {
    if (!progress) return [];
    const subgoals = [];
    // If the model marked accomplishments during planning, those are sub-goals
    if (progress.accomplishments?.length > 0) {
      for (const a of progress.accomplishments) {
        const text = typeof a === "string" ? a : a.text || "";
        if (text.length > 10) subgoals.push(text);
      }
    }
    // If no sub-goals found from accomplishments, use remaining work items
    if (subgoals.length === 0 && progress.remaining?.length > 0) {
      return progress.remaining;
    }
    return subgoals;
  }

  // ── Phase 2: Stall detection ────────────────────────────────────────────

  /**
   * Detect stalls: no-progress, file ping-pong, error loops.
   */
  _detectStall(lastProgress, lastAccomplishmentCount) {
    // 1. No-progress detection (via caller — tracked in _agentLoop)
    // Handled by noProgressCount in the main loop.

    // 2. File ping-pong detection — repeated blockers on the same topic
    if (this._actionHistory.length >= STALL_FILE_PING_PONG_WINDOW) {
      const recent = this._actionHistory.slice(-STALL_FILE_PING_PONG_WINDOW);
      const blockerFrequencies = {};
      for (const action of recent) {
        if (action.type === "blocker" && action.content) {
          const key = action.content.toLowerCase().slice(0, 60);
          blockerFrequencies[key] = (blockerFrequencies[key] || 0) + 1;
        }
      }
      for (const [key, count] of Object.entries(blockerFrequencies)) {
        if (count >= STALL_FILE_PING_PONG_THRESHOLD) {
          return {
            stalled: true,
            reason: `Ping-pong detected: same blocker repeated ${count} times: "${key.slice(0, 80)}"`,
          };
        }
      }
    }

    // 3. Error loop detection — check for repeated errors in progress blockers
    if (lastProgress?.blockers?.length > 0) {
      const recentBlockers = this._actionHistory
        .filter(a => a.type === "blocker")
        .slice(-STALL_ERROR_WINDOW);
      if (recentBlockers.length >= STALL_ERROR_THRESHOLD) {
        // Check if they're all the same kind of blocker
        const uniqueBlockers = new Set(recentBlockers.map(b => b.content?.toLowerCase().slice(0, 40)));
        if (uniqueBlockers.size === 1) {
          return {
            stalled: true,
            reason: `Error loop: "${Array.from(uniqueBlockers)[0]?.slice(0, 80)}" repeated ${recentBlockers.length}x`,
          };
        }
      }
    }

    return { stalled: false };
  }

  // ── Budget checks ────────────────────────────────────────────────────────

  _checkBudgets() {
    const b = this._budgets;
    if (!b) return { ok: true };

    if (b.maxTurns && (b.turnSpent || 0) >= b.maxTurns) {
      return { ok: false, reason: `Turn budget exhausted (${b.turnSpent}/${b.maxTurns})` };
    }
    if (b.maxCost && (b.costSpent || 0) >= b.maxCost) {
      return { ok: false, reason: `Cost budget exhausted ($${(b.costSpent || 0).toFixed(4)}/$${b.maxCost})` };
    }
    if (b.maxTime && (Date.now() - (b.startTime || Date.now())) >= b.maxTime) {
      return { ok: false, reason: `Time budget exhausted` };
    }

    return { ok: true };
  }

  // ── Phase 3: Outcome indexing ──────────────────────────────────────────

  async _indexOutcomes(projectId, progress) {
    const brainRequestRef = this.punk._brainRequest;
    if (!brainRequestRef || !progress) return;

    const events = [];
    if (progress.accomplishments?.length > 0) {
      for (const a of progress.accomplishments) {
        events.push({
          type: "accomplishment",
          content: typeof a === "string" ? a : a.text || "",
          metadata: { source: "agent" },
        });
      }
    }
    if (progress.blockers?.length > 0) {
      for (const b of progress.blockers) {
        events.push({
          type: "blocker",
          content: typeof b === "string" ? b : b.text || "",
          metadata: { source: "agent" },
        });
      }
    }
    if (events.length > 0) {
      await brainRequestRef("index_events", { projectId, events });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _readJournalProgress(projectId) {
    try {
      return readLastProgress(projectId);
    } catch {
      return null;
    }
  }

  _buildResult(status, reason) {
    return {
      status,
      reason,
      summary: this._progress?.summary || reason,
      progress: this._progress,
      budgets: this._budgets,
      goal: this._goal,
    };
  }

  _emit(type, data) {
    if (this._onEvent) {
      try { this._onEvent(type, data); } catch {}
    }
  }
}

/**
 * Convenience function: create an AgentDriver and run it.
 */
export async function runAgent(params) {
  const driver = new AgentDriver(params.punk);
  return driver.run(params);
}
