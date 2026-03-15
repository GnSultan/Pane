// Punk Engine layer (main process).
//
// Single internal contract: given {projectId, prompt, intent, profile}, stream back Punk events.
// All routing (plan/execute/explain), profiles, and memory live at this Punk layer.
// Backends plug into Punk, not sit beside it.
// The renderer never sees "CLI vs HTTP".

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { BrowserWindow, utilityProcess, ipcMain } from "electron";
import { classifyIntent } from "./classify-intent.mjs";
import { HttpBackend } from "./http-backend.mjs";
import { PunkBackend } from "./punk-backend.mjs";

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
  "http": {
    plan: { provider: "deepseek", model: "deepseek-v3.2-speciale", thinking: false },
    execute: { provider: "deepseek", model: "deepseek-v3.2", thinking: false },
    explain: { provider: "deepseek", model: "deepseek-v3.2", thinking: false },
    other: { provider: "deepseek", model: "deepseek-v3.2", thinking: false },
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
        this.onEvent(projectId, {
          event: "processEnded",
          data: { exit_code: null },
        }, requestId);
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
}

// ============================================================================
// Punk Engine Core
// ============================================================================

class PunkEngine {
  constructor() {
    this.backend = null;
    this.relayQueue = [];
    this.relayDraining = false;
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
        break;
      default:
        throw new Error(`Unknown backend type: ${backendType}`);
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
    const channel = `claude-stream:${projectId}`;
    
    // Attach requestId to the event so the renderer can filter it
    const enrichedEvent = { ...event, requestId };

    if (event.event === "processEnded" || event.event === "error") {
      this.flushRelayQueue();
      this.sendToRenderer(channel, enrichedEvent);
      return;
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

    const drain = () => {
      if (this.relayQueue.length === 0) {
        this.relayDraining = false;
        return;
      }
      const { channel, event } = this.relayQueue.shift();
      this.sendToRenderer(channel, event);
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

  async spawn(request) {
    if (!this.backend) await this.initialize();

    let resolvedRequest = { ...request };

    // Always classify intent for system prompt and logging
    const classification = classifyIntent(request.prompt);
    if (!resolvedRequest.intent) {
      resolvedRequest.intent = classification.intent;
    }

    const isHttp = this.backend instanceof HttpBackend;
    const isGeminiCli = this.backend instanceof CliBackend && this.backend.command === "gemini";

    if (isHttp || isGeminiCli) {
      const autoRoute = await this.loadIntentAutoRoute();
      const routing = await this.loadIntentRouting();
      const intentRoute = routing[resolvedRequest.intent] || routing["execute"];

      if (autoRoute) {
        // AUTO-ROUTE: Use the mapped intent from settings
        resolvedRequest.provider = intentRoute.provider;
        resolvedRequest.model = intentRoute.model;
        resolvedRequest.thinking = intentRoute.thinking ?? false;
      } else if (!resolvedRequest.model) {
        // NO AUTO-ROUTE + NO EXPLICIT MODEL: Use the intent's default as fallback
        resolvedRequest.provider = intentRoute.provider;
        resolvedRequest.model = intentRoute.model;
        resolvedRequest.thinking = intentRoute.thinking ?? false;
      } else if (!resolvedRequest.provider) {
        // NO AUTO-ROUTE + HAS MODEL + NO PROVIDER: Infer provider from intent default
        // (This handles legacy UI or edge cases)
        resolvedRequest.provider = intentRoute.provider;
      }

      this.handleBackendEvent(request.projectId, {
        event: "routing",
        data: {
          intent: resolvedRequest.intent,
          confidence: classification.confidence,
          reason: classification.reason,
          provider: resolvedRequest.provider,
          model: resolvedRequest.model,
          thinking: resolvedRequest.thinking ?? false,
        },
      }, request.requestId);

      console.log(
        `[punk] intent=${resolvedRequest.intent} (${(classification.confidence * 100).toFixed(0)}%) → ${resolvedRequest.provider}/${resolvedRequest.model}` +
          (resolvedRequest.thinking ? " [thinking]" : "") +
          ` | ${classification.reason}`,
      );
    }

    await this.backend.spawn(resolvedRequest);
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
}

// ============================================================================
// Module Exports (Public API)
// ============================================================================

export const punkEngine = new PunkEngine();

export async function registerPunkHandlers() {
  await punkEngine.initialize();

  ipcMain.handle("send_to_punk", async (_event, args) => {
    const { projectId, prompt, workingDir, sessionId, model, intent, history, requestId, thinking, provider } =
      args;
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
    });
  });

  ipcMain.handle("abort_punk", async (_event, args) => {
    await punkEngine.abort(args.projectId);
  });

  ipcMain.handle("terminate_punk_session", async (_event, args) => {
    await punkEngine.terminate(args.projectId);
  });

  ipcMain.handle("reinitialize_punk_backend", async (_event, args) => {
    await punkEngine.reinitialize(args?.backend);
  });
}

export async function preforkPunkWorker() {
  await punkEngine.initialize();
}

export async function shutdownPunkWorker() {
  await punkEngine.shutdown();
}
