// Punk Engine layer (main process).
//
// Single internal contract: given {projectId, prompt, intent, profile}, stream back Punk events.
// All routing (plan/execute/explain), profiles, and memory live at this Punk layer.
// Backends plug into Punk, not sit beside it.
// The renderer never sees "CLI vs HTTP".

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
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
import { ApiBackend } from "./http-backend.mjs";

// Planning phase system prompts moved to planning-agent.mjs.
// Kept as comments for reference — the planning agent owns these now.
import { PunkBackend } from "./punk-backend.mjs";
import { modelManager } from "./model-manager.mjs";
import { readState } from "./session-context.mjs";
import { routingStore } from "./routing-store.mjs";
import { classifyDomain } from "./routing-oracle.mjs";
import { ensurePriors } from "./benchmark-scout.mjs";
import { classify as localClassify } from "./intent-classifier.mjs";
import { routeHeuristic, detectFailureSignals, detectSuccessSignals, djb2Hash } from "./heuristic-router.mjs";
import { routeIntegrated, recordOutcome, getClassifierStats } from "./integrated-router.mjs";
import { readThreadState, incrementFailure, recordSuccess, updateLastPrompt, updateLastResponse, recordApproach } from "./thread-state.mjs";

// Node.js globals for utility process
const { AbortController, fetch, TextDecoder, setImmediate, console } =
  globalThis;

// ============================================================================
// Outcome scoring helpers
// ============================================================================

/**
 * Compute a basic quality score for a completed outcome.
 * Higher score = better outcome.
 *
 * @param {Object} tracked - tracked outcome data
 * @returns {number} 0-1 score
 */
function computeOutcomeScore(tracked) {
  let score = 0.5; // baseline

  // Response length: very short responses are often errors or refusals
  if (tracked.responseLength < 20) score -= 0.3;
  else if (tracked.responseLength < 50) score -= 0.1;
  else if (tracked.responseLength > 500) score += 0.1;

  // Tool errors reduce score significantly
  if (tracked.hadToolErrors) score -= 0.25;

  // Response time: very slow is bad (could indicate struggle)
  if (tracked.responseTimeMs > 60000) score -= 0.15;
  else if (tracked.responseTimeMs > 30000) score -= 0.05;

  // Clamp to valid range
  return Math.max(0.01, Math.min(1.0, score));
}

const __dirname = import.meta.dirname;

// ============================================================================
// Default Intent Routing Config
// ============================================================================

