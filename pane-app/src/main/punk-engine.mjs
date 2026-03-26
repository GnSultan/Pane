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

// Node.js globals for utility process
const { AbortController, fetch, TextDecoder, setImmediate, console } =
  globalThis;

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
      intent: request.intent,
      history: request.history,
      command: this.command,
      requestId: request.requestId,
      todos: request.todos,
      tools: request.tools,
      maxTurns: request.maxTurns,
      systemPromptOverride: request.systemPromptOverride,
      escalationHint: request.escalationHint,
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

    let backendType;
    if (backendOverride) {
      backendType = backendOverride;
    } else {
      const settings = await this.loadSettings();
      backendType = this._normalizeBackendName(settings.punk_backend || "api");
    }

    const onEvent = (projectId, event, requestId) =>
      this.handleBackendEvent(projectId, event, requestId);

    switch (backendType) {
      case "cli":        // legacy
      case "claude-cli": // legacy
      case "claude-code":
        this.backend = new CliBackend(onEvent, "claude");
        break;
      case "gemini-cli": // legacy
      case "gemini":
        this.backend = new CliBackend(onEvent, "gemini");
        break;
      case "http": // legacy
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

  /** Normalize legacy backend names to current values. */
  _normalizeBackendName(raw) {
    switch (raw) {
      case "cli":        // legacy
      case "claude-cli": return "claude-code";
      case "gemini-cli": return "gemini";
      case "http":       return "api";
      default:           return raw;
    }
  }

  async loadIntentRouting() {
    try {
      const content = await fs.readFile(
        path.join(os.homedir(), ".pane", "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);
      const backend = this._normalizeBackendName(settings.punk_backend || "api");

      // Check both old and new key names in intent_routing
      const routing = settings.intent_routing?.[backend]
        || settings.intent_routing?.[settings.punk_backend];
      if (routing) return routing;
    } catch {}

    // Last-resort fallback to default mapping for the active backend
    const settings = await this.loadSettings();
    const backend = this._normalizeBackendName(settings.punk_backend || "api");
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
      // ── Unified classification + routing via active backend ──
      // Build model catalog: all available models with scores, costs, and real outcomes
      const settings = await this.loadSettings();
      let catalogData = null;
      try {
        catalogData = {
          backend:  this._normalizeBackendName(settings.punk_backend || "api"),
          apiKeys:  settings.http_api_keys || {},
          priors:   routingStore.getAllPriors(),
          profiles: routingStore.getAllProfiles(),
        };
      } catch (err) {
        console.warn("[punk] failed to build model catalog:", err.message);
      }

      // Build rich session snapshot for the classifier — everything Pane knows
      const history = resolvedRequest.history || [];
      const workingSet = sessionState?.workingSet || [];

      // Conversation summary: last 4 turns compressed to one-liners
      const recentTurns = history.slice(-8)
        .filter(m => m.type === "user" || m.type === "assistant")
        .map(m => {
          const role = m.type === "user" ? "user" : "assistant";
          const text = typeof m.content === "string"
            ? m.content
            : (Array.isArray(m.content)
                ? m.content.filter(b => b.type === "text").map(b => b.text || "").join(" ")
                : "");
          return `${role}: ${text.trim().slice(0, 120)}`;
        })
        .filter(Boolean);

      // Working set with touch counts
      const workingSetSummary = workingSet.slice(0, 8).map(f => {
        const name = (f.path || "").split("/").pop();
        return f.purpose ? `${name} (${f.purpose}, ${f.touches || 0} touches)` : `${name} (${f.touches || 0} touches)`;
      });

      // Recent actions
      const recentActions = (sessionState?.recentActions || []).slice(0, 5).map(a =>
        `[${a.type}] ${a.content}`
      );

      // Decisions locked this session
      const decisions = (sessionState?.decisions || []).slice(0, 4).map(d => d.content);

      // Brain context — read if available
      let brainSummary = {};
      try {
        const brainCtxPath = path.join(os.homedir(), ".pane", "brain", "context", `${resolvedRequest.projectId}.json`);
        const brainCtx = JSON.parse(await fs.readFile(brainCtxPath, "utf-8"));
        brainSummary = {
          codebaseSize: (brainCtx.codebaseMap || []).length,
          relevantFiles: (brainCtx.relevantFiles || []).slice(0, 5).map(f => f.path?.split("/").pop() + (f.description ? ` — ${f.description}` : "")),
          synthesis: (brainCtx.synthesis || "").slice(0, 200),
        };
      } catch {}

      // Struggle detection — count consecutive failing turns before classifying
      // so the classifier can factor in the struggle signal for model selection.
      try {
        const recentOutcomes = routingStore.getRecentProjectOutcomes(resolvedRequest.projectId, 6);
        struggleCount = _computeStruggleCount(recentOutcomes);
        if (struggleCount > 0) {
          console.log(`[punk] struggle signal: ${struggleCount} consecutive failing turns`);
        }
      } catch (err) {
        console.warn("[punk] struggle detection failed (non-fatal):", err.message);
      }

      localDecision = await localClassify({
        message:        resolvedRequest.prompt ?? "",
        turnCount:      history.length,
        hasActiveTask:  !!sessionState?.activeTask,
        activeTask:     sessionState?.activeTask?.description || null,
        workingSetSize: workingSet.length,
        workingSet:     workingSetSummary,
        pendingTodos,
        todoSummary:    (resolvedRequest.todos || [])
          .filter(t => t.status !== "completed")
          .slice(0, 5)
          .map(t => t.content),
        recentTurns,
        recentActions,
        decisions,
        gitBranch:      sessionState?.gitStatus?.branch || null,
        gitSummary:     sessionState?.gitStatus?.summary?.slice(0, 150) || null,
        codebaseSize:   brainSummary.codebaseSize || 0,
        relevantFiles:  brainSummary.relevantFiles || [],
        projectDNA:     brainSummary.synthesis || null,
        phase:          sessionState?.phase || "idle",
        struggleCount,
      }, (sys, usr) => this.quickCall(sys, usr), catalogData);

      if (localDecision) {
        strategy = {
          mode:         localDecision.mode,
          discovery:    localDecision.discovery,
          reasoning:    localDecision.reasoning,
          verification: localDecision.verification,
          confidence:   0.90,
          reason:       localDecision.reason || null,
          signals:      [],
        };
      } else {
        console.warn("[punk] classifier returned null — falling back to direct");
        strategy = { mode: "direct", discovery: false, reasoning: "shallow", verification: "none", confidence: 0.5, reason: "classifier unavailable", signals: [] };
      }
    }

    // ── ROUTING ───────────────────────────────────────────────────────────
    // Priority order:
    //   1. User explicit model lock (model differs from routing-table default)
    //   2. Classifier route (when autoRoute is on)
    //   3. Static routing table fallback
    //   4. Escalation override (struggle >= 3 → frontier model + deep thinking)
    // autoRoute comes directly from the frontend request — always current.
    // Fallback to disk only when not present (e.g. internal spawns).
    const autoRoute = request.autoRoute ?? (await this.loadIntentAutoRoute());
    const routing   = await this.loadIntentRouting();

    // Intent slot — used for fallback routing when classifier doesn't pick a model
    const intentSlot = strategy.mode === "discuss" ? "explain" : "execute";
    if (!resolvedRequest.intent) resolvedRequest.intent = intentSlot;

    const intentRoute = routing[intentSlot] || routing["execute"];
    const classifierRoute = localDecision?.executionModel;

    // When autoRoute is off the user has pinned a model — respect it exactly.
    // When autoRoute is on the router owns model selection entirely.
    const userExplicitOverride = !autoRoute;

    if (userExplicitOverride) {
      resolvedRequest.thinking = request.thinking ?? false;
      console.log(`[punk] user model lock → ${resolvedRequest.provider}/${resolvedRequest.model}`);
    } else if (classifierRoute && autoRoute) {
      // Smart router picked a specific model — use it.
      resolvedRequest.provider = classifierRoute.provider;
      resolvedRequest.model    = classifierRoute.model;
      resolvedRequest.thinking = strategy.reasoning === "deep";
      console.log(`[punk] classifier routed → ${classifierRoute.provider}/${classifierRoute.model}`);
    } else {
      // Fallback to static routing table.
      resolvedRequest.provider = intentRoute.provider;
      resolvedRequest.model    = intentRoute.model;
      resolvedRequest.thinking = intentRoute.thinking ?? false;
    }

    // ── ESCALATION ────────────────────────────────────────────────────────
    // When the session is struggling (consecutive failing turns) and the user
    // hasn't pinned a specific model, escalate capability and inject a deeper
    // analysis directive into the system prompt.
    let escalationLevel = 0;
    if (struggleCount >= 2 && !userExplicitOverride && autoRoute) {
      escalationLevel = Math.min(4, struggleCount - 1);

      // At struggle >= 3: upgrade to the highest-scoring model for this provider.
      if (struggleCount >= 3) {
        try {
          const providerSet = new Set([resolvedRequest.provider]);
          const frontier = routingStore.getFrontierModel(providerSet);
          if (frontier && frontier.model !== resolvedRequest.model) {
            console.log(
              `[punk] escalating ${resolvedRequest.model} → ${frontier.model}` +
              ` (struggle=${struggleCount})`,
            );
            resolvedRequest.provider = frontier.provider;
            resolvedRequest.model    = frontier.model;
          }
        } catch (err) {
          console.warn("[punk] frontier model lookup failed (non-fatal):", err.message);
        }
      }

      // Always enable deep thinking on struggling sessions.
      resolvedRequest.thinking = true;

      // Build domain-aware escalation directive for system prompt injection.
      const escalationHint = _buildEscalationHint(struggleCount, localDecision?.taskType ?? null);
      resolvedRequest.escalationHint  = escalationHint;
      resolvedRequest.escalationLevel = escalationLevel;
      console.log(`[punk] escalation level ${escalationLevel} injected`);
    }

    // Force openrouter for slash-namespaced models
    if (resolvedRequest.model?.includes("/") && resolvedRequest.provider !== "openrouter") {
      resolvedRequest.provider = "openrouter";
    }

    // Domain for outcome recording — derived from classifier or regex fallback
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
            // classifier metadata
            classifierRouted:     !!classifierRoute,
            classifierConfidence: classifierRoute ? 0.90 : null,
            classifierExploring:  false,
            localTaskType:    localDecision?.taskType ?? null,
            localComplexity:  localDecision?.complexity ?? null,
            localAtomHints:   localDecision?.atomHints ?? [],
            // struggle escalation
            escalationLevel,
            struggleCount,
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
          oracleUsed:          !!classifierRoute,
          oracleConfidence:    classifierRoute ? 0.90 : null,
          promptLength:        (resolvedRequest.prompt ?? "").length,
          explored:            false,
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
    const { threadId, prompt, workingDir, sessionId, model, requestId, entryContent } = args;
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
