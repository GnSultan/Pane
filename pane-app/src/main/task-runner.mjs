/**
 * Pane Task Runner — Control Inversion Engine
 *
 * Instead of handing the model a task and watching it work autonomously,
 * the TaskRunner decomposes the task into steps, executes each step through
 * the existing backend, verifies the result, and decides what's next.
 *
 * The model is a stateless executor. Pane is the driver.
 *
 * Flow:
 *   1. User sends a task
 *   2. TaskRunner makes a lightweight planning call → structured step list
 *   3. For each step:
 *      a. Compile step-specific context (narrow scope, not full project)
 *      b. Send to backend with constrained system prompt
 *      c. Wait for completion
 *      d. Verify result (did it do what was asked? did it run tests?)
 *      e. Update session state
 *      f. Decide: next step, retry, or escalate
 *   4. Emit processEnded when all steps complete
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { compileContext, readState, mergeState } from "./session-context.mjs";
import { createPlan, updatePlanStep, completePlan } from "./plan-store.mjs";

const execAsync = promisify(exec);
const PANE_DIR = path.join(os.homedir(), ".pane");

// ---------------------------------------------------------------------------
// Change History Primitives
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ChangeRecord
 * @property {string} id          — e.g. "ch-1234567890-abc123"
 * @property {number} timestamp   — Unix ms
 * @property {string} file        — absolute or relative file path
 * @property {string} oldString   — content that was replaced
 * @property {string} newString   — content that replaced it
 * @property {string} description — semantic description of the change
 */

/**
 * Read the full change history for a project.
 * @param {string} projectId
 * @returns {Promise<ChangeRecord[]>} Most recent first.
 */
async function readChangeHistory(projectId) {
  const file = path.join(PANE_DIR, "change-history", projectId, "changes.json");
  try {
    return JSON.parse(await fsPromises.readFile(file, "utf-8"));
  } catch {
    return [];
  }
}

/**
 * Snapshot the current head of the change history.
 * Returns the timestamp of the most recent change (or now if empty).
 * Use this BEFORE a step runs, then call getChangesSince() AFTER.
 * @param {string} projectId
 * @returns {Promise<number>} timestamp cursor
 */
async function snapshotChangeHead(projectId) {
  const changes = await readChangeHistory(projectId);
  if (changes.length === 0) return Date.now();
  return changes[0].timestamp;
}

/**
 * Get all changes recorded strictly AFTER the given timestamp cursor.
 * These are the changes that happened during a step.
 * @param {string} projectId
 * @param {number} sinceTimestamp
 * @returns {Promise<ChangeRecord[]>}
 */
async function getChangesSince(projectId, sinceTimestamp) {
  const changes = await readChangeHistory(projectId);
  return changes.filter(c => c.timestamp > sinceTimestamp);
}

/**
 * Revert a list of changes by ID — used for surgical step rollback.
 * Applies reversals in reverse chronological order (newest first).
 * @param {string} projectId
 * @param {string[]} changeIds
 * @param {string} projectRoot
 */
async function revertChanges(projectId, changeIds, projectRoot) {
  const file = path.join(PANE_DIR, "change-history", projectId, "changes.json");
  let changes = await readChangeHistory(projectId);

  const toRevert = changeIds
    .map(id => changes.find(c => c.id === id))
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp); // newest first

  const reverted = [];
  for (const change of toRevert) {
    const resolved = path.isAbsolute(change.file)
      ? change.file
      : path.join(projectRoot, change.file);
    try {
      const current = await fsPromises.readFile(resolved, "utf-8");
      if (current.includes(change.newString)) {
        const restored = current.replace(change.newString, change.oldString);
        await fsPromises.writeFile(resolved, restored, "utf-8");
        reverted.push(change.id);
      }
    } catch (err) {
      console.warn(`[task-runner] revertChanges: failed to revert ${change.file}: ${err.message}`);
    }
  }

  // Remove reverted entries from history
  changes = changes.filter(c => !reverted.includes(c.id));
  await fsPromises.writeFile(file, JSON.stringify(changes, null, 2), "utf-8");

  return reverted;
}