const DEFAULT_INTENT_ROUTING = {
  "gemini": {
    plan: { provider: "gemini", model: "auto-gemini-3", thinking: false },
    execute: { provider: "gemini", model: "auto-gemini-3", thinking: false },
    explain: { provider: "gemini", model: "auto-gemini-3", thinking: false },
    other: { provider: "gemini", model: "auto-gemini-3", thinking: false },
  },
  "claude-code": {
    plan: { provider: "anthropic", model: "opus", thinking: false },
    execute: { provider: "anthropic", model: "sonnet", thinking: false },
    explain: { provider: "anthropic", model: "sonnet", thinking: false },
    other: { provider: "anthropic", model: "sonnet", thinking: false },
  },
  api: {
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
/**
 * Write Edit/Write tool_use blocks from a CLI step directly to pane's change-history.
 * CLI backends use native tools (Edit, Write) that don't call the record_change IPC
 * handler. Step events use a stepRequestId filtered out by the renderer, so they
 * never reach recordChangeHistory() in usePunk.ts. We record them here instead.
 */
async function recordStepChangesToHistory(projectId, workingDir, toolUses) {
  const editTools = toolUses.filter(t =>
    t.name === "Edit" || t.name === "Write" ||
    t.name === "write_file" || t.name === "replace"
  );
  if (editTools.length === 0) return;

  const histDir = path.join(os.homedir(), ".pane", "change-history", projectId);
  const histFile = path.join(histDir, "changes.json");
  await fs.mkdir(histDir, { recursive: true });

  let changes = [];
  try { changes = JSON.parse(await fs.readFile(histFile, "utf-8")); } catch {}

  for (const tool of editTools) {
    let filePath = tool.input?.file_path || tool.input?.path || "";
    if (workingDir && path.isAbsolute(filePath) && filePath.startsWith(workingDir)) {
      filePath = path.relative(workingDir, filePath);
    }
    changes.unshift({
      id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      file: filePath,
      oldString: tool.input?.old_string || "",
      newString: tool.input?.new_string || tool.input?.content || "",
      description: `[step] ${tool.name}`,
    });
  }

  await fs.writeFile(histFile, JSON.stringify(changes.slice(0, 500), null, 2));
}

// CLI Backend (wraps existing cli-worker.mjs)
// ============================================================================

class CliBackend extends PunkBackend {
  constructor(onEvent, command) {
    super(onEvent);
    this.worker = null;
    this.command = command;
    this.activeRequests = new Map(); // requestId -> projectId
  }

  /** Only claude-agent-sdk supports resuming a session by ID. Gemini ignores sessionId. */
  get supportsSessionResume() { return this.command === "claude"; }

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
      provider: request.provider,
      intent: request.intent,
      history: request.history,
      command: this.command,
      requestId: request.requestId,
      todos: request.todos,
      tools: request.tools,
      maxTurns: request.maxTurns,
      systemPromptOverride: request.systemPromptOverride,
      escalationHint: request.escalationHint,
      // Mind sessions block shell execution — MCP context tools remain available
      noExec: typeof request.projectId === "string" && request.projectId.startsWith("mind:"),
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

    // CLI spawn is fire-and-forget — we must wait for processEnded before returning.
    // Collect tool_use blocks during the step so we can record them to pane's
    // change-history (step events use stepRequestId, so renderer never sees them).
    const stepToolUses = [];
    let stepDoneResolve;
    const stepDone = new Promise(r => { stepDoneResolve = r; });
    const origOnEvent = this.onEvent;
    this.onEvent = (pid, event, rid) => {
      if (rid === stepRequestId) {
        // Collect tool_use blocks from assistant messages for change-history recording
        if (event.event === "message") {
          const parsed = event.data?.parsed;
          if (parsed?.type === "assistant") {
            const content = parsed.message?.content || [];
            for (const block of content) {
              if (block.type === "tool_use") stepToolUses.push(block);
            }
          }
        }

        // processEnded: resolve the step, do NOT forward to renderer — it would
        // close the main listener (which is still waiting for orchestration_complete).
        if (event.event === "processEnded") {
          this.onEvent = origOnEvent;
          stepDoneResolve();
          return;
        }

        // Suppress system/init (overwrites session ID), result (session-ending),
        // user messages (step prompts clutter conversation), tool results (noise).
        if (event.event === "message") {
          const t = event.data?.parsed?.type;
          if (t === "system" || t === "result" || t === "user" || t === "tool") return;

          // Strip TodoWrite/TodoRead from assistant messages — the plan todo list is
          // managed by orchestration_plan/orchestration_step_complete events; execution
          // model's internal task tracking would overwrite those plan steps.
          if (t === "assistant") {
            const blocks = event.data?.parsed?.message?.content || [];
            const filtered = blocks.filter(
              b => !(b.type === "tool_use" && (b.name === "TodoWrite" || b.name === "TodoRead"))
            );
            if (filtered.length === 0) return;
            if (filtered.length !== blocks.length) {
              event = { ...event, data: { ...event.data, parsed: {
                ...event.data.parsed,
                message: { ...event.data.parsed.message, content: filtered },
              }}};
            }
          }
          // Suppress standalone TodoWrite/TodoRead tool_use messages too
          if (t === "tool_use") {
            const name = event.data?.parsed?.name;
            if (name === "TodoWrite" || name === "TodoRead") return;
          }
        }

        // Forward remaining step events (streaming text, tool_use, assistant messages)
        // under the main requestId — user sees execution activity in real time.
        origOnEvent(pid, event, request.requestId);
        return;
      }
      origOnEvent(pid, event, rid);
    };

    await this.spawn(stepRequest);
    // Wait for the model to actually finish (processEnded fires from worker)
    await Promise.race([stepDone, new Promise(r => setTimeout(r, 10 * 60 * 1000))]);
    this.onEvent = origOnEvent; // ensure restore even on timeout

    // Write Edit/Write tool calls directly to pane's change-history.
    // CLI backends bypass the renderer's recordChangeHistory, so we do it here.
    if (stepToolUses.length > 0) {
      await recordStepChangesToHistory(projectId, request.workingDir, stepToolUses).catch(err =>
        console.warn("[spawnStep] change-history recording failed:", err.message)
      );
    }

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
   * Contract: returns raw text string.
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
    this._brainSearch = null; // injected by main.mjs — calls brain_contextual_search
    this._brainIndexer = null; // injected by main.mjs — calls brain index_events
    // Outcome tracking: requestId → { outcomeId, startTime, taskType, domain, projectId, pendingTodoCount, responseLength, hadToolErrors }
    this._activeOutcomes = new Map();
    // Per-project last completed outcome — used for retrospective scoring
    // when the next message reveals whether the previous response was good.
    // NOTE: responseText is NOT stored here — it would accumulate for every
    // quiet project forever. Principle extraction fires immediately on
    // processEnded instead.
    this._projectLastOutcome = new Map(); // projectId → { outcomeId, pendingTodoCount, userPrompt, timestamp }

    // Worker agent listeners: requestId → { onText, resolve, reject, streamedText }
    // Used by agentCall() — events are consumed internally, never forwarded to renderer.
    this._workerAgentListeners = new Map();

    // Initialize learned classifier on startup (non-blocking)
    import("./integrated-router.mjs").then(module => {
      module.getClassifierStats && console.log("[punk] learned classifier ready");
    }).catch(() => {
      console.log("[punk] learned classifier not available");
    });

    // Safety sweep: evict any _activeOutcomes entries older than 10 minutes
    // (covers crashes/hangs where neither processEnded nor error fires) and
    // _projectLastOutcome entries older than 30 minutes.
    this._sweepInterval = setInterval(() => this._sweepStaleOutcomes(), 5 * 60 * 1000);
    if (this._sweepInterval.unref) this._sweepInterval.unref(); // don't keep process alive
  }

  _sweepStaleOutcomes() {
    const now = Date.now();
    const outcomeTTL   = 10 * 60 * 1000; // 10 min
    const lastOutcomeTTL = 30 * 60 * 1000; // 30 min

    for (const [id, tracked] of this._activeOutcomes) {
      if (now - tracked.startTime > outcomeTTL) {
        console.warn(`[punk] sweeping stale active outcome ${id} (age ${Math.round((now - tracked.startTime) / 1000)}s)`);
        this._activeOutcomes.delete(id);
      }
    }

    for (const [projectId, entry] of this._projectLastOutcome) {
      if (now - entry.timestamp > lastOutcomeTTL) {
        this._projectLastOutcome.delete(projectId);
      }
    }
  }

  /**
   * Inject brain contextual search function from main.mjs.
   * Signature: (args) => Promise<result> where args = { projectId, query, taskType, atomHints, projectRoot, intent }
   */
  setBrainSearch(fn) {
    this._brainSearch = fn;
  }

  setBrainIndexer(fn) {
    this._brainIndexer = fn;
  }

  async initialize(backendOverride) {
    if (this.backend) return;

    const backendType = backendOverride || (await this.loadSettings()).punk_backend || "api";

    const onEvent = (projectId, event, requestId) =>
      this.handleBackendEvent(projectId, event, requestId);

    switch (backendType) {
      case "claude-code":
        this.backend = new CliBackend(onEvent, "claude");
        break;
      case "gemini":
        this.backend = new CliBackend(onEvent, "gemini");
        break;
      case "api":
        this.backend = new ApiBackend(onEvent);
        break;
      default:
        throw new Error(`Unknown backend type: ${backendType}`);
    }

    // Seed benchmark priors (no-op after first run, refreshes weekly)
    ensurePriors().catch(err =>
      console.warn("[punk] benchmark-scout failed (non-fatal):", err.message)
    );

    // Initialize learned classifier (non-blocking, logs when ready)
    const { getClassifierStats } = await import("./integrated-router.mjs");
    const stats = getClassifierStats();
    if (stats) {
      console.log(`[punk] learned classifier ready (${stats.sampleCount} samples, ${stats.vocabSize} vocab)`);
    } else {
      console.log("[punk] learned classifier initialized");
    }
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
      return { punk_backend: "api", selected_model: null };
    }
  }

  async loadIntentRouting() {
    try {
      const content = await fs.readFile(
        path.join(os.homedir(), ".pane", "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);
      const backend = settings.punk_backend || "api";
      const routing = settings.intent_routing?.[backend];
      if (routing) return routing;
    } catch {}

    const settings = await this.loadSettings();
    const backend = settings.punk_backend || "api";
    return DEFAULT_INTENT_ROUTING[backend] || DEFAULT_INTENT_ROUTING["api"];
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
    // ── Worker agent events — collected internally, never sent to renderer ────
    if (requestId && this._workerAgentListeners.has(requestId)) {
      const listener = this._workerAgentListeners.get(requestId);

      if (event.event === 'message') {
        const parsed = event.data?.parsed;
        // Streaming text deltas (same path as outcome tracker)
        if (parsed?.type === 'stream_event') {
          const delta = parsed.data?.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            listener.streamedText += delta.text;
          }
        }
        // Assembled assistant message — authoritative final content
        if (parsed?.type === 'assistant') {
          const content = parsed.message?.content || parsed.content || [];
          const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
          if (text) listener.assembledText = (listener.assembledText || '') + text;
        }
      }

      if (event.event === 'processEnded') {
        // Prefer assembled (authoritative) over streamed; fall back to streamed
        const result = (listener.assembledText || listener.streamedText || '').trim();
        listener.resolve(result);
        this._workerAgentListeners.delete(requestId);
      }

      if (event.event === 'error') {
        listener.reject(new Error(event.data?.message || 'Worker agent error'));
        this._workerAgentListeners.delete(requestId);
      }

      return; // do not relay to renderer
    }

    const channel = `punk-stream:${projectId}`;

    // Attach requestId to the event so the renderer can filter it
    const enrichedEvent = { ...event, requestId };

    // ── Outcome signal capture ─────────────────────────────────────────────
    // Passively accumulate signals from the event stream. No blocking I/O.
    if (requestId && this._activeOutcomes.has(requestId)) {
      const tracked = this._activeOutcomes.get(requestId);

      // Accumulate response text length and full content for extraction
      if (event.event === "message" && event.data?.parsed?.type === "stream_event") {
        const delta = event.data.parsed.data?.delta;
        if (delta?.type === "text_delta" && delta.text) {
          tracked.responseLength += delta.text.length;
          tracked.responseText += delta.text;
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

        // Train the learned classifier with this completed outcome
        if (tracked.userPrompt && tracked.projectId) {
          try {
            // Compute a basic quality score based on response signals
            const score = computeOutcomeScore(tracked);
            recordOutcome({
              projectId: tracked.projectId,
              prompt: tracked.userPrompt,
              taskType: tracked.taskType,
              domain: tracked.domain,
              model: tracked.model || "unknown",
              provider: tracked.provider || "unknown",
              responseTimeMs: elapsed,
              hadToolErrors: tracked.hadToolErrors,
              responseLength: tracked.responseLength,
              score,
            });
          } catch (err) {
            console.warn("[punk] classifier training failed (non-fatal):", err.message);
          }
        }

        // Fire principle extraction immediately — do NOT store responseText in
        // _projectLastOutcome as it would hold the full response string for every
        // quiet project indefinitely, causing memory to grow without bound.
        if (tracked.projectId && !tracked.projectId.startsWith("mind:") &&
            tracked.userPrompt && tracked.responseText) {
          this._extractPrincipleAsync(tracked.projectId, tracked.userPrompt, tracked.responseText).catch(() => {});
        }

        // Save minimal metadata for retrospective scoring on next spawn.
        // No responseText here — it's already been handed off above.
        if (tracked.projectId) {
          this._projectLastOutcome.set(tracked.projectId, {
            outcomeId:        tracked.outcomeId,
            pendingTodoCount: tracked.pendingTodoCount,
            userPrompt:       tracked.userPrompt,
            timestamp:        Date.now(),
          });

          // Update thread-state with the last response summary for heuristic router
          try {
            const summary = (tracked.responseText || "").slice(0, 200);
            updateLastResponse(tracked.projectId, summary);
          } catch {}
        }
        this._activeOutcomes.delete(requestId);
      }

      // Clean up on error — prevents zombie entries accumulating responseText
      // indefinitely when a request fails without a processEnded event.
      if (event.event === "error") {
        this._activeOutcomes.delete(requestId);
      }
    }

    // Queue everything — including terminal events — and drain via setImmediate.
    // The old pattern of flushing the entire queue synchronously on processEnded
    // caused a burst of webContents.send calls that froze the renderer with CLI
    // backends, which can produce many events locally before the process exits.
    // Backpressure cap: during worker crash floods, events can arrive faster than
    // the drain loop can process. Without a cap the queue grows without bound.
    if (this.relayQueue.length >= 1000) {
      console.warn(`[punk] relayQueue backpressure: dropping oldest event (queue=${this.relayQueue.length})`);
      this.relayQueue.shift();
    }
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
    // Approval signal — user explicitly acknowledged good output
    else if (/^(great|perfect|thanks|good|nice|awesome|that works|looks good|exactly|beautiful|solid|clean|neat|love it|well done)/.test(text)) {
      delta += 0.15;
      console.log(`[oracle] retro: approval detected → +0.15 on outcome ${last.outcomeId}`);
    }
    // Continuation signal — user is building on the response (implicit acceptance)
    else if (/^(now |next[,. ]|ok[,. ]|okay[,. ]|cool[,. ]|got it|moving on|let'?s |alright[,. ]|so |and now|on to )/.test(text)) {
      delta += 0.10;
      console.log(`[oracle] retro: continuation detected → +0.10 on outcome ${last.outcomeId}`);
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

    // Principle extraction now fires immediately on processEnded (in handleBackendEvent)
    // rather than here — responseText is no longer stored in _projectLastOutcome.
  }

  // ── Principle extraction ─────────────────────────────────────────────────
  // Post-exchange reasoning pass. Identifies project-specific constraints,
  // standards, and preferences revealed through the texture of what the user
  // asked for — not the task itself, but the underlying standard being enforced.
  //
  // Uses quickCall — same path as commit drafts and the classifier. Works with
  // any backend the user has configured: CLI, API, anything. No hardcoding.
  // Writes to events.jsonl as type: "principle" — brain indexes on next pass.
  async _extractPrincipleAsync(projectId, userPrompt, responseText) {
    const PANE_DIR = path.join(os.homedir(), ".pane");
    const eventsPath = path.join(PANE_DIR, "memory", projectId, "events.jsonl");

    // Load existing principles to avoid duplicates
    let existingPrinciples = [];
    try {
      const raw = await fs.readFile(eventsPath, "utf-8");
      existingPrinciples = raw.split("\n")
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(e => e?.type === "principle")
        .map(e => e.content);
    } catch {}

    const systemPrompt = `You are a principle extractor for a coding assistant. Given a conversation exchange, identify if the user revealed a project-specific constraint, standard, or preference through what they asked for — not the task itself, but the underlying standard being enforced.

Examples of principles to extract:
- User asks to "clean up unused variables" → "Zero dead code: no unused variables or imports"
- User says "this should work offline-first" → "Offline-first: core features must work without connectivity"
- User says "remove that loading spinner, just show the content" → "No loading states — show content immediately or not at all"
- User asks to "use both bluetooth and wifi for the connection" → "Dual connectivity: both bluetooth and wifi are required, not either-or"

Be conservative. Only extract if the signal is clear and reveals a non-obvious project standard. Do not extract routine implementation choices, error fixes, or refactors that reveal nothing about project philosophy.

Respond with a single concise principle statement (one sentence, under 150 characters) or the word "none".`;

    const existingSection = existingPrinciples.length > 0
      ? `Existing principles (do not repeat these):\n${existingPrinciples.map(p => `- ${p}`).join("\n")}\n\n`
      : "";

    const userMessage = `${existingSection}Exchange:\nUser: ${userPrompt}\nAssistant: ${responseText}\n\nDid this exchange reveal a project principle?`;

    try {
      const result = await this.quickCall(systemPrompt, userMessage);
      if (!result) return;

      const principle = result.trim();
      if (!principle || principle.toLowerCase() === "none" || principle.length < 10 || principle.length > 200) return;

      const event = {
        type: "principle",
        content: principle,
        timestamp: Date.now(),
        source: "pane-extraction",
      };

      const memDir = path.join(PANE_DIR, "memory", projectId);
      await fs.mkdir(memDir, { recursive: true });
      await fs.appendFile(eventsPath, JSON.stringify(event) + "\n");

      // Index into the brain graph so contextualSearch can retrieve it
      if (this._brainIndexer) {
        this._brainIndexer(projectId, [event]).catch(() => {});
      }

      console.log(`[pane] principle extracted for ${projectId}: ${principle}`);
    } catch (err) {
      console.error("[pane] principle extraction failed (non-fatal):", err.message);
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
    let struggleCount = 0;
    // Declared here so routing fallback checks (after the if/else chain) can
    // reference it regardless of which branch ran.
    let catalogData = null;

    if (resolvedRequest._systemOverride) {
      // System-initiated spawn (mind chat, etc.) — skip classification entirely.
      // No quickCall, no routing oracle, just go straight to backend.
      strategy = { mode: "direct", discovery: false, reasoning: "shallow", verification: "none", confidence: 1.0, reason: "system override", signals: [] };
      console.log("[punk] system override — skipping classification");
    } else if (hasSlashOverride) {
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
      // ── Heuristic routing — zero-latency deterministic classification ──
      // Replaces the LLM classifier call with a pure algorithmic approach.
      // Thread-state tracks consecutive failures for escalation stages 0-4.

      const settings = await this.loadSettings();
      try {
        catalogData = {
          backend:  settings.punk_backend || "api",
          apiKeys:  settings.http_api_keys || {},
          priors:   routingStore.getAllPriors(),
          profiles: routingStore.getAllProfiles(),
        };
      } catch (err) {
        console.warn("[punk] failed to build model catalog:", err.message);
      }

      const history = resolvedRequest.history || [];
      const workingSet = sessionState?.workingSet || [];

      // ── Thread-state: failure/success detection ──
      const threadState = readThreadState(resolvedRequest.projectId);
      const promptHash = djb2Hash(resolvedRequest.prompt || "");

      // Detect failure signals BEFORE routing — updates escalation state
      const failureSignal = detectFailureSignals(
        resolvedRequest.prompt || "",
        threadState.lastUserPromptHash,
        threadState.lastUserPromptText,
      );

      if (failureSignal.isFailure) {
        const updated = incrementFailure(resolvedRequest.projectId, failureSignal.type);
        threadState.consecutiveFailures = updated.consecutiveFailures;
        threadState.escalationStage = updated.escalationStage;
        console.log(
          `[punk] failure detected (${failureSignal.type}) → stage ${updated.escalationStage}` +
          ` (${updated.consecutiveFailures} consecutive)`,
        );
      } else if (detectSuccessSignals(resolvedRequest.prompt || "")) {
        const updated = recordSuccess(resolvedRequest.projectId);
        threadState.consecutiveFailures = updated.consecutiveFailures;
        threadState.escalationStage = updated.escalationStage;
        console.log("[punk] success signal → failures reset");
      }

      // Record the current prompt for next-turn Jaccard comparison
      updateLastPrompt(resolvedRequest.projectId, resolvedRequest.prompt || "", promptHash);

      // Struggle count for backward compat with outcome tracking
      struggleCount = threadState.consecutiveFailures;

      // ── Route via integrated engine (heuristic + learned classifier) ──
      localDecision = await routeIntegrated({
        message:        resolvedRequest.prompt ?? "",
        turnCount:      history.length,
        workingSetSize: workingSet.length,
        pendingTodos,
        phase:          sessionState?.phase || "idle",
        threadState: {
          consecutiveFailures: threadState.consecutiveFailures,
          lastFailureType:     threadState.lastFailureType,
          approachesTried:     threadState.approachesTried?.length || 0,
          lastResponseSummary: threadState.lastResponseSummary,
          lastUserPromptHash:  threadState.lastUserPromptHash,
        },
        backend: catalogData?.backend ?? "claude-code",
      });

      // If the heuristic resets failures (success detected), apply it
      if (localDecision.resetFailures) {
        recordSuccess(resolvedRequest.projectId);
      }

      // Record the approach for this stage
      const approachLabel = localDecision.escalationStage >= 2 ? "explore_first"
        : localDecision.escalationStage >= 1 ? "self_review"
        : "direct";
      recordApproach(resolvedRequest.projectId, approachLabel);

      strategy = {
        mode:         localDecision.mode,
        discovery:    localDecision.discovery,
        reasoning:    localDecision.reasoning,
        verification: localDecision.verification,
        confidence:   localDecision.confidence,
        reason:       localDecision.reason || null,
        signals:      [],
      };

      console.log(
        `[punk] heuristic → mode=${localDecision.mode} tier=${localDecision.modelTier} ` +
        `complexity=${localDecision.complexityScore} stage=${localDecision.escalationStage} ` +
        `task=${localDecision.taskType}`,
      );
    }

    // ── ROUTING ───────────────────────────────────────────────────────────
    // Priority order:
    //   1. User explicit model lock (model differs from routing-table default)
    //   2. Classifier route (when autoRoute is on)
    //   3. Heuristic tier → concrete model resolution
    //   4. Escalation is built into the heuristic router (stages 0-4)
    // autoRoute comes directly from the frontend request — always current.
    // Fallback to disk only when not present (e.g. internal spawns).
    const autoRoute = request.autoRoute ?? (await this.loadIntentAutoRoute());
    const routing   = await this.loadIntentRouting();

    // Intent slot — used for fallback routing when heuristic doesn't pick a model
    const intentSlot = strategy.mode === "discuss" ? "explain" : "execute";
    if (!resolvedRequest.intent) resolvedRequest.intent = intentSlot;

    const intentRoute = routing[intentSlot] || routing["execute"];

    // When autoRoute is off the user has pinned a model — respect it exactly.
    // When autoRoute is on the router owns model selection entirely.
    const userExplicitOverride = !autoRoute;

    // Escalation level from heuristic router (already computed, not from old struggle detection)
    let escalationLevel = localDecision?.escalationStage ?? 0;

    if (userExplicitOverride) {
      resolvedRequest.thinking = request.thinking ?? false;
      console.log(`[punk] user model lock → ${resolvedRequest.provider}/${resolvedRequest.model}`);
    } else if (localDecision?.modelTier && autoRoute) {
      // ── Heuristic tier → concrete model resolution ──
      // The heuristic router returns a tier (cheap/mid/capable/frontier).
      // We resolve that to a concrete provider/model from the current backend.
      const tier = localDecision.modelTier;
      const isGemini = catalogData?.backend === "gemini";
      const baseProvider = isGemini ? "gemini" : "anthropic";

      const TIER_MODELS = {
        gemini: { cheap: "auto-gemini-3", mid: "auto-gemini-3", capable: "auto-gemini-3", frontier: "auto-gemini-3" },
        anthropic: { cheap: "haiku", mid: "sonnet", capable: "sonnet", frontier: "opus" },
      };
      const tierMap = TIER_MODELS[baseProvider] || TIER_MODELS.anthropic;

      resolvedRequest.provider = baseProvider;
      resolvedRequest.model    = tierMap[tier] || tierMap.mid;
      resolvedRequest.thinking = strategy.reasoning === "deep";

      // For API backend, check key availability and remap if needed
      if (catalogData?.backend === "api") {
        // Try to use the best model available from any provider with a key
        const keys = catalogData.apiKeys || {};
        if (!keys[resolvedRequest.provider]) {
          const firstWithKey = Object.entries(keys).find(([_, k]) => !!k)?.[0];
          if (firstWithKey) {
            console.log(`[punk] heuristic route ${resolvedRequest.provider} has no key → redirect to ${firstWithKey}`);
            resolvedRequest.provider = firstWithKey;
            // Remap tier for the new provider
            const newTierMap = TIER_MODELS[firstWithKey] || {};
            resolvedRequest.model = newTierMap[tier] || null;
          }
        }
      }

      // Frontier escalation via benchmark priors (when tier is frontier, try to get the best model)
      if (tier === "frontier") {
        try {
          const providerSet = new Set([resolvedRequest.provider]);
          const frontier = routingStore.getFrontierModel(providerSet);
          if (frontier && frontier.model !== resolvedRequest.model) {
            console.log(`[punk] frontier tier resolved → ${frontier.model}`);
            resolvedRequest.provider = frontier.provider;
            resolvedRequest.model    = frontier.model;
          }
        } catch {}
      }

      console.log(`[punk] heuristic routed → ${resolvedRequest.provider}/${resolvedRequest.model} (tier=${tier})`);
    } else {
      // Fallback to static routing table.
      resolvedRequest.provider = intentRoute.provider;
      resolvedRequest.model    = intentRoute.model;
      resolvedRequest.thinking = intentRoute.thinking ?? false;

      // Ensure fallback has a key
      if (catalogData?.backend === "api") {
        const keys = catalogData.apiKeys || {};
        if (!keys[resolvedRequest.provider]) {
          const firstWithKey = Object.entries(keys).find(([_, k]) => !!k)?.[0];
          if (firstWithKey) {
            resolvedRequest.provider = firstWithKey;
            resolvedRequest.model = null;
            console.log(`[punk] fallback redirect: ${firstWithKey}`);
          }
        }
      }
    }

    // ── ESCALATION ────────────────────────────────────────────────────────
    // The heuristic router computes escalation stages 0-4 with richer hints
    // and pre-actions. We inject the escalation hint into the system prompt
    // and set the escalation level for downstream use.
    if (localDecision?.escalationStage >= 1 && !userExplicitOverride && autoRoute) {
      escalationLevel = localDecision.escalationStage;

      // Inject the heuristic router's escalation hint (stage-aware, domain-specific)
      if (localDecision.escalationHint) {
        // Build the rich domain-aware hint from _buildEscalationHint for stages 2+
        // The heuristic router's hint is a brief behavioral instruction;
        // combine it with the full domain-specific escalation for deep context.
        const richHint = struggleCount >= 2
          ? _buildEscalationHint(struggleCount, localDecision.taskType)
          : localDecision.escalationHint;
        resolvedRequest.escalationHint  = richHint;
        resolvedRequest.escalationLevel = escalationLevel;
      }

      // Enable deep thinking on escalated sessions
      if (escalationLevel >= 2) {
        resolvedRequest.thinking = true;
      }

      console.log(`[punk] escalation stage ${escalationLevel} injected (heuristic)`);
    }

    // Force openrouter for slash-namespaced models
    if (resolvedRequest.model?.includes("/") && resolvedRequest.provider !== "openrouter") {
      resolvedRequest.provider = "openrouter";
    }

    // Domain for outcome recording — derived from heuristic or regex fallback
    const domain = localDecision
      ? _taskTypeToDomain(localDecision.taskType)
      : classifyDomain(resolvedRequest.prompt ?? "");

    // Emit strategy event only when the router actually made a decision.
    // When the user has pinned a specific model, stay silent — no UI noise.
    if (!userExplicitOverride) {
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
            // heuristic metadata
            routedBy:         localDecision?.routedBy ?? null,
            heuristicTier:    localDecision?.modelTier ?? null,
            complexityScore:  localDecision?.complexityScore ?? null,
            localTaskType:    localDecision?.taskType ?? null,
            localComplexity:  localDecision?.complexity ?? null,
            localAtomHints:   localDecision?.atomHints ?? [],
            // escalation (from heuristic router)
            escalationLevel,
            struggleCount,
            preActions:       localDecision?.preActions ?? [],
          },
        },
        request.requestId,
      );
    }

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
        // Read the project "why" to bias brain search toward the project's purpose
        let projectWhy = "";
        try {
          projectWhy = (await fs.readFile(
            path.join(os.homedir(), ".pane", "memory", resolvedRequest.projectId, "why.md"), "utf-8"
          )).trim();
        } catch {}

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
            projectWhy,
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
          oracleUsed:          localDecision?.routedBy === "integrated",
          oracleConfidence:    localDecision?.routedBy === "integrated" ? (localDecision.confidence || 0.85) : null,
          promptLength:        (resolvedRequest.prompt ?? "").length,
          explored:            false,
        });
        this._activeOutcomes.set(request.requestId, {
          outcomeId,
          startTime:        Date.now(),
          taskType:         strategy.mode,
          domain,
          projectId:        resolvedRequest.projectId,
          model:            resolvedRequest.model,
          provider:         resolvedRequest.provider,
          pendingTodoCount: (resolvedRequest.todos || []).filter(t => t.status !== "completed").length,
          responseLength:   0,
          hadToolErrors:    false,
          userPrompt:       resolvedRequest.prompt || "",
          responseText:     "",
        });
      } catch (err) {
        console.warn("[punk] outcome record failed (non-fatal):", err.message);
      }
    }

    // ── CONTROL INVERSION CHECK ───────────────────────────────────────────
    // Strategy engine drives orchestration — classifier's mode decision is the gate.
    if (!resolvedRequest._systemOverride) {
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
          await this._orchestrate(resolvedRequest, routing, strategy, localDecision);
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
   * Multi-model orchestration: planning model writes a natural markdown plan
   * that streams to the user, then execution model implements it immediately.
   *
   * The plan is the model's natural output — readable in the conversation.
   * The execution model receives the plan as context and runs autonomously.
   */
  async _orchestrate(request, routing, strategy, classifierDecision = null) {
    const projectId = request.projectId;

    this.handleBackendEvent(projectId, {
      event: "orchestration_start",
      data: { prompt: request.prompt },
    }, request.requestId);

    // ── PLANNING MODEL SELECTION ──────────────────────────────────────────
    const classifierPlan = classifierDecision?.planningModel;
    const planRoute = classifierPlan
      ? { provider: classifierPlan.provider, model: classifierPlan.model, thinking: strategy.reasoning === "deep" }
      : (routing["plan"] || routing["execute"]);

    const phase = strategy.discovery ? "discovery" : "planning";
    this.handleBackendEvent(projectId, {
      event: "orchestration_phase",
      data: { phase, model: planRoute.model, provider: planRoute.provider },
    }, request.requestId);

    console.log(
      `[punk] planning → ${planRoute.provider}/${planRoute.model}` +
      (strategy.discovery ? " [discovery]" : " [direct]"),
    );

    // ── PLANNING PASS ─────────────────────────────────────────────────────
    // Planning model explores the codebase and writes a natural markdown plan.
    // The plan streams directly to the user — no JSON parsing, no validation.
    const { runPlanningAgent } = await import("./planning-agent.mjs");
    const planText = await runPlanningAgent({
      request,
      planRoute,
      strategy,
      backend: this.backend,
      onEvent: (pid, event, rid) => this.handleBackendEvent(pid, event, rid),
    });

    if (!planText) {
      console.error("[punk] planning agent returned no plan — aborting orchestration");
      this.handleBackendEvent(projectId, {
        event: "orchestration_error",
        data: { message: "Planning model did not produce a plan." },
      }, request.requestId);
      return;
    }

    // ── EXECUTION MODEL SELECTION ─────────────────────────────────────────
    const classifierExec = classifierDecision?.executionModel;
    const execRoute = classifierExec
      ? { provider: classifierExec.provider, model: classifierExec.model, thinking: false }
      : routing["execute"];

    this.handleBackendEvent(projectId, {
      event: "orchestration_phase",
      data: { phase: "executing", model: execRoute?.model, provider: execRoute?.provider },
    }, request.requestId);

    console.log(`[punk] execution → ${execRoute?.provider}/${execRoute?.model}`);

    // ── EXECUTION PASS ────────────────────────────────────────────────────
    // Execution model receives the plan as context and implements it.
    // For CLI backends: fold plan into the prompt.
    // For HTTP backends: use _systemPrepend so the plan is in the system prompt.
    const isCliBackend = !this.backend.supportsToolCalling;
    const executionInstructions =
      `The following plan was written by the planning model after exploring the codebase:\n\n` +
      `${planText}\n\n---\n\n` +
      `Execute the plan above. Use your tools to read, modify, and create files as described. ` +
      `Work through each phase methodically. Do not re-plan — implement.`;

    const executionPrompt = isCliBackend
      ? `${executionInstructions}\n\n---\n\nOriginal task: ${request.prompt}`
      : request.prompt;

    const executionRequest = {
      ...request,
      phase:          "execution",
      provider:       execRoute?.provider || request.provider,
      model:          execRoute?.model    || request.model,
      thinking:       execRoute?.thinking ?? request.thinking ?? false,
      prompt:         executionPrompt,
      _systemPrepend: isCliBackend ? undefined : executionInstructions,
    };

    await this.backend.spawn(executionRequest);
  }

  async abort(projectId) {
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
    const settings = await this.loadSettings();
    const routing = await this.loadIntentRouting();
    const explainRoute = routing["explain"] || routing["execute"] || {};

    const request = {
      provider: explainRoute.provider || null,
      model: explainRoute.model || null,
      thinking: false,
    };

    // If using API backend, ensure we have a key for the chosen provider.
    // If not, try to find ANY provider that HAS a key.
    if (settings.punk_backend === "api" || !settings.punk_backend) {
      const keys = settings.http_api_keys || {};
      const currentProvider = request.provider || settings.http_provider || "deepseek";

      if (!keys[currentProvider]) {
        // Current choice has no key — pick the first provider that DOES.
        const firstWithKey = Object.entries(keys).find(([_, k]) => !!k)?.[0];
        if (firstWithKey) {
          request.provider = firstWithKey;
          // When switching provider, we MUST use a model that exists for it.
          // mapModelName with null model will return the default for that provider.
          request.model = null;
          console.log(`[punk] quickCall: ${currentProvider} has no key, switching to ${firstWithKey}`);
        }
      }
    }

    return this.backend.planningCall(systemPrompt, userPrompt, request);
  }

  /**
   * Full agentic call for background workers — like spawn() but resolves with
   * the aggregated text response instead of streaming to the renderer.
   *
   * Workers get: Read, Glob, Grep (built-in) + full MCP toolkit including
   * pane_run_in_terminal. They can run tests, check builds, trace call paths.
   * Events are collected internally and never forwarded to the renderer.
   *
   * Returns the accumulated assistant text, or throws on timeout/error.
   */
  async agentCall(systemPrompt, prompt, workingDir) {
    await this.initialize();

    const requestId = `worker-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const projectId = `worker-agent:${crypto.randomUUID().slice(0, 8)}`;

    let resolveCall, rejectCall;
    const callDone = new Promise((res, rej) => { resolveCall = res; rejectCall = rej; });

    this._workerAgentListeners.set(requestId, {
      streamedText: '',
      assembledText: '',
      resolve: resolveCall,
      reject: rejectCall,
    });

    await this.spawn({
      projectId,
      prompt,
      workingDir,
      sessionId: null,
      model: null,
      intent: 'other',
      history: [],
      requestId,
      todos: null,
      tools: ['Read', 'Glob', 'Grep'],  // built-in tools: read-only analysis
      maxTurns: 25,                      // enough for real multi-step investigation
      systemPromptOverride: systemPrompt,
      _systemOverride: true,
      noExec: false,                     // MCP pane_run_in_terminal available — workers can run tests
    });

    // 8-minute ceiling — deep analysis should finish well within this
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('agentCall timeout')), 8 * 60 * 1000)
    );

    try {
      return await Promise.race([callDone, timeout]);
    } catch (err) {
      this._workerAgentListeners.delete(requestId);
      throw err;
    }
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
      autoRoute,
      // Mind chat fields — when projectId starts with "mind:", these override defaults
      systemPromptOverride,
      _systemOverride,
      tools,
      maxTurns,
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
      autoRoute,
      ...(systemPromptOverride ? { systemPromptOverride } : {}),
      ...(_systemOverride ? { _systemOverride } : {}),
      ...(tools ? { tools } : {}),
      ...(maxTurns ? { maxTurns } : {}),
    });
  });

  ipcMain.handle("abort_punk", async (_event, args) => {
    await punkEngine.abort(args.projectId);
  });

  ipcMain.handle("send_to_mind", async (_event, args) => {
    const { threadId, prompt, workingDir, sessionId, model, provider, thinking, requestId, entryContent } = args;
    console.log(`[pane] Mind chat: thread=${threadId}, prompt=${(prompt || "").slice(0, 60)}`);
    const mindSystemPrompt =
      "You are a thinking partner inside Pane Mind. You help the user think through ideas by exploring code, finding relevant patterns, and offering analysis. You can read files and search the codebase but CANNOT write, edit, or execute anything. Be concise and direct. No emojis.\n\nThe thought being explored:\n" +
      (entryContent || "");
    await punkEngine.spawn({
      projectId: "mind:" + threadId,
      prompt,
      workingDir,
      sessionId: sessionId || null,
      model: model || null,
      provider: provider || null,
      thinking: thinking ?? false,
      requestId,
      tools: ["Read", "Glob", "Grep"],
      maxTurns: 15,
      systemPromptOverride: mindSystemPrompt,
      _systemOverride: true,
    });
  });

  ipcMain.handle("abort_mind", async (_event, args) => {
    await punkEngine.abort("mind:" + args.threadId);
  });

  ipcMain.handle("send_to_lens", async (_event, args) => {
    const { postId, prompt, workingDir, sessionId, model, provider, thinking, requestId, postContent } = args;
    console.log(`[pane] Lens chat: post=${postId}, prompt=${(prompt || "").slice(0, 60)}`);
    const lensSystemPrompt =
      "You are a focused collaborator inside Pane Lens. The user is discussing a specific observation about their codebase. Help them explore it — answer questions, find related code, surface implications. Be concise and direct. No emojis.\n\nThe observation:\n" +
      (postContent || "");
    await punkEngine.spawn({
      projectId: "lens:" + postId,
      prompt,
      workingDir,
      sessionId: sessionId || null,
      model: model || null,
      provider: provider || null,
      thinking: thinking ?? false,
      requestId,
      tools: ["Read", "Glob", "Grep"],
      maxTurns: 10,
      systemPromptOverride: lensSystemPrompt,
      _systemOverride: true,
    });
  });

  ipcMain.handle("abort_lens", async (_event, args) => {
    await punkEngine.abort("lens:" + args.postId);
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

/**
 * Deterministic fast-path classifier for trivially obvious intents.
 * Only fires on inputs so clear that calling the LLM is pure waste.
 * Returns a full decision object (same shape as parseDecision output)
 * or null to fall through to the LLM classifier.
 *
 * @param {string} message   — raw user message
 * @param {string} backend   — normalised backend ("claude-code" | "gemini" | "api")
 * @returns {object|null}
 */
function _fastPathClassify(message, backend) {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const lower  = trimmed.toLowerCase();
  const isGemini   = backend === "gemini";
  const provider   = isGemini ? "gemini"     : "anthropic";
  const cheapModel = isGemini ? "auto-gemini-3" : "haiku";
  const midModel   = isGemini ? "auto-gemini-3" : "sonnet";

  // ── Pattern 1: Pure confirmations ────────────────────────────────────────
  // Single-intent words / phrases that just mean "yes, do it".
  // Routed to sonnet (not haiku) because confirmations trigger real execution.
  const CONFIRMATIONS = new Set([
    "yes", "y", "ok", "okay", "sure", "do it", "go ahead", "go",
    "yep", "yup", "yeah", "sounds good", "let's go", "lets go",
    "proceed", "continue", "looks good", "ship it", "lgtm",
    "perfect", "great", "done", "alright", "cool", "nice",
  ]);
  if (CONFIRMATIONS.has(lower)) {
    return {
      mode: "direct", reason: "Continuing — going directly.",
      discovery: false, reasoning: "shallow", verification: "diff",
      taskType: "other", complexity: "low", preferFrontier: false,
      atomHints: [], historyDepth: 3, includeBrief: false, fileDepth: "none",
      planningModel: null,
      executionModel: { model: midModel, provider },
    };
  }

  // ── Pattern 2: Short pure questions (≤ 15 words, ends with ?, no code) ───
  // "what does X do?", "why is Y failing?", "how does Z work?"
  // Routed to haiku — just answering, no file changes.
  const wordCount    = trimmed.split(/\s+/).filter(Boolean).length;
  const hasCodeBlock = trimmed.includes("```");
  if (trimmed.endsWith("?") && wordCount <= 15 && !hasCodeBlock) {
    return {
      mode: "discuss", reason: "Quick question — answering directly.",
      discovery: false, reasoning: "shallow", verification: "none",
      taskType: "quick-answer", complexity: "low", preferFrontier: false,
      atomHints: [], historyDepth: 3, includeBrief: false, fileDepth: "none",
      planningModel: null,
      executionModel: { model: cheapModel, provider },
    };
  }

  return null; // no fast-path match — fall through to LLM classifier
}

// Maps local-intel taskType → oracle domain. Replaces regex classifyDomain()
/**
 * Count consecutive failing turns from the most-recent outcome backward.
 * A turn "fails" when it had tool errors or scored below 0.45.
 */
function _computeStruggleCount(outcomes) {
  if (!outcomes || outcomes.length === 0) return 0;
  let count = 0;
  for (const o of outcomes) {
    if (o.had_tool_errors || (o.score !== null && o.score < 0.45)) count++;
    else break;
  }
  return count;
}

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

/**
 * Build a domain-aware escalation directive for the system prompt.
 *
 * The hint has three compounding dimensions:
 *   1. Analytical stance  — what lens to apply (domain-specific)
 *   2. Effort mode        — how deep to think (grows with tier)
 *   3. Capability ceiling — model upgrade (handled by caller)
 *
 * Tiers (by struggle count):
 *   2 → T1  extended thinking, same model, domain-specific angle change
 *   3 → T2  frontier model, deeper domain-specific analytical frame
 *   4 → T3  frontier model, domain-specific reset — abandon previous approach
 *   5+ → T4 frontier model, adversarial audit of own approach, start clean
 *
 * @param {number} struggleCount
 * @param {string|null} taskType  — from localDecision.taskType
 * @returns {string}
 */
function _buildEscalationHint(struggleCount, taskType) {
  const tier = struggleCount >= 5 ? 4 : struggleCount - 1; // 2→1, 3→2, 4→3, 5+→4

  // ── Domain-specific tier tables ──────────────────────────────────────────

  const DOMAIN_TIERS = {

    debug: [
      // T1
      `Previous attempts didn't isolate the failure. This time: verify every assumption explicitly ` +
      `before acting on it. Trace the actual execution path — use tool calls to read the relevant ` +
      `code rather than reasoning from memory. Don't guess at the fix until you've confirmed the cause.`,
      // T2
      `Two consecutive debug attempts have not resolved this. Shift from "find the bug and fix it" ` +
      `to root cause analysis. Ask: what invariant is being violated, and where is it first broken? ` +
      `Walk backward from the failure symptom, not forward from the code. Treat every prior assumption ` +
      `as unverified until you confirm it with a tool call.`,
      // T3
      `Three failed attempts. The surface-level error is not the real problem — something upstream or ` +
      `structural is producing it. Read the full execution path cold: entry point → call chain → failure ` +
      `site. Build a list of what you know for certain vs. what you're assuming. The fix will be in ` +
      `the assumptions column, not the symptoms column. Abandon the previous approach entirely.`,
      // T4
      `Four or more failures. Before touching anything: write down every assumption you've been operating ` +
      `under and explicitly test each one with tool calls. The bug is almost certainly hiding in an ` +
      `interaction between components you considered separately. Read every file in the affected call chain ` +
      `as if you've never seen this codebase. The correct fix is probably not where you've been looking.`,
    ],

    architect: [
      // T1
      `Previous attempts haven't landed architecturally. Step away from the code level entirely. ` +
      `Think about system boundaries, responsibility ownership, and data flow before proposing ` +
      `any specific changes. The right structure will make the code obvious — wrong structure ` +
      `produces complexity no amount of clever code can fix.`,
      // T2
      `Two attempts haven't resolved this architectural problem. Draw the full dependency graph mentally: ` +
      `what changes downstream if this design is adopted? Work backward from consequences, not forward ` +
      `from implementation. Understand what problem the current design is actually solving before ` +
      `proposing an alternative — the existing structure exists for reasons that may not be visible locally.`,
      // T3
      `Three architectural attempts have failed. Treat this as a fresh system design problem, constrained ` +
      `by what currently exists. Use your tools to read every module that touches this concern. ` +
      `Map the real architecture before proposing any changes. Ask: what is the ideal shape here, ` +
      `how far is the current shape from that, and what is the minimum viable path to close that gap?`,
      // T4
      `Four or more architectural failures. The design space you've been working in is wrong. ` +
      `Read every file relevant to this concern cold, building a complete picture of what exists. ` +
      `Then articulate: what is the current architecture actually doing, what is it failing to do, ` +
      `and what would need to be true for the right design to be obvious? Start the answer from there.`,
    ],

    implement: [
      // T1
      `Previous implementation attempts have failed. Before writing any code: read the immediate ` +
      `context thoroughly — the types, the interfaces, the existing patterns in this file. ` +
      `Implement to the actual contract, not to what you assume the contract is.`,
      // T2
      `Two implementation attempts haven't worked. Map the full contract: what does every caller ` +
      `of this code expect? What does every dependency provide? Understand the interface completely ` +
      `before writing a line. Use tool calls to read the actual signatures and usages — don't infer them.`,
      // T3
      `Three failed implementations. Find every place this code is used or touched. Read each one. ` +
      `The failure is most likely a mismatch between what you're building and what something else expects. ` +
      `Build a complete picture of the surrounding contract before attempting anything. ` +
      `The previous implementations were probably correct in isolation but wrong in context.`,
      // T4
      `Four or more failures. Approach this as if you've never seen this codebase. Read every relevant ` +
      `file fresh — the entry points, the types, the tests. Derive the correct implementation ` +
      `entirely from what you read, not from memory of previous attempts. ` +
      `Previous attempts carry incorrect priors — start clean.`,
    ],

    refactor: [
      // T1
      `Refactoring attempts have broken something. Before any changes: precisely define what behavior ` +
      `must be preserved — not what code exists, but what it must continue to do. ` +
      `Semantic equivalence is the constraint. Every structural change must satisfy it.`,
      // T2
      `Two refactoring attempts have failed. Find every caller, every dependency, every type that ` +
      `will be affected by this change. No assumptions about what's safe to touch — use tool calls ` +
      `to verify actual usages. The breakage is most likely in a dependency you assumed was isolated.`,
      // T3
      `Three failed refactors. Build a complete call graph before touching anything: ` +
      `every entry point, every consumer, every type that flows through this code. ` +
      `Read the tests — they define the contract you must preserve. ` +
      `The refactor is safe only when every line in that graph is accounted for.`,
      // T4
      `Four or more failures. Stop all refactoring. First, read every test and determine ` +
      `exactly what invariants must hold. Then read every file that references this code. ` +
      `Map the complete reference graph before proposing any change. The correct refactor ` +
      `will be smaller and more precise than the previous attempts.`,
    ],

    explain: [
      // T1
      `Previous explanations haven't been clear enough. Approach this from first principles — ` +
      `rebuild the mental model from the ground up rather than extending the previous explanation. ` +
      `What's the simplest true thing that can be said about this first?`,
      // T2
      `Two explanations haven't landed. The current framing isn't working — use a completely ` +
      `different mental model or analogy. If you've been explaining top-down, try bottom-up. ` +
      `If you've been using abstraction, use a concrete example. Change the angle entirely.`,
      // T3
      `Three explanations have missed. The gap is likely deeper than presentation — ` +
      `there may be a prerequisite concept that needs to be established first. ` +
      `Identify what you've been assuming the reader already knows and start one level below that.`,
      // T4
      `Four or more explanations have failed. Abandon all previous framings. ` +
      `Ask what the simplest possible question is that, once answered, makes everything else clear. ` +
      `Start there, and build nothing on top of it until it's solid.`,
    ],

    general: [
      // T1
      `Previous attempts haven't resolved this. Think more carefully — ` +
      `identify what assumption in the previous approach was wrong before trying again. ` +
      `Don't retry with more effort; retry with a different model of the problem.`,
      // T2
      `Two consecutive failures. Re-examine the problem statement itself: ` +
      `is the task actually what it appears to be? Are there constraints that haven't been surfaced? ` +
      `Use tool calls to gather more context before acting — don't work from memory.`,
      // T3
      `Three failures. The previous approaches have been operating on incorrect premises. ` +
      `Start by reading every relevant file cold, building a fresh picture of the actual state. ` +
      `Then derive the solution from what you observe, not from what you remember trying.`,
      // T4
      `Four or more failures. Perform an adversarial audit of every assumption made in previous attempts. ` +
      `For each assumption, verify it explicitly with tool calls. The correct path forward ` +
      `is almost certainly perpendicular to what's been tried — don't iterate, pivot.`,
    ],
  };

  const bucket =
    taskType === "debug"        ? "debug"
    : taskType === "architect"  ? "architect"
    : taskType === "implement"  ? "implement"
    : taskType === "refactor"   ? "refactor"
    : (taskType === "explain" || taskType === "conversation" || taskType === "quick-answer")
                                ? "explain"
    : "general";

  const hints = DOMAIN_TIERS[bucket];
  const hint  = hints[Math.min(tier - 1, hints.length - 1)]; // tier is 1-indexed

  return (
    `[Escalation — ${struggleCount} consecutive failing turns | domain: ${bucket} | tier: ${tier}]\n` +
    hint
  );
}

export async function preforkPunkWorker() {
  await punkEngine.initialize();
}

export async function shutdownPunkWorker() {
  await punkEngine.shutdown();
}
