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
// JSON extraction — models sometimes wrap JSON in markdown despite instructions
// ---------------------------------------------------------------------------

/**
 * Extract the first complete JSON object from a string that may contain
 * markdown code fences, prose preamble, or other non-JSON content.
 * @param {string} raw
 * @returns {string}
 */
function extractJson(raw) {
  if (!raw) throw new Error("Empty response from planning call");
  // Strip markdown code fences first (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Find first { ... } block spanning the whole object
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in planning response");
  // Walk to find matching closing brace
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") { depth--; if (depth === 0) return raw.slice(start, i + 1); }
  }
  // No balanced close — return from start to end and let JSON.parse report the error
  return raw.slice(start);
}

/**
 * Distill the last few turns of conversation into plain text for the planning model.
 * Keeps only text content — strips tool calls, tool results, thinking blocks.
 * @param {Array<{type: string, content: any}>} history
 * @returns {string}
 */
function buildConversationContext(history) {
  if (!history || history.length === 0) return "";
  // Take last 8 messages (≈4 turns) — enough context without noise
  const recent = history.slice(-8);
  const lines = [];
  for (const msg of recent) {
    const role = msg.type === "user" ? "User" : msg.type === "assistant" ? "Assistant" : null;
    if (!role) continue;
    // Content may be a string or an array of content blocks
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text || "")
        .join("\n");
    }
    text = text.trim();
    if (text) lines.push(`${role}: ${text.length > 800 ? text.slice(0, 800) + "…" : text}`);
  }
  return lines.join("\n");
}

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

const PLANNING_SYSTEM_PROMPT = `You are writing an execution script for a coding model. This is not a plan or a guide — it is a precise, ordered sequence of instructions that a model will execute one at a time, with no human intervention between steps.

The model executing your script has read_file, write_file, and run_command tools. It has no memory of previous turns. Each step is a complete, self-contained job card.

─── WRITE STEPS — the standard you must meet ───────────────────────────────
Every write step must specify:
  1. Exact file and location — which function, class, block, or line to modify
  2. Exact change — what to insert, replace, or delete (include actual code, signatures, and logic)
  3. Exact reason — one sentence on why, so the model doesn't second-guess the intent

BAD (description):  "Add a find_files tool to TOOL_DEFINITIONS in http-backend.mjs"
GOOD (execution):   "In http-backend.mjs, in the TOOL_DEFINITIONS array, add a new entry with name 'find_files', description 'Find files by name or glob pattern using the brain index', and parameters: pattern (string, required). Handler in tool-executor.mjs should call brainEngine.findFiles(pattern) and return { files: string[] }."

If you have file contents in context — use them. Reference actual function names, actual variable names, actual line positions. Do not invent names you haven't seen.

─── READ STEPS ──────────────────────────────────────────────────────────────
A read step is only valid if its findings are required to write a later step precisely.
State exactly what to extract: "Read X to find the signature of function Y and the shape of type Z — needed by step N."
Never use read steps to 'understand' or 'explore' without a specific extraction goal.

─── OTHER RULES ─────────────────────────────────────────────────────────────
- Never combine read and write in one step.
- The last step must verify: run tsc, run tests, or build — whichever applies.
- Use as many steps as the task requires. Do not compress.
- Steps execute sequentially. Later steps may reference what earlier steps produced.

Step types:
- "read":   Read and extract specific information. No edits.
- "write":  Make a specific, fully-specified code change.
- "verify": Run a command to confirm correctness.
- "plan":   Produce analysis or a decision. No file changes.

Respond with ONLY a JSON object. No markdown, no explanation, no code fences.

{
  "summary": "one-line task description",
  "steps": [
    {
      "index": 1,
      "action": "complete, precise instruction — for write steps this must include exact location and exact code/logic",
      "files": ["path/to/file.ts"],
      "verification": "concrete check — what the model should confirm before marking this step done",
      "type": "read|write|verify|plan"
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Discovery Prompt — alignment conversation before planning
// ---------------------------------------------------------------------------

const DISCOVERY_SYSTEM_PROMPT = `You are a senior engineer on the user's team. The user is about to describe a task they want built. Your job is NOT to start coding — your job is to deeply understand what they want through genuine conversation.