/**
 * Run tsc --noEmit on the project and return { passed, output }.
 * Only called at end-of-plan, never per-step.
 * @param {string} workingDir
 * @returns {Promise<{ passed: boolean, output: string }>}
 */
async function runTypeCheck(workingDir) {
  try {
    // Try local tsc first, then global
    const cmd = "npx tsc --noEmit --pretty false 2>&1 || tsc --noEmit --pretty false 2>&1";
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workingDir,
      timeout: 30_000,
    });
    const output = (stdout + stderr).trim();
    const passed = output.length === 0 || /^0 errors/.test(output);
    return { passed, output: output.slice(0, 1000) };
  } catch (err) {
    // execAsync throws on non-zero exit code
    const output = (err.stdout || err.stderr || err.message || "").trim();
    return { passed: false, output: output.slice(0, 1000) };
  }
}

// ---------------------------------------------------------------------------
// Step Schema
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TaskStep
 * @property {number} index        — 1-based step number
 * @property {string} action       — What the model should do (imperative, specific)
 * @property {string[]} files      — Files in scope for this step
 * @property {string} verification — How to verify this step succeeded
 * @property {'read'|'write'|'verify'|'plan'} type — Step archetype
 */

/**
 * @typedef {Object} TaskPlan
 * @property {string} summary      — One-line description of the full task
 * @property {TaskStep[]} steps    — Ordered steps
 * @property {string} model        — Which model was used for planning
 */

// ---------------------------------------------------------------------------
// Planning Prompt
// ---------------------------------------------------------------------------

