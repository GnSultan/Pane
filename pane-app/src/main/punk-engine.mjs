// Punk Engine layer (main process).
//
// Single internal contract: given {projectId, prompt, intent, profile}, stream back Punk events.
// All routing (plan/execute/explain), profiles, and memory live at this Punk layer.
// Backends plug into Punk, not sit beside it.
// The renderer never sees "CLI vs HTTP".

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { promisify } from "node:util";
import { BrowserWindow, utilityProcess, ipcMain } from "electron";

const execFileAsync = promisify(execFile);

// Enrich PATH for spawned CLIs — mirrors main.mjs and cli-worker.mjs.
// Packaged Electron apps have a minimal PATH; this adds nvm, homebrew, etc.
function getEnvWithPath() {
  const home = os.homedir();
  const nvmBins = [];
  try {
    for (const v of readdirSync(path.join(home, ".nvm", "versions", "node"))) {
      nvmBins.push(path.join(home, ".nvm", "versions", "node", v, "bin"));
    }
  } catch {}
  const extra = [...nvmBins, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  const existing = process.env.PATH || "";
  const combined = [...extra, ...existing.split(":")].filter(Boolean).join(":");
  return { ...process.env, PATH: combined };
}

const STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of silence = stalled

/**
 * Run a CLI command and return its stdout as a string.
 * Kills the process only if it produces no output for STALL_TIMEOUT_MS.
 * Active output continuously resets the timer — a long but busy response never times out.
 *
 * Pass options.stdin to write a string to the process's stdin and close it.
 * This avoids shell argument length limits for large prompts.
 */
function spawnWithStallTimeout(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      stdio: options.stdin != null ? ["pipe", "pipe", "pipe"] : undefined,
    });

    let stdout = "";
    let stderr = "";
    let stallTimer = null;

    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        child.kill();
        reject(new Error(`Process stalled — no output for ${STALL_TIMEOUT_MS / 60000} minutes`));
      }, STALL_TIMEOUT_MS);
    };

    resetStall();

    // Write prompt via stdin and close it — avoids OS arg length limits
    if (options.stdin != null) {
      child.stdin.write(options.stdin, "utf8");
      child.stdin.end();
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      resetStall();
      if (options.onChunk) options.onChunk(text);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      resetStall();
    });

    child.on("error", (err) => {
      clearTimeout(stallTimer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(stallTimer);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
import { HttpBackend } from "./http-backend.mjs";

// ── Planning phase system prompt ───────────────────────────────────────────
// Injected for the planning spawn. The model's only job is to call Plan once.
const DISCOVERY_AND_PLANNING_SYSTEM_PROMPT = `You are the thinking model for Pane's orchestration engine. The task boundaries aren't fully clear yet — your job is to explore, understand, and then plan.

Phase 1 — Discovery:
- Use read_file, list_directory, glob, and grep_search to explore the codebase
- Understand the existing architecture, patterns, and conventions before deciding anything
- If the user's request is ambiguous, ask clarifying questions — this is a conversation, not a one-shot
- Surface trade-offs, edge cases, or constraints the user may not have considered
- Do NOT start coding or writing files — discovery is read-only

Phase 2 — Planning:
- Once you understand the full scope, call the Plan tool EXACTLY ONCE
- Each step must be fully specified: exact file, exact change, exact location
- The final step must always be a verify step (tsc, tests, or build command)
- Your plan should reflect everything you learned during discovery

Rules:
- Explore thoroughly before planning — do not guess at file names or structure
- If something is unclear, ask. Better to clarify now than replan later.
- After calling Plan, your turn is complete — do not continue`;

const PLANNING_PHASE_SYSTEM_PROMPT = `You are the planning model for Pane's orchestration engine.

Your ONLY job is:
1. Use read_file, list_directory, glob, and grep_search to gather the context you need
2. Call the Plan tool EXACTLY ONCE with a precise, structured implementation plan

Rules:
- Explore the codebase thoroughly before planning — do not guess at file names or structure
- Each step must be fully specified: exact file, exact change, exact location
- The final step must always be a verify step (tsc, tests, or build command)
- Do NOT write any code — execution happens after the user approves the plan
- After calling Plan, your turn is complete — do not continue`;
import { PunkBackend } from "./punk-backend.mjs";
import { modelManager } from "./model-manager.mjs";
import { TaskRunner } from "./task-runner.mjs";
import { readState } from "./session-context.mjs";
import { routingStore } from "./routing-store.mjs";
import { consult as oracleConsult, classifyDomain } from "./routing-oracle.mjs";
import { ensurePriors } from "./benchmark-scout.mjs";
import { classify as localClassify, isReady as localIntelReady, load as localIntelLoad } from "./local-intelligence.mjs";

// Node.js globals for utility process
const { AbortController, fetch, TextDecoder, setImmediate, console } =
  globalThis;

const __dirname = import.meta.dirname;

// ============================================================================
// Default Intent Routing Config
// ============================================================================

const DEFAULT_INTENT_ROUTING = {
  "gemini-cli": {
    plan: { provider: "gemini", model: "auto-gemini-3", thinking: false },
    execute: { provider: "gemini", model: "auto-gemini-3", thinking: false },
    explain: { provider: "gemini", model: "auto-gemini-3", thinking: false },
    other: { provider: "gemini", model: "auto-gemini-3", thinking: false },
  },
  "claude-cli": {
    plan: { provider: "anthropic", model: "opus", thinking: false },
    execute: { provider: "anthropic", model: "sonnet", thinking: false },
    explain: { provider: "anthropic", model: "sonnet", thinking: false },
    other: { provider: "anthropic", model: "sonnet", thinking: false },
  },
  http: {
    plan: {
      provider: "openrouter",
      model: "stepfun/step-3.5-flash:free",
      thinking: true,
    },
    execute: {
      provider: "openrouter",
      model: "stepfun/step-3.5-flash:free",
      thinking: true,
    },
    explain: {
      provider: "openrouter",
      model: "stepfun/step-3.5-flash:free",
      thinking: true,
    },
    other: {
      provider: "openrouter",
      model: "stepfun/step-3.5-flash:free",
      thinking: true,
    },
  },
};

// ============================================================================
// Backend Abstraction
// ============================================================================

/**
 * @typedef {Object} PunkRequest
 * @property {string} projectId
 * @property {string} prompt
 * @property {string} workingDir
 * @property {string|null} sessionId
 * @property {string|null} model
 * @property {string} [requestId]       - Unique request ID to prevent event leakage
 * @property {string|null} [provider]   - Provider override from intent routing
 * @property {'plan'|'execute'|'explain'|'other'|null} [intent] - Classified intent
 * @property {boolean} [thinking]       - Whether to enable thinking/reasoning mode
 * @property {Array<any>} [history]      - Conversation history
 * @property {string|null} [profile]    - Future: explicit profile override
 * @property {Array<{content: string, status: string, activeForm?: string}>} [todos] - Current todos from conversation state
 */

/**
 * @typedef {Object} PunkEvent
 * @property {string} event - "message" | "processStarted" | "processEnded" | "error" | "routing"
 * @property {any} data
 * @property {string} [requestId] - Associated request ID
 */

/**
 * @callback EventCallback
 * @param {string} projectId
 * @param {PunkEvent} event
 * @param {string} [requestId]
 * @returns {void}
 */

// ============================================================================
// CLI Backend (wraps existing cli-worker.mjs)
// ============================================================================

class CliBackend extends PunkBackend {
  constructor(onEvent, command) {
    super(onEvent);
    this.worker = null;
    this.command = command;
    this.activeRequests = new Map(); // requestId -> projectId
  }

  getWorker() {
    if (this.worker && !this.worker.killed) return this.worker;

    const workerPath = path.join(__dirname, "cli-worker.mjs");
    this.worker = utilityProcess.fork(workerPath, [], {
      serviceData: { command: this.command },
    });

    this.worker.on("message", (message) => {
      if (message.type !== "event") return;
      if (message.event.event === "processEnded") {
        this.activeRequests.delete(message.requestId);
      }
      this.onEvent(message.projectId, message.event, message.requestId);
    });

    this.worker.on("exit", (code) => {
      console.warn(
        `[punk] CLI worker for ${this.command} exited with code ${code}`,
      );
      for (const [requestId, projectId] of this.activeRequests.entries()) {
        this.onEvent(
          projectId,
          {
            event: "processEnded",
            data: { exit_code: null },
          },
          requestId,
        );
      }
      this.activeRequests.clear();
      this.worker = null;
    });

    return this.worker;
  }

  async spawn(request) {
    const worker = this.getWorker();
    this.activeRequests.set(request.requestId, request.projectId);
    worker.postMessage({
      type: "spawn",
      projectId: request.projectId,
      prompt: request.prompt,
      workingDir: request.workingDir,
      sessionId: request.sessionId,
      model: request.model,
      intent: request.intent,
      history: request.history,
      command: this.command,
      requestId: request.requestId,
      todos: request.todos,
    });
  }

  async abort(projectId) {
    if (this.worker && !this.worker.killed) {
      this.worker.postMessage({ type: "abort", projectId });
    }
    // Clean up all requests for this project
    for (const [rid, pid] of this.activeRequests.entries()) {
      if (pid === projectId) this.activeRequests.delete(rid);
    }
  }

  async terminate(projectId) {
    if (this.worker && !this.worker.killed) {
      this.worker.postMessage({ type: "terminate", projectId });
    }
    // Clean up all requests for this project
    for (const [rid, pid] of this.activeRequests.entries()) {
      if (pid === projectId) this.activeRequests.delete(rid);
    }
  }

  async shutdown() {
    if (this.worker && !this.worker.killed) {
      this.worker.postMessage({ type: "shutdown" });
      this.worker.kill();
      this.worker = null;
    }
    this.activeRequests.clear();
  }

  /**
   * Execute a single orchestration step through the CLI backend.
   * The system override is folded into the user prompt since we can't
   * inject an arbitrary system prompt into the Claude/Gemini CLI binary.
   * A fresh sessionId ensures no prior conversation history bleeds in.
   */
  async spawnStep(projectId, prompt, systemOverride, request) {
    const stepRequestId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Fold the system override into the user message as preamble context.
    // The CLI binary controls its own system prompt, but the model will
    // still follow grounded instructions prepended to the user turn.
    const stepPrompt = systemOverride
      ? `[Step context — follow these instructions precisely]\n${systemOverride}\n\n[Your task]\n${prompt}`
      : prompt;

    const stepRequest = {
      ...request,
      projectId,
      prompt: stepPrompt,
      requestId: stepRequestId,
      sessionId: null, // fresh session — no conversation history
      history: [],     // belt-and-suspenders: no history
    };

    await this.spawn(stepRequest);
    // CLI backend is event-driven; messages are emitted via onEvent, not returned.
    // Verification in TaskRunner falls back to change-history grounding (no message scan needed).
    return { messages: [] };
  }

  /**
   * Make a lightweight planning call using the CLI's --print / non-interactive mode.
   * `claude --print` and `gemini --prompt` both return text and exit immediately —
   * no session, no tools, no streaming. Perfect for task decomposition.
   *
   * Falls back to HTTP backend if the CLI call fails (e.g. binary not found).
   */
  async planningCall(systemPrompt, userPrompt, request, onChunk) {
    const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;

    if (this.command === "claude") {
      const args = ["--print"];
      if (request.model) args.push("--model", request.model);
      const stdout = await spawnWithStallTimeout("claude", args, {
        stdin: combinedPrompt,
        onChunk,
        env: getEnvWithPath(),
      });
      return stdout.trim();
    }

    if (this.command === "gemini") {
      const args = ["--prompt", "-"];
      if (request.model && /gemini/i.test(request.model)) {
        args.push("--model", request.model);
      }
      const stdout = await spawnWithStallTimeout("gemini", args, { stdin: combinedPrompt, onChunk, env: getEnvWithPath() });
      return stdout.trim();
    }

    throw new Error(`Unknown CLI command: ${this.command}`);
  }

  /**
   * Multi-turn conversation call for the discovery phase.
   * Flattens the message array into a single prompt since CLI --print mode
   * is stateless (no session between invocations). Each discovery turn
   * is a fresh CLI call with full history embedded.
   *
   * Contract: returns raw text string (task-runner parses JSON from it).
   */
  async conversationCall(systemPrompt, messages, request) {
    // Flatten multi-turn messages into a single prompt for stateless CLI
    const parts = [systemPrompt, "\n---\nConversation so far:\n"];
    for (const msg of messages) {
      const role = msg.role === "user" ? "User" : "Assistant";
      parts.push(`${role}: ${msg.content}\n`);
    }
    parts.push("\nRespond now as the assistant. You MUST respond with valid JSON only, no markdown fencing.");
    const combinedPrompt = parts.join("\n");

    if (this.command === "claude") {
      const args = ["--print"];
      if (request.model) args.push("--model", request.model);
      const stdout = await spawnWithStallTimeout("claude", args, {
        stdin: combinedPrompt,
        env: getEnvWithPath(),
      });
      return stdout.trim();
    }

    if (this.command === "gemini") {
      const args = ["--prompt", "-"];
      if (request.model && /gemini/i.test(request.model)) {
        args.push("--model", request.model);
      }
      const stdout = await spawnWithStallTimeout("gemini", args, { stdin: combinedPrompt, env: getEnvWithPath() });
      return stdout.trim();
    }

    throw new Error(`Unknown CLI command: ${this.command}`);
  }
}

// ============================================================================
// Punk Engine Core
// ============================================================================

class PunkEngine {
  constructor() {
    this.backend = null;
    this.relayQueue = [];
    this.relayDraining = false;
    this.taskRunner = null;
    this._brainSearch = null; // injected by main.mjs — calls brain_contextual_search
    // Outcome tracking: requestId → { outcomeId, startTime, taskType, domain, projectId, pendingTodoCount, responseLength, hadToolErrors }
    this._activeOutcomes = new Map();
    // Per-project last completed outcome — used for retrospective scoring
    // when the next message reveals whether the previous response was good
    this._projectLastOutcome = new Map(); // projectId → { outcomeId, pendingTodoCount }
    // Plan approval gate — resolvers keyed by projectId
    // Shared with HttpBackend so the Plan tool intercept can block until the user approves
    this.planApprovalResolvers = new Map();
  }

  approvePlan(projectId) {
    const resolver = this.planApprovalResolvers.get(projectId);
    if (resolver) resolver.resolve();
    else console.warn(`[punk] approvePlan: no pending resolver for ${projectId}`);
  }

  rejectPlan(projectId) {
    const resolver = this.planApprovalResolvers.get(projectId);
    if (resolver) resolver.reject(new Error("Plan rejected by user"));
    else console.warn(`[punk] rejectPlan: no pending resolver for ${projectId}`);
  }

  /**
   * Inject brain contextual search function from main.mjs.
   * Signature: (args) => Promise<result> where args = { projectId, query, taskType, atomHints, projectRoot, intent }
   */
  setBrainSearch(fn) {
    this._brainSearch = fn;
  }

  async initialize(backendOverride) {
    if (this.backend) return;

    let backendType;
    if (backendOverride) {
      backendType = backendOverride;
    } else {
      const settings = await this.loadSettings();
      backendType = settings.punk_backend || "http";
    }

    const onEvent = (projectId, event, requestId) =>
      this.handleBackendEvent(projectId, event, requestId);

    switch (backendType) {
      case "cli": // old value
      case "claude-cli":
        this.backend = new CliBackend(onEvent, "claude");
        break;
      case "gemini-cli":
        this.backend = new CliBackend(onEvent, "gemini");
        break;
      case "http":
        this.backend = new HttpBackend(onEvent);
        // Inject shared approval resolvers — Plan tool in http-backend blocks on these
        this.backend.planApprovalResolvers = this.planApprovalResolvers;
        break;
      default:
        throw new Error(`Unknown backend type: ${backendType}`);
    }

    // Initialize TaskRunner for ALL backends — orchestration is Pane's layer,
    // not the backend's. Both planning and execution route through whatever
    // backend is active (CLI or HTTP). CLI backends use --print mode for
    // planning (non-interactive, text-only, no tools).
    this.taskRunner = new TaskRunner(
      // spawnStep: execute a single step through the active backend
      (projectId, prompt, systemOverride, request) =>
        this.backend.spawnStep(projectId, prompt, systemOverride, request),
      // onEvent: relay events to renderer
      onEvent,
    );

    // Seed benchmark priors (no-op after first run, refreshes weekly)
    ensurePriors().catch(err =>
      console.warn("[punk] benchmark-scout failed (non-fatal):", err.message)
    );
  }

  async reinitialize(backendOverride) {
    if (this.backend) {
      await this.backend.shutdown().catch(() => {});
      this.backend = null;
    }
    await this.initialize(backendOverride);
  }

  async loadSettings() {
    try {
      const content = await fs.readFile(
        path.join(os.homedir(), ".pane", "settings.json"),
        "utf-8",
      );
      return JSON.parse(content);
    } catch {
      return { punk_backend: "http", selected_model: null };
    }
  }

  async loadIntentRouting() {
    try {
      const content = await fs.readFile(
        path.join(os.homedir(), ".pane", "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);
      const backend = settings.punk_backend || "http";

      if (settings.intent_routing && settings.intent_routing[backend]) {
        // Strict mapping: follow user settings for this SPECIFIC backend
        return settings.intent_routing[backend];
      }
    } catch {}

    // Last-resort fallback to default mapping for the active backend
    const settings = await this.loadSettings();
    const backend = settings.punk_backend || "http";
    return DEFAULT_INTENT_ROUTING[backend] || DEFAULT_INTENT_ROUTING["http"];
  }

  async loadIntentAutoRoute() {
    try {
      const content = await fs.readFile(
        path.join(os.homedir(), ".pane", "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);
      if (settings.intent_auto_route !== undefined) {
        return settings.intent_auto_route;
      }
    } catch {}
    return true; // default to auto-route enabled
  }

  handleBackendEvent(projectId, event, requestId) {
    const channel = `punk-stream:${projectId}`;

    // Attach requestId to the event so the renderer can filter it
    const enrichedEvent = { ...event, requestId };

    // ── Outcome signal capture ─────────────────────────────────────────────
    // Passively accumulate signals from the event stream. No blocking I/O.
    if (requestId && this._activeOutcomes.has(requestId)) {
      const tracked = this._activeOutcomes.get(requestId);

      // Accumulate response text length
      if (event.event === "message" && event.data?.parsed?.type === "stream_event") {
        const delta = event.data.parsed.data?.delta;
        if (delta?.type === "text_delta" && delta.text) {
          tracked.responseLength += delta.text.length;
        }
      }

      // Track tool errors
      if (event.event === "message" && event.data?.parsed?.type === "tool_error") {
        tracked.hadToolErrors = true;
      }

      // Close the outcome on processEnded
      if (event.event === "processEnded") {
        const elapsed = Date.now() - tracked.startTime;
        try {
          routingStore.updateOutcome(tracked.outcomeId, {
            responseLength: tracked.responseLength,
            hadToolErrors:  tracked.hadToolErrors,
            responseTimeMs: elapsed,
            taskType:       tracked.taskType,
            domain:         tracked.domain,
          });
        } catch (err) {
          console.warn("[punk] outcome update failed (non-fatal):", err.message);
        }
        // Save for retrospective scoring on the next spawn from this project
        if (tracked.projectId) {
          this._projectLastOutcome.set(tracked.projectId, {
            outcomeId:        tracked.outcomeId,
            pendingTodoCount: tracked.pendingTodoCount,
          });
        }
        this._activeOutcomes.delete(requestId);
      }
    }

    // Queue everything — including terminal events — and drain via setImmediate.
    // The old pattern of flushing the entire queue synchronously on processEnded
    // caused a burst of webContents.send calls that froze the renderer with CLI
    // backends, which can produce many events locally before the process exits.
    this.relayQueue.push({ channel, event: enrichedEvent });
    this.drainRelayQueue();
  }

  sendToRenderer(channel, event) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }
  }

  drainRelayQueue() {
    if (this.relayDraining) return;
    this.relayDraining = true;

    // Process up to BATCH_SIZE events per setImmediate tick.
    // One-per-tick was correct for preventing synchronous dumps, but during
    // a burst (e.g. context compaction outputting hundreds of lines at once)
    // it creates hundreds of pending setImmediate callbacks, each calling
    // webContents.send() in isolation. Batching reduces the number of
    // scheduled callbacks while still yielding to I/O between batches.
    const BATCH_SIZE = 16;

    const drain = () => {
      if (this.relayQueue.length === 0) {
        this.relayDraining = false;
        return;
      }
      let sent = 0;
      while (this.relayQueue.length > 0 && sent < BATCH_SIZE) {
        const { channel, event } = this.relayQueue.shift();
        this.sendToRenderer(channel, event);
        sent++;
      }
      if (this.relayQueue.length > 0) setImmediate(drain);
      else this.relayDraining = false;
    };

    setImmediate(drain);
  }

  flushRelayQueue() {
    while (this.relayQueue.length > 0) {
      const { channel, event } = this.relayQueue.shift();
      this.sendToRenderer(channel, event);
    }
    this.relayDraining = false;
  }

  // ── Retrospective scoring ────────────────────────────────────────────────
  // Called at the start of each new spawn. Looks at the new message and the
  // current todo state to retroactively score the previous interaction —
  // before it gets replaced by the new one.
  _applyRetrospective(projectId, newPrompt, newTodos) {
    const last = this._projectLastOutcome.get(projectId);
    if (!last) return;
    this._projectLastOutcome.delete(projectId); // only retrospect once

    const text = (newPrompt || "").toLowerCase().trim();
    let delta = 0;

    // Correction signal — user is pushing back on the previous response
    if (/^(no[,. ]|that'?s (not|wrong)|wait[,. ]|actually[,. ]|wrong[,. ]|not quite|that didn'?t|it still |still not |didn'?t work|that'?s not right|not what i)/.test(text)) {
      delta -= 0.25;
      console.log(`[oracle] retro: correction detected → -0.25 on outcome ${last.outcomeId}`);
    }

    // Todo completion signal — tasks completed since the last interaction
    const nowPending = (newTodos || []).filter(t => t.status !== "completed").length;
    if (last.pendingTodoCount > 0 && nowPending < last.pendingTodoCount) {
      const rate  = (last.pendingTodoCount - nowPending) / last.pendingTodoCount;
      const boost = +(0.20 * rate).toFixed(3);
      delta += boost;
      console.log(`[oracle] retro: ${last.pendingTodoCount - nowPending} todos completed → +${boost} on outcome ${last.outcomeId}`);
    }

    if (delta !== 0) {
      try {
        routingStore.adjustOutcomeScore(last.outcomeId, delta);
      } catch (err) {
        console.warn("[oracle] retro adjustment failed (non-fatal):", err.message);
      }
    }
  }

  async spawn(request) {
    if (!this.backend) await this.initialize();

    let resolvedRequest = { ...request };

    // Retrospective: score the previous interaction before it's replaced
    this._applyRetrospective(
      resolvedRequest.projectId,
      resolvedRequest.prompt,
      resolvedRequest.todos,
    );

    // ── INTELLIGENCE ──────────────────────────────────────────────────────
    // Qwen local model is the sole classifier — strategy + task type + context
    // shape in a single ~50-100ms inference pass. No heuristic fallback.
    //
    // Explicit slash commands (/plan, /direct, /discuss, /exec, /orchestrate)
    // bypass classification — they're user overrides, resolved inline.
    const sessionState = readState(resolvedRequest.projectId);
    const promptText = (resolvedRequest.prompt || "").trim().toLowerCase();
    const hasSlashOverride = /^\/(?:plan|direct|raw|discuss|chat|orchestrate|steps|exec)\b/.test(promptText);

    const pendingTodos = (resolvedRequest.todos || []).filter(t => t.status !== "completed").length;

    let localDecision = null;
    let strategy;

    if (hasSlashOverride) {
      // ── Slash overrides — user knows what they want ──
      const slashStrategies = {
        direct:      { mode: "direct",      discovery: false, reasoning: "shallow", verification: "none" },
        raw:         { mode: "direct",      discovery: false, reasoning: "shallow", verification: "none" },
        exec:        { mode: "direct",      discovery: false, reasoning: "shallow", verification: "none" },
        discuss:     { mode: "discuss",     discovery: false, reasoning: "deep",    verification: "none" },
        chat:        { mode: "discuss",     discovery: false, reasoning: "deep",    verification: "none" },
        orchestrate: { mode: "orchestrate", discovery: true,  reasoning: "deep",    verification: "diff" },
        steps:       { mode: "orchestrate", discovery: true,  reasoning: "deep",    verification: "diff" },
        plan:        { mode: "orchestrate", discovery: false, reasoning: "deep",    verification: "diff" },
      };
      const cmd = promptText.match(/^\/([\w]+)/)?.[1] || "direct";
      const override = slashStrategies[cmd] || slashStrategies.direct;
      strategy = { ...override, confidence: 1.0, reason: `/${cmd}`, signals: [] };
      console.log(`[punk] slash override → ${strategy.mode} (/${cmd})`);
    } else {
      // ── Qwen classification — wait for readiness if needed ──
      if (!localIntelReady()) {
        console.log("[punk] waiting for local-intel to load...");
        await localIntelLoad();
      }

      localDecision = await localClassify({
        message:        resolvedRequest.prompt?.slice(0, 300) ?? "",
        turnCount:      (resolvedRequest.history || []).length,
        hasActiveTask:  !!sessionState?.activeTask,
        workingSetSize: (sessionState?.workingSet || []).length,
        pendingTodos,
      });

      if (localDecision) {
        console.log(
          `[punk] local-intel: mode=${localDecision.mode} type=${localDecision.taskType} ` +
          `complexity=${localDecision.complexity} frontier=${localDecision.preferFrontier} ` +
          `discovery=${localDecision.discovery} hints=[${localDecision.atomHints.join(",")}]`,
        );
        strategy = {
          mode:         localDecision.mode,
          discovery:    localDecision.discovery,
          reasoning:    localDecision.reasoning,
          verification: localDecision.verification,
          confidence:   0.90,
          reason:       `local-intel: ${localDecision.taskType}/${localDecision.complexity}`,
          signals:      [],
        };
      } else {
        console.warn("[punk] local-intel returned null — model not ready, falling back to execute");
        strategy = { mode: "direct", discovery: false, reasoning: "shallow", verification: "none", confidence: 0.5, reason: "local-intel unavailable", signals: [] };
      }
    }

    // ── SMART ROUTING ─────────────────────────────────────────────────────
    const [autoRoute, routing] = await Promise.all([
      this.loadIntentAutoRoute(),
      this.loadIntentRouting(),
    ]);

    // Map strategy mode to routing intent slot.
    // Orchestrate mode uses "execute" for resolvedRequest — the execute-phase model.
    // planningRequest independently reads routing["plan"] for the planning model.
    // This ensures direct spawn (orchestration disabled or fallback) uses the execute model.
    let intentSlot =
      strategy.mode === "discuss" ? "explain" : "execute";

    // When the model says this is high-complexity frontier-worthy, route to plan model
    // Qwen complexity-based intent adjustment
    if (localDecision) {
      if (localDecision.complexity === "high" && localDecision.preferFrontier && intentSlot === "execute") {
        intentSlot = "plan";
        console.log("[punk] local-intel promoted intent: execute → plan (high complexity + frontier)");
      }
      if (localDecision.complexity === "low" && !localDecision.preferFrontier && intentSlot === "plan") {
        intentSlot = "explain";
        console.log("[punk] local-intel demoted intent: plan → explain (low complexity)");
      }
    }

    if (!resolvedRequest.intent) resolvedRequest.intent = intentSlot;

    const intentRoute = routing[intentSlot] || routing["execute"];

    if (autoRoute) {
      resolvedRequest.provider = intentRoute.provider;
      resolvedRequest.model    = intentRoute.model;
      resolvedRequest.thinking = intentRoute.thinking ?? false;
    } else if (!resolvedRequest.model) {
      resolvedRequest.provider = intentRoute.provider;
      resolvedRequest.model    = intentRoute.model;
      resolvedRequest.thinking = intentRoute.thinking ?? false;
    }

    // Force openrouter for slash-namespaced models
    if (resolvedRequest.model?.includes("/") && resolvedRequest.provider !== "openrouter") {
      resolvedRequest.provider = "openrouter";
    }

    // ── ORACLE ────────────────────────────────────────────────────────────
    // Consult routing-store + benchmark priors for a data-driven model pick.
    // Only fires when smart routing is on and the request doesn't override.
    // Overrides the heuristic selection when oracle confidence is sufficient.
    //
    // Domain classification from Qwen's taskType (slash overrides fall back to prompt regex)
    const domain = localDecision
      ? _taskTypeToDomain(localDecision.taskType)
      : classifyDomain(resolvedRequest.prompt ?? "");
    let oracleResult = null;

    if (autoRoute && !resolvedRequest._systemOverride) {
      // Candidates = all unique models the user has configured
      const candidates = Object.values(routing)
        .filter(r => r?.model && r?.provider)
        .map(r => ({ model: r.model, provider: r.provider }))
        .filter((c, i, arr) =>
          i === arr.findIndex(x => x.model === c.model && x.provider === c.provider)
        );

      oracleResult = oracleConsult(strategy.mode, domain, candidates);

      if (oracleResult) {
        resolvedRequest.provider = oracleResult.top.provider;
        resolvedRequest.model    = oracleResult.top.model;
        // Keep thinking flag from strategy — oracle doesn't override reasoning mode
        console.log(
          `[oracle] → ${oracleResult.top.provider}/${oracleResult.top.model} ` +
          `(score=${oracleResult.score?.toFixed(2)}, conf=${oracleResult.confidence.toFixed(2)}, ` +
          `samples=${oracleResult.sampleCount}, exploring=${oracleResult.exploring})`
        );
      }
    }

    // Emit strategy event — carries routing info + full strategy vector
    this.handleBackendEvent(
      request.projectId,
      {
        event: "strategy",
        data: {
          // strategy vector
          mode:         strategy.mode,
          discovery:    strategy.discovery,
          reasoning:    strategy.reasoning,
          verification: strategy.verification,
          confidence:   strategy.confidence,
          reason:       strategy.reason,
          signals:      strategy.signals,
          // routing fields (used by UI model display)
          intent:       resolvedRequest.intent,
          provider:     resolvedRequest.provider,
          model:        resolvedRequest.model,
          thinking:     resolvedRequest.thinking ?? false,
          // oracle metadata
          oracleUsed:       !!oracleResult,
          oracleConfidence: oracleResult?.confidence ?? null,
          oracleExploring:  oracleResult?.exploring  ?? false,
          // local intelligence metadata
          localTaskType:    localDecision?.taskType ?? null,
          localComplexity:  localDecision?.complexity ?? null,
          localAtomHints:   localDecision?.atomHints ?? [],
        },
      },
      request.requestId,
    );

    console.log(
      `[punk] strategy=${strategy.mode} (${(strategy.confidence * 100).toFixed(0)}%) ` +
      `discovery=${strategy.discovery} → ${resolvedRequest.provider}/${resolvedRequest.model} | ${strategy.reason}`,
    );

    // Write local decision to context dir so session-context.mjs can read it.
    // Drives: system prompt directive, atom boosting, file pre-read depth,
    // brief inclusion, and verification instructions.
    if (localDecision && resolvedRequest.projectId) {
      try {
        const contextDir = path.join(os.homedir(), ".pane", "brain", "context");
        await fs.mkdir(contextDir, { recursive: true }).catch(() => {});
        await fs.writeFile(
          path.join(contextDir, `${resolvedRequest.projectId}-shape.json`),
          JSON.stringify(localDecision),
          "utf-8",
        );
      } catch {
        // Non-fatal — context shaping falls back to defaults
      }
    }

    // ── BRAIN CONTEXTUAL SEARCH ───────────────────────────────────────────
    // Query the brain's knowledge graph with the user's prompt + routing
    // context. Brain writes scored atoms, relevant files, and synthesis to
    // ~/.pane/brain/context/{projectId}.json — which compileContext() reads
    // synchronously in the backend workers. Must complete BEFORE delegation.
    //
    // 3s timeout: brain search is fast (~100-500ms) but we can't let it
    // block the response indefinitely. compileContext reads stale/empty
    // context gracefully when this times out.
    if (this._brainSearch && resolvedRequest.projectId) {
      try {
        const searchTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("brain search timeout")), 3000),
        );
        await Promise.race([
          this._brainSearch({
            projectId:   resolvedRequest.projectId,
            query:       resolvedRequest.prompt?.slice(0, 1000) ?? "",
            taskType:    localDecision?.taskType ?? strategy.mode,
            atomHints:   localDecision?.atomHints ?? [],
            projectRoot: resolvedRequest.workingDir ?? null,
            intent:      resolvedRequest.intent ?? null,
          }),
          searchTimeout,
        ]);
      } catch (err) {
        console.warn("[punk] brain contextual search failed (non-fatal):", err.message);
      }
    }

    // ── OUTCOME TRACKING ──────────────────────────────────────────────────
    // Record the routing decision before execution. Signals are filled in
    // when processEnded fires via handleBackendEvent().
    if (request.requestId) {
      try {
        const outcomeId = routingStore.recordOutcome({
          requestId:           request.requestId,
          projectId:           resolvedRequest.projectId,
          taskType:            strategy.mode,
          domain,
          model:               resolvedRequest.model,
          provider:            resolvedRequest.provider,
          routingConfidence: strategy.confidence,
          oracleUsed:          !!oracleResult,
          oracleConfidence:    oracleResult?.confidence ?? null,
          promptLength:        (resolvedRequest.prompt ?? "").length,
          explored:            oracleResult?.exploring ?? false,
        });
        this._activeOutcomes.set(request.requestId, {
          outcomeId,
          startTime:        Date.now(),
          taskType:         strategy.mode,
          domain,
          projectId:        resolvedRequest.projectId,
          pendingTodoCount: (resolvedRequest.todos || []).filter(t => t.status !== "completed").length,
          responseLength:   0,
          hadToolErrors:    false,
        });
      } catch (err) {
        console.warn("[punk] outcome record failed (non-fatal):", err.message);
      }
    }

    // ── CONTROL INVERSION CHECK ───────────────────────────────────────────
    // Strategy engine drives orchestration — Qwen's mode decision is the gate.
    if (this.taskRunner && !resolvedRequest._systemOverride) {
      let orchestrationEnabled = true;
      try {
        const settings = await this.loadSettings();
        orchestrationEnabled = settings.orchestration_enabled ?? true;
      } catch {}

      if (strategy.mode === "orchestrate" && orchestrationEnabled) {
        console.log(
          `[punk] 🎯 ORCHESTRATING via Plan tool` +
          (strategy.discovery ? " [discovery first]" : " [planning first]"),
        );
        try {
          await this._orchestrate(resolvedRequest, routing, strategy);
        } catch (err) {
          console.error(`[punk] Orchestration failed, falling back to direct:`, err.message);
          await this.backend.spawn(resolvedRequest);
        }
        return;
      }
    }

    try {
      console.log(
        `[punk] spawn attempt: ${resolvedRequest.provider}/${resolvedRequest.model} (thinking=${resolvedRequest.thinking})`,
      );
      await this.backend.spawn(resolvedRequest);
    } catch (err) {
      console.error(`[punk] spawn failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Pane-controlled orchestration: thinking → execution.
   *
   * One thinking model does both discovery AND planning in a single spawn.
   * It explores the codebase, discusses with the user if needed, and calls
   * the Plan tool when it's ready. Same brain, continuous context.
   *
   * After the user approves the plan, a fast builder model executes step by step.
   */
  async _orchestrate(request, routing, strategy) {
    const projectId = request.projectId;

    this.handleBackendEvent(projectId, {
      event: "orchestration_start",
      data: { prompt: request.prompt },
    }, request.requestId);

    // ── THINKING PHASE: discovery + planning in one spawn ─────────────────
    // The reasoning model explores, asks questions, and calls Plan when ready.
    // If discovery is needed, the system prompt tells it to discuss first.
    // Either way, it must call Plan before its turn ends.
    const planRoute = routing["plan"] || routing["execute"];
    const phase = strategy.discovery ? "discovery" : "planning";

    this.handleBackendEvent(projectId, {
      event: "orchestration_phase",
      data: { phase, model: planRoute.model, provider: planRoute.provider },
    }, request.requestId);

    console.log(
      `[punk] thinking phase → ${planRoute.provider}/${planRoute.model}` +
      (strategy.discovery ? " [discovery first]" : " [planning directly]"),
    );

    // Pick the right system prompt based on whether discovery is needed
    const systemPrompt = strategy.discovery
      ? DISCOVERY_AND_PLANNING_SYSTEM_PROMPT
      : PLANNING_PHASE_SYSTEM_PROMPT;

    const planningRequest = {
      ...request,
      phase: "planning",  // tools: reads + Plan (discovery gets same tools)
      provider: planRoute.provider,
      model: planRoute.model,
      thinking: planRoute.thinking ?? false,
      _systemPrepend: systemPrompt,
    };

    // This spawn blocks until: Plan tool is called + user approves (or rejects)
    await this.backend.spawn(planningRequest);

    // Grab the approved plan from the request (set by _handlePlanTool)
    const plan = planningRequest._pendingPlan;
    if (!plan) {
      console.warn("[punk] No plan captured after thinking phase — orchestration aborted.");
      this.handleBackendEvent(projectId, {
        event: "orchestration_error",
        data: { message: "Planning completed without a plan. Try again." },
      }, request.requestId);
      return;
    }

    // Persist plan to disk and get its ID
    const { createPlan } = await import("./plan-store.mjs");
    const { planId } = createPlan(projectId, plan.summary, plan.steps, {
      planning: planningRequest.model,
      execution: request.model,
    });

    // ── EXECUTION PHASE ───────────────────────────────────────────────────
    const execRoute = routing["execute"];
    const executionRequest = {
      ...request,
      phase: "execution",
      provider: execRoute?.provider || request.provider,
      model: execRoute?.model || request.model,
      thinking: execRoute?.thinking ?? request.thinking ?? false,
    };

    this.handleBackendEvent(projectId, {
      event: "orchestration_phase",
      data: { phase: "execution", model: executionRequest.model, provider: executionRequest.provider },
    }, request.requestId);

    console.log(`[punk] execution phase → ${executionRequest.provider}/${executionRequest.model}`);

    await this.taskRunner.executeSteps(projectId, plan, planId, executionRequest);
  }

  async abort(projectId) {
    // Also abort TaskRunner if running
    if (this.taskRunner?.isRunning(projectId)) {
      this.taskRunner.abort(projectId);
    }
    if (this.backend) await this.backend.abort(projectId);
  }

  async terminate(projectId) {
    if (this.backend) await this.backend.terminate(projectId);
  }

  async shutdown() {
    if (this.backend) await this.backend.shutdown();
  }

  async getOpenRouterModels() {
    return await modelManager.refreshModels("openrouter").then(() => modelManager.models["openrouter"] || []);
  }

  /**
   * Simple text generation call routed through the active backend.
   * Uses whatever the user has configured — CLI, HTTP, anything.
   * No tools, no history, no streaming. Just a prompt → text response.
   *
   * This is the single entry point for any Pane-internal generation
   * (commit drafts, summaries, etc.) that should respect user's active config.
   */
  async quickCall(systemPrompt, userPrompt) {
    await this.initialize();
    // Use the routing table's explain slot — lightest model the user has
    // configured for their active backend. Never hardcode a provider here.
    const routing = await this.loadIntentRouting();
    const explainRoute = routing["explain"] || routing["execute"] || {};
    const request = {
      provider: explainRoute.provider || null,
      model:    explainRoute.model    || null,
      thinking: false,
    };
    return this.backend.planningCall(systemPrompt, userPrompt, request);
  }
}

// ============================================================================
// Module Exports (Public API)
// ============================================================================

export const punkEngine = new PunkEngine();

export async function registerPunkHandlers() {
  await punkEngine.initialize();

  ipcMain.handle("send_to_punk", async (_event, args) => {
    const {
      projectId,
      prompt,
      workingDir,
      sessionId,
      model,
      intent,
      history,
      requestId,
      thinking,
      provider,
      todos,
    } = args;
    await punkEngine.spawn({
      projectId,
      prompt,
      workingDir,
      sessionId,
      model,
      intent,
      history,
      requestId,
      thinking,
      provider,
      todos,
    });
  });

  ipcMain.handle("abort_punk", async (_event, args) => {
    await punkEngine.abort(args.projectId);
  });

  ipcMain.handle("approve_plan", async (_event, args) => {
    punkEngine.approvePlan(args.projectId);
  });

  ipcMain.handle("reject_plan", async (_event, args) => {
    punkEngine.rejectPlan(args.projectId);
  });

  ipcMain.handle("terminate_punk_session", async (_event, args) => {
    await punkEngine.terminate(args.projectId);
  });

  ipcMain.handle("reinitialize_punk_backend", async (_event, args) => {
    await punkEngine.reinitialize(args?.backend);
  });

  ipcMain.handle("get_openrouter_models", async () => {
    return await modelManager.models["openrouter"] || [];
  });

  ipcMain.handle("get_all_models", async () => {
    return await modelManager.models;
  });

  // ── SDK session management ────────────────────────────────────────────────
  // These call into the claude-agent-sdk directly, operating on the session
  // store on disk. No active subprocess needed.

  ipcMain.handle("sdk_list_sessions", async () => {
    const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
    return listSessions();
  });

  ipcMain.handle("sdk_get_session_messages", async (_event, { sessionId }) => {
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    return getSessionMessages(sessionId);
  });

  ipcMain.handle("sdk_fork_session", async (_event, { sessionId }) => {
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    return forkSession(sessionId);
  });
}

// Maps local-intel taskType → oracle domain. Replaces regex classifyDomain()
// when the Qwen model has already classified the task.
function _taskTypeToDomain(taskType) {
  switch (taskType) {
    case "debug":        return "debugging";
    case "implement":    return "implementation";
    case "explain":
    case "conversation":
    case "quick-answer": return "explanation";
    case "architect":    return "architecture";
    case "refactor":     return "refactoring";
    case "review":       return "general";
    default:             return "general";
  }
}

export async function preforkPunkWorker() {
  await punkEngine.initialize();
}

export async function shutdownPunkWorker() {
  await punkEngine.shutdown();
}