Rules:
- Ask clarifying questions about anything ambiguous or underspecified.
- Challenge assumptions. If their approach has a flaw, say so — respectfully, directly.
- Surface edge cases, trade-offs, or constraints they may not have considered.
- Propose your interpretation of what they want. "If I understand correctly, you want X that does Y because Z."
- Keep it conversational. You're a teammate, not a requirements-gathering bot. Be concise.
- If the task is already crystal clear (specific files, exact changes, no ambiguity), you can align in a single turn.
- Do NOT write any code. Do NOT plan implementation steps. That comes later.

Response format — you MUST respond with valid JSON every turn:

When you have questions or want to discuss:
{
  "message": "Your conversational text here. Ask questions naturally, challenge ideas, propose alternatives.",
  "aligned": false
}

When you and the user are fully aligned and you're ready to proceed:
{
  "message": "Brief confirmation of what was agreed.",
  "aligned": true,
  "summary": "A precise, actionable description of the task incorporating everything discussed. This replaces the user's original prompt — it must be complete enough for a planner to decompose into steps without any additional context.",
  "decisions": ["key decision 1 made during discussion", "key decision 2"]
}

Only set aligned: true when the user has explicitly confirmed your understanding. Do not assume alignment.`;

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

  // Task-centric focus
  if (step.files.length > 0) {
    parts.push(`## Files for this step:`);
    for (const f of step.files) parts.push(`- ${f}`);
    parts.push("");
  }
  parts.push(`## Focus:`);
  parts.push(`Stay focused on this step's objective and nothing else. Do not work on other parts of the task, do not make improvements outside what this step requires, do not anticipate future steps.`);
  parts.push("");

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
  parts.push(`## Verification: ${step.verification || "Confirm the change is correct and complete"}`);
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
  // No file changes expected. Confirm the model responded.
  // CLI backend is event-driven and returns messages: [] — treat empty as passed
  // since the backend emits events rather than returning messages synchronously.
  if (step.type === "read" || step.type === "plan") {
    const hasResponse = !messages || messages.length === 0 || messages.some(m => m.role === "assistant");
    return {
      passed: hasResponse,
      reason: "Step completed",
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
   * @param {Function} conversationCall — Multi-turn capable call (no tools).
   *   Signature: (systemPrompt, messages, request) => Promise<string>
   */
  constructor(spawnStep, onEvent, planCall, conversationCall) {
    this.spawnStep = spawnStep;
    this.onEvent = onEvent;
    this.planCall = planCall;
    this.conversationCall = conversationCall;
    this.activeRuns = new Map();       // projectId -> { plan, currentStep, aborted }
    this.discoveryResolvers = new Map(); // projectId -> resolve fn
    this.planApprovalResolvers = new Map(); // projectId -> { resolve, reject }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Discovery Phase — conversational alignment before planning
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run a multi-turn discovery conversation to align on the task before planning.
   * The model asks questions, the user responds, until both sides agree on what
   * to build. Returns the aligned summary that replaces the raw prompt for planning.
   *
   * @param {string} projectId
   * @param {string} prompt — the user's original task description
   * @param {object} request — the request object (model, provider, etc.)
   * @returns {Promise<{ summary: string, decisions: string[] }>}
   */
  async discoveryPhase(projectId, prompt, request) {
    const MAX_TURNS = 10;
    const messages = [
      { role: "user", content: prompt },
    ];

    this.onEvent(projectId, {
      event: "orchestration_discovery_start",
      data: { prompt },
    }, request.requestId);

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Call the model with the full conversation so far
      let rawResponse;
      try {
        rawResponse = await this.conversationCall(
          DISCOVERY_SYSTEM_PROMPT,
          messages,
          request,
        );
      } catch (err) {
        console.error("[task-runner] Discovery call failed:", err.message);
        // Fall back to using the raw prompt
        return { summary: prompt, decisions: [] };
      }

      // Parse the structured JSON response
      let parsed;
      try {
        // Handle responses that might have markdown fencing
        const cleaned = rawResponse
          .replace(/^```json\s*/i, "")
          .replace(/```\s*$/, "")
          .trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // Model didn't produce valid JSON — treat as a question turn with raw text
        parsed = { message: rawResponse, aligned: false };
      }

      // Check if the run was aborted
      const runState = this.activeRuns.get(projectId);
      if (runState?.aborted) {
        return { summary: prompt, decisions: [] };
      }

      // ── ALIGNED: model and user agree, proceed to planning ──────────────
      if (parsed.aligned && parsed.summary) {
        // Emit the final alignment message to the conversation
        this.onEvent(projectId, {
          event: "orchestration_discovery_complete",
          data: {
            message: parsed.message,
            summary: parsed.summary,
            decisions: parsed.decisions || [],
          },
        }, request.requestId);

        return {
          summary: parsed.summary,
          decisions: parsed.decisions || [],
        };
      }

      // ── NOT ALIGNED: model has questions or wants to discuss ─────────────
      messages.push({ role: "assistant", content: rawResponse });

      // Emit the question to the frontend
      this.onEvent(projectId, {
        event: "orchestration_discovery",
        data: {
          message: parsed.message || rawResponse,
          turn: turn + 1,
          maxTurns: MAX_TURNS,
        },
      }, request.requestId);

      // Wait for user response — this Promise resolves when respondToDiscovery() is called
      const userResponse = await new Promise((resolve) => {
        this.discoveryResolvers.set(projectId, resolve);
      });
      this.discoveryResolvers.delete(projectId);

      // Check for skip signal
      if (userResponse === "__SKIP_DISCOVERY__") {
        this.onEvent(projectId, {
          event: "orchestration_discovery_complete",
          data: {
            message: "Skipping alignment — proceeding with original task.",
            summary: prompt,
            decisions: [],
          },
        }, request.requestId);
        return { summary: prompt, decisions: [] };
      }

      // Add user response to conversation and continue the loop
      messages.push({ role: "user", content: userResponse });

      // Emit the user response as a conversation message
      this.onEvent(projectId, {
        event: "orchestration_discovery_response",
        data: { message: userResponse },
      }, request.requestId);
    }

    // Max turns reached — use what we have
    console.warn("[task-runner] Discovery hit max turns without alignment. Using raw prompt.");
    return { summary: prompt, decisions: [] };
  }

  approvePlan(projectId) {
    const resolver = this.planApprovalResolvers.get(projectId);
    if (resolver) resolver.resolve();
    else console.warn(`[task-runner] approvePlan: no pending resolver for ${projectId}`);
  }

  rejectPlan(projectId) {
    const resolver = this.planApprovalResolvers.get(projectId);
    if (resolver) resolver.reject(new Error("Plan rejected by user"));
    else console.warn(`[task-runner] rejectPlan: no pending resolver for ${projectId}`);
  }

  /**
   * Called by IPC when the user responds during discovery.
   * Resolves the pending Promise in discoveryPhase().
   */
  respondToDiscovery(projectId, response) {
    const resolver = this.discoveryResolvers.get(projectId);
    if (resolver) {
      resolver(response);
    } else {
      console.warn(`[task-runner] respondToDiscovery: no pending resolver for ${projectId}`);
    }
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
  async run(projectId, prompt, request, planningRequest, options = {}) {
    const runState = { plan: null, currentStep: 0, aborted: false };
    this.activeRuns.set(projectId, runState);

    try {
      // Emit orchestration start
      this.onEvent(projectId, {
        event: "orchestration_start",
        data: { prompt },
      }, request.requestId);

      // ── PHASE 0: DISCOVERY ─────────────────────────────────────────────
      // Conversational alignment before planning. The model asks questions,
      // challenges assumptions, and proposes its understanding. Only proceeds
      // to planning after the user explicitly confirms alignment.
      const callRequest = planningRequest || request;
      let taskPrompt = prompt;
      let discoveryDecisions = [];

      if (this.conversationCall && !options.skipDiscovery) {
        const discovery = await this.discoveryPhase(projectId, prompt, callRequest);
        taskPrompt = discovery.summary;
        discoveryDecisions = discovery.decisions;

        if (runState.aborted) return;
      }

      // ── PHASE 1: DECOMPOSE ─────────────────────────────────────────────
      const state = readState(projectId);
      const context = compileContext(projectId, "execute", 0);

      // Lock discovery decisions into session state
      if (discoveryDecisions.length > 0) {
        const existingDecisions = state.decisions || [];
        mergeState(projectId, {
          decisions: [
            ...existingDecisions,
            ...discoveryDecisions.map(d => ({ content: d, source: "discovery" })),
          ],
        });
      }

      // Build planning context from the full compiled context — same rich snapshot
      // every execution model gets: brief, brain memories, pre-read files, symbol map,
      // Project DNA, decisions, recent actions, etc.
      const recentConversation = buildConversationContext(request.history || []);
      const userPrompt = [
        `Project working directory: ${request.workingDir}`,
        "",
        context.full,      // everything: project brief, brain memories, pre-read files, decisions, DNA…
        recentConversation ? `Recent conversation:\n${recentConversation}` : "",
        `Task:\n${taskPrompt}`,
      ].filter(Boolean).join("\n");

      this.onEvent(projectId, {
        event: "orchestration_planning_start",
        data: {},
      }, request.requestId);

      // callRequest was already resolved in discovery phase above
      const planningModel = callRequest.model || null;
      const executionModel = request.model || null;

      let plan;
      try {
        const planRaw = await this.planCall(
          PLANNING_SYSTEM_PROMPT,
          userPrompt,
          callRequest,
          (chunk) => {
            this.onEvent(projectId, {
              event: "orchestration_planning_chunk",
              data: { chunk },
            }, request.requestId);
          },
        );
        // Models sometimes wrap JSON in markdown code fences despite instructions.
        // Extract the first {...} block from the response.
        const planJson = extractJson(planRaw);
        plan = JSON.parse(planJson);
      } catch (err) {
        console.error("[task-runner] Planning call failed:", err.message);
        // Surface the failure — emit an error event so the user sees it
        this.onEvent(projectId, {
          event: "orchestration_error",
          data: { message: `Planning failed: ${err.message}` },
        }, request.requestId);
        return;
      }

      // Validate plan
      if (!plan.steps || plan.steps.length === 0) {
        throw new Error("Planning produced empty step list");
      }

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

      // ── PLAN APPROVAL GATE ─────────────────────────────────────────────
      // Pause here and wait for the user to approve the plan.
      // approvePlan() / rejectPlan() resolve or reject this promise.
      try {
        await new Promise((resolve, reject) => {
          this.planApprovalResolvers.set(projectId, { resolve, reject });
        });
      } finally {
        this.planApprovalResolvers.delete(projectId);
      }

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
            // Inject the model's actual findings so subsequent steps have real context,
            // not a placeholder. Cap at 1200 chars to avoid bloating the prompt.
            const findings = prev.modelOutput
              ? prev.modelOutput.slice(0, 1200) + (prev.modelOutput.length > 1200 ? "\n[...truncated]" : "")
              : null;
            handoffLines.push(
              `Step ${prev.step.index} (${prev.step.action.split(" ").slice(0, 5).join(" ")}...):\n` +
              (findings ? findings : "analysis complete — no findings recorded")
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

        // Extract final assistant text for read/plan steps — this becomes
        // the handoff context for subsequent steps.
        let modelOutput = null;
        if (step.type === "read" || step.type === "plan") {
          const assistantMessages = stepMessages.filter(m => m.role === "assistant");
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          if (lastAssistant) {
            if (typeof lastAssistant.content === "string") {
              modelOutput = lastAssistant.content;
            } else if (Array.isArray(lastAssistant.content)) {
              modelOutput = lastAssistant.content
                .filter(b => b.type === "text")
                .map(b => b.text)
                .join("\n")
                .trim();
            }
          }
        }

        stepResults.push({
          step,
          verification,
          stepChanges,
          stepChangeIds,
          modelOutput,
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