const PLANNING_SYSTEM_PROMPT = `You are Pane's task decomposition engine. Your job is to break a software engineering task into precise, ordered steps that a model can execute one at a time.

Rules:
- Each step must be independently executable by a model with tool access (read files, edit files, run commands).
- Each step must have a clear verification condition.
- Steps should follow this natural order: understand → plan → implement → verify.
- Keep steps granular. "Add auth to the API" is too broad. "Read the existing route handler in routes/api.ts" is right.
- Never combine reading and writing in one step. Read first, write second.
- The last step should always be verification (run tests, type-check, or build).
- Maximum 8 steps. If the task needs more, you're over-scoping.

Step types:
- "read": Model reads/explores files to understand something. No edits.
- "write": Model makes a specific code change. Must name exact files.
- "verify": Model runs a command to verify (test, build, type-check).
- "plan": Model produces a plan or analysis (no file changes).

Respond with ONLY a JSON object. No markdown, no explanation, no code fences.

Schema:
{
  "summary": "one-line task description",
  "steps": [
    {
      "index": 1,
      "action": "imperative instruction for the model",
      "files": ["path/to/file.ts"],
      "verification": "what success looks like",
      "type": "read|write|verify|plan"
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Step Execution Prompt
// ---------------------------------------------------------------------------

function buildStepPrompt(step, plan, projectContext, prevScopeViolations = []) {
  const parts = [
    `You are executing step ${step.index} of ${plan.steps.length} in a Pane-orchestrated task.`,
    "",
    `## Task: ${plan.summary}`,
    "",
    `## Your Step: ${step.action}`,
    "",
    `## Step Type: ${step.type}`,
    "",
  ];

  // Scope enforcement
  if (step.files.length > 0) {
    parts.push(`## Files in scope for this step:`);
    for (const f of step.files) parts.push(`- ${f}`);
    parts.push(`Do NOT touch files outside this list.`);
    parts.push("");
  }

  // Type-specific constraints
  switch (step.type) {
    case "read":
      parts.push("## Constraints:");
      parts.push("- Read and analyze only. Do NOT edit any files.");
      parts.push("- Summarize what you find — the next step depends on your analysis.");
      break;
    case "write":
      parts.push("## Constraints:");
      parts.push("- Make the specific change described above. Nothing more.");
      parts.push("- Use targeted edits (replace/edit), not full file rewrites.");
      parts.push("- Do not refactor surrounding code.");
      break;
    case "verify":
      parts.push("## Constraints:");
      parts.push("- Run the verification command(s) and report the result.");
      parts.push("- If verification fails, describe what went wrong — do NOT attempt to fix it.");
      break;
    case "plan":
      parts.push("## Constraints:");
      parts.push("- Produce analysis or a plan. Do NOT make any file changes.");
      break;
  }

  parts.push("");
  parts.push(`## Verification: ${step.verification}`);
  parts.push("");

  // Show progress
  const completed = plan.steps.filter((s, i) => i < step.index - 1);
  if (completed.length > 0) {
    parts.push("## Completed steps:");
    for (const c of completed) {
      parts.push(`  ${c.index}. [done] ${c.action}`);
    }
    parts.push("");
  }

  const remaining = plan.steps.filter((s, i) => i > step.index - 1);
  if (remaining.length > 0) {
    parts.push("## Remaining steps (not your concern yet):");
    for (const r of remaining) {
      parts.push(`  ${r.index}. ${r.action}`);
    }
    parts.push("");
  }

  // Scope violations from previous steps — warn the model not to repeat them
  if (prevScopeViolations.length > 0) {
    parts.push("## ⚠ Scope Warning:");
    parts.push("Previous steps in this plan touched files outside their declared scope:");
    for (const f of prevScopeViolations) parts.push(`  - ${f}`);
    parts.push("Do NOT touch these files in this step unless they are in your scope above.");
    parts.push("");
  }

  // Inject project context if available
  if (projectContext) {
    parts.push("## Project Context:");
    parts.push(projectContext);
    parts.push("");
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Verification Logic — grounded in Pane change history, not message scanning
// ---------------------------------------------------------------------------

/**
 * Verify a step using Pane's change history as ground truth.
 *
 * For write steps:
 *   - Did any changes get recorded since the step started? (presence)
 *   - Did those changes touch only declared files? (scope)
 *   - Do the change descriptions/content roughly match the step's action? (intent)
 *
 * For read/plan steps:
 *   - Did the model respond at all? (presence check only — no file changes expected)
 *
 * For verify steps:
 *   - Handled at end-of-plan via runTypeCheck(), not per-step
 *   - Here we just confirm the step ran without a tool error
 *
 * @param {TaskStep} step
 * @param {ChangeRecord[]} stepChanges  — changes recorded during this step
 * @param {any[]} messages              — conversation messages from this step
 * @returns {{ passed: boolean, reason: string, scopeViolations: string[] }}
 */
function verifyStepResult(step, stepChanges, messages) {
  const scopeViolations = [];

  // ── READ / PLAN STEPS ─────────────────────────────────────────────────────
  // No file changes expected. Just confirm the model responded.
  if (step.type === "read" || step.type === "plan") {
    const hasResponse = messages?.some(m => m.role === "assistant");
    return {
      passed: hasResponse,
      reason: hasResponse ? "Step completed" : "No model response",
      scopeViolations,
    };
  }

  // ── VERIFY STEPS ──────────────────────────────────────────────────────────
  // Real verification (tsc/tests) happens at end-of-plan.
  // Here just check the model didn't immediately error out.
  if (step.type === "verify") {
    const toolErrors = (messages || []).filter(m =>
      Array.isArray(m.content) &&
      m.content.some(b => b.type === "tool_result" && b.is_error)
    );
    if (toolErrors.length > 0) {
      return { passed: false, reason: "Verify step hit a tool error", scopeViolations };
    }
    return { passed: true, reason: "Verify step ran", scopeViolations };
  }

  // ── WRITE STEPS ───────────────────────────────────────────────────────────

  // 1. Presence: did any changes actually land?
  if (stepChanges.length === 0) {
    return {
      passed: false,
      reason: "Write step produced no recorded changes — file may not have been modified",
      scopeViolations,
    };
  }

  // 2. Scope: which files were actually touched?
  if (step.files.length > 0) {
    const declaredNormalized = new Set(
      step.files.map(f => path.normalize(f).toLowerCase())
    );
    for (const change of stepChanges) {
      const changedNorm = path.normalize(change.file).toLowerCase();
      // Allow partial match (model may use absolute vs relative paths)
      const inScope = [...declaredNormalized].some(declared =>
        changedNorm.endsWith(declared) || declared.endsWith(changedNorm)
      );
      if (!inScope) {
        scopeViolations.push(change.file);
      }
    }
  }

  // 3. Intent: do the change descriptions loosely match the step action?
  //    Extract significant words from the step action and check if any appear
  //    in the change descriptions or new content. Low bar — just catches total mismatches.
  const actionKeywords = step.action
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 4 && !/^(should|would|could|the|this|that|with|from|into|have|been|will)$/.test(w));

  const intentSignal = stepChanges.some(change => {
    const haystack = (
      (change.description || "") + " " + (change.newString || "")
    ).toLowerCase();
    return actionKeywords.some(kw => haystack.includes(kw));
  });

  // Scope violations are noted but don't block — they get surfaced as warnings
  // and injected into the next step's prompt. A wrong-file change is bad but
  // stopping mid-plan is worse. The user sees it in orchestration events.
  const reason = scopeViolations.length > 0
    ? `Changed ${stepChanges.length} file(s) — scope violations: ${scopeViolations.join(", ")}`
    : intentSignal
      ? `Changed ${stepChanges.length} file(s) — matches intent`
      : `Changed ${stepChanges.length} file(s) — intent match uncertain`;

  return {
    passed: true,
    reason,
    scopeViolations,
  };
}

