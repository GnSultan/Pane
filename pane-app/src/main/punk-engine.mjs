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
  plan: {
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
  },
  execute: {
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
  },
  explain: {
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
  },
  other: {
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
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
 */

/**
 * @callback EventCallback
 * @param {string} projectId
 * @param {PunkEvent} event
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
    this.activeProjectIds = new Set();
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
        this.activeProjectIds.delete(message.projectId);
      }
      this.onEvent(message.projectId, message.event);
    });

    this.worker.on("exit", (code) => {
      console.warn(
        `[punk] CLI worker for ${this.command} exited with code ${code}`,
      );
      for (const projectId of this.activeProjectIds) {
        this.onEvent(projectId, {
          event: "processEnded",
          data: { exit_code: null },
        });
      }
      this.activeProjectIds.clear();
      this.worker = null;
    });

    return this.worker;
  }

  async spawn(request) {
    const worker = this.getWorker();
    this.activeProjectIds.add(request.projectId);
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
    });
  }

  async abort(projectId) {
    if (this.worker && !this.worker.killed) {
      this.worker.postMessage({ type: "abort", projectId });
    }
    this.activeProjectIds.delete(projectId);
  }

  async terminate(projectId) {
    if (this.worker && !this.worker.killed) {
      this.worker.postMessage({ type: "terminate", projectId });
    }
    this.activeProjectIds.delete(projectId);
  }

  async shutdown() {
    if (this.worker && !this.worker.killed) {
      this.worker.postMessage({ type: "shutdown" });
      this.worker.kill();
      this.worker = null;
    }
    this.activeProjectIds.clear();
  }
}

// ============================================================================
// Punk Engine Core
// ============================================================================

class PunkEngine {
  constructor() {
    this.backend = null;
    this.activeProjectIds = new Set();
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

    const onEvent = (projectId, event) =>
      this.handleBackendEvent(projectId, event);

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
    this.activeProjectIds.clear();
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
      if (settings.intent_routing) {
        return {
          plan: {
            ...DEFAULT_INTENT_ROUTING.plan,
            ...settings.intent_routing.plan,
          },
          execute: {
            ...DEFAULT_INTENT_ROUTING.execute,
            ...settings.intent_routing.execute,
          },
          explain: settings.intent_routing.explain ? {
            ...DEFAULT_INTENT_ROUTING.explain,
            ...settings.intent_routing.explain,
          } : undefined,
          other: settings.intent_routing.other ? {
            ...DEFAULT_INTENT_ROUTING.other,
            ...settings.intent_routing.other,
          } : undefined,
        };
      }
    } catch {}
    return DEFAULT_INTENT_ROUTING;
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

  handleBackendEvent(projectId, event) {
    if (event.event === "processEnded") this.activeProjectIds.delete(projectId);

    const channel = `claude-stream:${projectId}`;

    if (event.event === "processEnded" || event.event === "error") {
      this.flushRelayQueue();
      this.sendToRenderer(channel, event);
      return;
    }

    this.relayQueue.push({ channel, event });
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
    this.activeProjectIds.add(request.projectId);

    let resolvedRequest = { ...request };

    // Always classify intent for system prompt and logging
    // Prefer passed intent from renderer (state-aware) if available
    const classification = classifyIntent(request.prompt);
    if (!resolvedRequest.intent) {
      resolvedRequest.intent = classification.intent;
    }

    // Apply smart routing for HTTP backend OR Gemini CLI backend
    const isGeminiCli = this.backend instanceof CliBackend && this.backend.command === "gemini";
    if (this.backend instanceof HttpBackend || isGeminiCli) {
      const autoRoute = await this.loadIntentAutoRoute();

      if (autoRoute) {
        let route;
        if (isGeminiCli) {
          // For Gemini CLI, leverage its internal auto-routing by default
          route = { provider: "gemini", model: "auto-gemini-3", thinking: false };
        } else {
          const routing = await this.loadIntentRouting();
          route = routing[resolvedRequest.intent] || routing["execute"];
        }

        resolvedRequest = {
          ...resolvedRequest,
          provider: route.provider,
          model: route.model,
          thinking: route.thinking ?? false,
        };

        this.handleBackendEvent(request.projectId, {
          event: "routing",
          data: {
            intent: resolvedRequest.intent,
            confidence: classification.confidence,
            reason: classification.reason,
            provider: route.provider,
            model: route.model,
            thinking: route.thinking ?? false,
          },
        });

        console.log(
          `[punk] intent=${resolvedRequest.intent} (${(classification.confidence * 100).toFixed(0)}%) → ${route.provider}/${route.model}` +
            (route.thinking ? " [thinking]" : "") +
            ` | ${classification.reason}`,
        );
      } else {
        // Auto-route disabled: use provided model or default
        // Still log the intent classification for transparency
        console.log(
          `[punk] intent=${resolvedRequest.intent} (${(classification.confidence * 100).toFixed(0)}%) → auto-route disabled, using model=${request.model || "default"}` +
            ` | ${classification.reason}`,
        );
      }
    }

    await this.backend.spawn(resolvedRequest);
  }

  async abort(projectId) {
    if (this.backend) await this.backend.abort(projectId);
    this.activeProjectIds.delete(projectId);
  }

  async terminate(projectId) {
    if (this.backend) await this.backend.terminate(projectId);
    this.activeProjectIds.delete(projectId);
  }

  async shutdown() {
    if (this.backend) await this.backend.shutdown();
    this.activeProjectIds.clear();
  }
}

// ============================================================================
// Module Exports (Public API)
// ============================================================================

export const punkEngine = new PunkEngine();

export async function registerPunkHandlers() {
  await punkEngine.initialize();

  ipcMain.handle("send_to_punk", async (_event, args) => {
    const { projectId, prompt, workingDir, sessionId, model, intent, history } =
      args;
    await punkEngine.spawn({
      projectId,
      prompt,
      workingDir,
      sessionId,
      model,
      intent,
      history,
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