// ---------------------------------------------------------------------------
// Task Runner
// ---------------------------------------------------------------------------

export class TaskRunner {
  /**
   * @param {Function} spawnStep — Function that executes a single step through the backend.
   *   Signature: (projectId, prompt, systemOverride, request) => Promise<{ messages: any[] }>
   * @param {Function} onEvent — Callback for progress events.
   *   Signature: (projectId, event, requestId) => void
   * @param {Function} planCall — Function that makes a planning API call (no tools).
   *   Signature: (systemPrompt, userPrompt, request) => Promise<string>
   */
  constructor(spawnStep, onEvent, planCall) {
    this.spawnStep = spawnStep;
    this.onEvent = onEvent;
    this.planCall = planCall;
    this.activeRuns = new Map(); // projectId -> { plan, currentStep, aborted }
  }

  /**
   * Determine if a task should use the TaskRunner (multi-step orchestration)
   * vs going straight to the model (simple single-turn tasks).
   */
  /**
   * Decide whether this task should go through the orchestration loop.
   *
   * Grounded in session state facts, not keyword counting.
   * Regex is still used for explicit overrides and question detection only.
   *
   * Scoring:
   *   Each signal adds weight. Threshold = 3 to orchestrate.
   *   Hard overrides bypass scoring entirely.
   */
  shouldOrchestrate(prompt, state) {
    const text = prompt.toLowerCase().trim();
    const words = text.split(/\s+/);

    // ── Hard overrides ────────────────────────────────────────────────────
    // Too short to be a multi-step task
    if (words.length < 5) return false;

    // User explicitly wants direct model access
    if (text.startsWith("/direct") || text.startsWith("/raw")) return false;

    // User explicitly wants orchestration
    if (text.startsWith("/orchestrate") || text.startsWith("/steps")) return true;

    // Pure questions with no action verb → direct
    if (text.endsWith("?") && !/\b(fix|add|create|implement|build|change|update|refactor)\b/.test(text)) {
      return false;
    }

    // ── Session state signals (ground truth) ─────────────────────────────
    let score = 0;

    // Working set size: Pane already knows which files are in play.
    // 3+ files = multi-file task with high confidence.
    const workingSetSize = state?.workingSet?.length ?? 0;
    if (workingSetSize >= 5) score += 3;
    else if (workingSetSize >= 3) score += 2;
    else if (workingSetSize >= 2) score += 1;

    // Active todos: if the session already has a plan with multiple steps,
    // the model already decided this is multi-step.
    const pendingTodos = (state?.todos ?? []).filter(t => t.status !== "completed");
    if (pendingTodos.length >= 4) score += 3;
    else if (pendingTodos.length >= 2) score += 2;
    else if (pendingTodos.length === 1) score += 1;

    // Active task: Pane is already tracking a goal — this is likely a continuation.
    if (state?.activeTask?.description) score += 1;

    // Recent decisions: locked decisions mean earlier steps happened — we're mid-task.
    const recentDecisions = (state?.decisions ?? []).length;
    if (recentDecisions >= 3) score += 1;

    // ── Prompt structure signals ──────────────────────────────────────────
    // User wrote a numbered list — they already decomposed it themselves.
    if (/^\s*\d+[.)]\s/m.test(prompt)) score += 3;

    // Prompt explicitly mentions multiple files (not just keywords, actual paths)
    const fileRefs = (prompt.match(/[\w/-]+\.[a-z]{2,4}/g) || []).length;
    if (fileRefs >= 3) score += 2;
    else if (fileRefs >= 2) score += 1;

    // Long detailed prompt with action verb — the user described a real task
    if (words.length > 40 && /\b(implement|build|create|add|fix|refactor|migrate)\b/.test(text)) score += 1;

    return score >= 3;
  }

  /**
   * Main entry point. Decomposes the task, executes steps, verifies results.
   * @param {string} projectId
   * @param {string} prompt
   * @param {object} request          — execution request (model used per step)
   * @param {object} [planningRequest] — separate request for the planning call (reasoning model)
   */
  async run(projectId, prompt, request, planningRequest) {
    const runState = { plan: null, currentStep: 0, aborted: false };
    this.activeRuns.set(projectId, runState);

    try {
      // Emit orchestration start
      this.onEvent(projectId, {
        event: "orchestration_start",
        data: { prompt },
      }, request.requestId);

      // ── STEP 1: DECOMPOSE ──────────────────────────────────────────────
      const state = readState(projectId);
      const context = compileContext(projectId, "execute", 0);

      // Build planning context
      const planningContext = [
        `Project working directory: ${request.workingDir}`,
      ];

      if (state.workingSet?.length > 0) {
        planningContext.push("Files currently in the working set:");
        for (const f of state.workingSet.slice(0, 8)) {
          planningContext.push(`  - ${f.path}${f.purpose ? ` (${f.purpose})` : ""}`);
        }
      }

      if (state.decisions?.length > 0) {
        planningContext.push("Locked decisions:");
        for (const d of state.decisions) {
          planningContext.push(`  - ${d.content}`);
        }
      }

      const userPrompt = `${planningContext.join("\n")}\n\nTask:\n${prompt}`;

      this.onEvent(projectId, {
        event: "orchestration_step",
        data: { phase: "planning", message: "Decomposing task into steps..." },
      }, request.requestId);

      // Use the dedicated planning request (reasoning model) if provided,
      // otherwise fall back to the execution request.
      const callRequest = planningRequest || request;
      const planningModel = callRequest.model || null;
      const executionModel = request.model || null;

      let plan;
      try {
        const planJson = await this.planCall(
          PLANNING_SYSTEM_PROMPT,
          userPrompt,
          callRequest,
        );
        plan = JSON.parse(planJson);
      } catch (err) {
        console.error("[task-runner] Planning call failed:", err.message);
        // Fallback: single-step direct execution
        plan = {
          summary: prompt.slice(0, 100),
          steps: [{
            index: 1,
            action: prompt,
            files: (state.workingSet || []).map(f => f.path),
            verification: "Verify the change is correct",
            type: "write",
          }],
        };
      }

      // Validate plan
      if (!plan.steps || plan.steps.length === 0) {
        throw new Error("Planning produced empty step list");
      }

      // Cap at 8 steps
      plan.steps = plan.steps.slice(0, 8);

      runState.plan = plan;

      // Persist plan as a durable artifact on disk
      const { planId } = createPlan(projectId, plan.summary, plan.steps, {
        planning: planningModel,
        execution: executionModel,
      });
      runState.planId = planId;

      this.onEvent(projectId, {
        event: "orchestration_plan",
        data: {
          planId,
          summary: plan.summary,
          steps: plan.steps.map(s => ({
            index: s.index,
            action: s.action,
            type: s.type,
            files: s.files,
          })),
          totalSteps: plan.steps.length,
          planningModel,
          executionModel,
        },
      }, request.requestId);

      // Update session state with task info
      mergeState(projectId, {
        activeTask: { description: plan.summary },
        todos: plan.steps.map(s => ({
          content: s.action,
          status: "pending",
          activeForm: s.action.split(" ").slice(0, 4).join(" ") + "...",
        })),
      });

      // ── STEP 2: EXECUTE EACH STEP ──────────────────────────────────────
      const stepResults = [];
      // Track all change IDs produced across all steps (for scope reporting)
      const allStepChangeIds = [];

      for (let i = 0; i < plan.steps.length; i++) {
        if (runState.aborted) break;

        const step = plan.steps[i];
        runState.currentStep = i + 1;

        // Update todo status
        const updatedTodos = plan.steps.map((s, idx) => ({
          content: s.action,
          status: idx < i ? "completed" : idx === i ? "in_progress" : "pending",
          activeForm: s.action.split(" ").slice(0, 4).join(" ") + "...",
        }));
        mergeState(projectId, { todos: updatedTodos });

        this.onEvent(projectId, {
          event: "orchestration_step",
          data: {
            phase: "executing",
            stepIndex: step.index,
            totalSteps: plan.steps.length,
            action: step.action,
            type: step.type,
            message: `Step ${step.index}/${plan.steps.length}: ${step.action}`,
          },
        }, request.requestId);

        // ── Snapshot change history BEFORE the step runs ──────────────────
        const changeCursor = await snapshotChangeHead(projectId);

        // Build step-specific prompt — inject scope violations from previous steps
        const prevViolations = stepResults
          .filter(r => r.verification.scopeViolations?.length > 0)
          .flatMap(r => r.verification.scopeViolations);

        // Synthesize inter-step handoff from Pane's change history (not model output)
        // This gives the execution model grounded context about what actually happened
        // in previous steps — derived from change records, not from conversation text.
        const handoffLines = [];
        for (const prev of stepResults) {
          if (prev.stepChanges.length > 0) {
            const files = [...new Set(prev.stepChanges.map(c => c.file.split("/").pop()))];
            const descs = prev.stepChanges
              .map(c => c.description)
              .filter(Boolean)
              .slice(0, 2);
            handoffLines.push(
              `Step ${prev.step.index} (${prev.step.action.split(" ").slice(0, 5).join(" ")}...): ` +
              `modified ${files.join(", ")}` +
              (descs.length > 0 ? ` — ${descs.join("; ")}` : "")
            );
          } else if (prev.step.type === "read" || prev.step.type === "plan") {
            handoffLines.push(
              `Step ${prev.step.index} (${prev.step.action.split(" ").slice(0, 5).join(" ")}...): ` +
              `analysis complete`
            );
          }
        }

        const stepSystemPrompt = buildStepPrompt(
          step,
          plan,
          handoffLines.length > 0
            ? (context.dynamic ? context.dynamic + "\n\n## Work completed so far:\n" + handoffLines.join("\n") : "## Work completed so far:\n" + handoffLines.join("\n"))
            : context.dynamic,
          prevViolations
        );
        const stepPrompt = step.action;

        // Execute step through existing backend.
        // Each step gets NO conversation history — it is a fresh, narrowly-scoped
        // job card. The execution model does not need (and should not see) the
        // full conversation that preceded orchestration. Context comes from the
        // system prompt above, not from accumulated chat history.
        let stepMessages = [];
        try {
          const result = await this.spawnStep(
            projectId,
            stepPrompt,
            stepSystemPrompt,
            {
              ...request,
              history: [], // ← narrow job card: no conversation history
              intent: step.type === "verify" ? "execute" : request.intent,
            },
          );
          stepMessages = result.messages || [];
        } catch (err) {
          console.error(`[task-runner] Step ${step.index} failed:`, err.message);
        }

        // ── Read changes that occurred DURING this step ────────────────────
        const stepChanges = await getChangesSince(projectId, changeCursor);
        const stepChangeIds = stepChanges.map(c => c.id);
        allStepChangeIds.push(...stepChangeIds);

        // ── Verify using change history, not message scanning ──────────────
        const verification = verifyStepResult(step, stepChanges, stepMessages);

        stepResults.push({
          step,
          verification,
          stepChanges,
          stepChangeIds,
        });

        this.onEvent(projectId, {
          event: "orchestration_step_complete",
          data: {
            stepIndex: step.index,
            totalSteps: plan.steps.length,
            passed: verification.passed,
            reason: verification.reason,
            scopeViolations: verification.scopeViolations,
            changedFiles: [...new Set(stepChanges.map(c => c.file))],
            action: step.action,
          },
        }, request.requestId);

        // Persist step result to plan store
        if (runState.planId) {
          updatePlanStep(projectId, runState.planId, step.index, {
            status: verification.passed ? "completed" : "failed",
            completedAt: Date.now(),
            paneVerdict: verification.passed ? "passed" : "failed",
            verdictReason: verification.reason,
            changedFiles: [...new Set(stepChanges.map(c => c.file))],
            changeIds: stepChangeIds,
          });
        }

        // ── Retry on failed write step — surgical rollback first ───────────
        if (!verification.passed && step.type === "write") {
          console.warn(`[task-runner] Step ${step.index} failed: ${verification.reason}. Rolling back and retrying...`);

          this.onEvent(projectId, {
            event: "orchestration_step",
            data: {
              phase: "retrying",
              stepIndex: step.index,
              totalSteps: plan.steps.length,
              action: step.action,
              reason: verification.reason,
              message: `Rolling back step ${step.index} and retrying...`,
            },
          }, request.requestId);

          // Revert this step's changes before retrying
          if (stepChangeIds.length > 0) {
            await revertChanges(projectId, stepChangeIds, request.workingDir);
            // Remove reverted IDs from tracking
            stepChangeIds.forEach(id => {
              const pos = allStepChangeIds.indexOf(id);
              if (pos >= 0) allStepChangeIds.splice(pos, 1);
            });
          }

          // Snapshot again after rollback
          const retryCursor = await snapshotChangeHead(projectId);

          try {
            const retryPrompt = `${step.action}\n\nPrevious attempt produced no file changes. Make sure to actually edit the file using write_file or replace tools.`;
            const retryResult = await this.spawnStep(
              projectId,
              retryPrompt,
              stepSystemPrompt,
              request,
            );

            const retryChanges = await getChangesSince(projectId, retryCursor);
            const retryVerification = verifyStepResult(step, retryChanges, retryResult.messages || []);
            const retryChangeIds = retryChanges.map(c => c.id);
            allStepChangeIds.push(...retryChangeIds);

            stepResults[stepResults.length - 1] = {
              step,
              verification: retryVerification,
              stepChanges: retryChanges,
              stepChangeIds: retryChangeIds,
            };

            this.onEvent(projectId, {
              event: "orchestration_step_complete",
              data: {
                stepIndex: step.index,
                totalSteps: plan.steps.length,
                passed: retryVerification.passed,
                reason: retryVerification.reason,
                scopeViolations: retryVerification.scopeViolations,
                changedFiles: [...new Set(retryChanges.map(c => c.file))],
                action: step.action,
                retry: true,
              },
            }, request.requestId);

            // Persist retry result
            if (runState.planId) {
              updatePlanStep(projectId, runState.planId, step.index, {
                status: retryVerification.passed ? "completed" : "failed",
                completedAt: Date.now(),
                paneVerdict: retryVerification.passed ? "passed" : "failed",
                verdictReason: retryVerification.reason,
                changedFiles: [...new Set(retryChanges.map(c => c.file))],
                changeIds: retryChangeIds,
              });
            }
          } catch (err) {
            console.error(`[task-runner] Step ${step.index} retry failed:`, err.message);
          }
        }

        // ── Abort plan if verify step failed (broken code, don't continue) ─
        if (!verification.passed && step.type === "verify") {
          console.warn(`[task-runner] Verify step ${step.index} failed. Stopping plan.`);
          break;
        }
      }

      // ── STEP 3: END-OF-PLAN TYPE CHECK ──────────────────────────────────
      // Now that all write steps are done, run tsc once on the whole project.
      // This is the real correctness check — interdependent changes are all in place.
      const writeStepsRan = stepResults.some(r => r.step.type === "write" && r.verification.passed);
      let typeCheckResult = null;

      if (writeStepsRan && !runState.aborted) {
        this.onEvent(projectId, {
          event: "orchestration_step",
          data: {
            phase: "typechecking",
            message: "Running type check on all changes...",
          },
        }, request.requestId);

        typeCheckResult = await runTypeCheck(request.workingDir);

        this.onEvent(projectId, {
          event: "orchestration_typecheck",
          data: {
            passed: typeCheckResult.passed,
            output: typeCheckResult.output,
          },
        }, request.requestId);

        if (!typeCheckResult.passed) {
          console.warn(`[task-runner] Type check failed after plan:\n${typeCheckResult.output}`);
        }
      }

      // ── STEP 4: FINALIZE ────────────────────────────────────────────────
      const allPassed = stepResults.every(r => r.verification.passed);
      const typeCheckPassed = typeCheckResult === null || typeCheckResult.passed;

      // Collect all files touched across the plan
      const allTouchedFiles = [...new Set(
        stepResults.flatMap(r => r.stepChanges.map(c => c.file))
      )];

      // Mark todos as completed/pending based on results
      const finalTodos = plan.steps.map((s, idx) => ({
        content: s.action,
        status: idx < stepResults.length && stepResults[idx].verification.passed
          ? "completed"
          : "pending",
        activeForm: s.action.split(" ").slice(0, 4).join(" ") + "...",
      }));
      mergeState(projectId, { todos: finalTodos });

      // Persist final plan status to disk
      if (runState.planId) {
        const finalStatus = allPassed && typeCheckPassed ? "completed" : "failed";
        completePlan(projectId, runState.planId, finalStatus);
      }

      this.onEvent(projectId, {
        event: "orchestration_complete",
        data: {
          summary: plan.summary,
          totalSteps: plan.steps.length,
          completedSteps: stepResults.filter(r => r.verification.passed).length,
          allPassed,
          typeCheckPassed,
          typeCheckOutput: typeCheckResult?.output || null,
          touchedFiles: allTouchedFiles,
          results: stepResults.map(r => ({
            index: r.step.index,
            action: r.step.action,
            passed: r.verification.passed,
            reason: r.verification.reason,
            scopeViolations: r.verification.scopeViolations,
            changedFiles: [...new Set(r.stepChanges.map(c => c.file))],
          })),
        },
      }, request.requestId);

    } catch (err) {
      console.error("[task-runner] Run failed:", err.message);
      this.onEvent(projectId, {
        event: "orchestration_error",
        data: { message: err.message },
      }, request.requestId);
    } finally {
      this.activeRuns.delete(projectId);
    }
  }

  abort(projectId) {
    const run = this.activeRuns.get(projectId);
    if (run) {
      run.aborted = true;
    }
  }

  isRunning(projectId) {
    return this.activeRuns.has(projectId);
  }

  getProgress(projectId) {
    const run = this.activeRuns.get(projectId);
    if (!run) return null;
    return {
      plan: run.plan,
      currentStep: run.currentStep,
      totalSteps: run.plan?.steps?.length || 0,
    };
  }
}
