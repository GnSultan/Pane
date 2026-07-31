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
import { BrowserWindow, ipcMain } from "electron";
import { getPaneDb } from "./pane-db.mjs";

import { ApiBackend } from "./http-backend.mjs";

import { PunkBackend } from "./punk-backend.mjs";
import { modelManager } from "./model-manager.mjs";
import { readState } from "./pane-system-prompt.mjs";
import { routingStore } from "./routing-store.mjs";
import { classifyDomain } from "./routing-oracle.mjs";
import { ensurePriors } from "./benchmark-scout.mjs";
// intent-classifier.mjs removed — LLM-based classifier was dead code (never called)
import { detectFailureSignals, detectSuccessSignals, djb2Hash } from "./heuristic-router.mjs";
import { routeIntegrated, recordOutcome, getClassifierStats } from "./heuristic-router.mjs";
import { contextStore } from "./context-store.mjs";
import { propagateCompletion } from "./completion-propagator.mjs";
import { extractAndIndex } from "./memory-extractor.mjs";
import { readThreadState, incrementFailure, recordSuccess, updateLastPrompt, updateLastResponse, recordApproach } from "./thread-state.mjs";
import { recordQualityMetric, recordArbiterCorrections, isUserCorrection, recordUserCorrection, buildUserCorrectionEvent } from "./code-arbiter.mjs";

// Node.js globals for utility process
const { setImmediate, console } =
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
// Default Power Combo
// ============================================================================

// Global default: Opus thinks, Sonnet builds.
// Provider-agnostic — either slot can be any provider the user has access to.
// Used as fallback when settings.json has no power_combo configured.
const DEFAULT_POWER_COMBO = {
  // Keyed variants kept only for migration from old per-backend format
  "claude-code": {
    thinking:  { provider: "anthropic", model: "opus",   thinking: false },
    execution: { provider: "anthropic", model: "sonnet", thinking: false },
  },
  api: {
    thinking:  { provider: "openrouter", model: "stepfun/step-3.5-flash:free", thinking: true },
    execution: { provider: "openrouter", model: "stepfun/step-3.5-flash:free", thinking: true },
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
// Punk Engine Core
// ============================================================================

class PunkEngine {
  constructor() {
    // Single API backend for HTTP-based model access
    this.backends = {
      api: null,     // ApiBackend for HTTP
    };
    this.backendAvailability = {
      api: true,     // API backend is always available
    };
    this.defaultBackend = null; // For backward compatibility
    
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

    // Log learned classifier status at startup
    if (getClassifierStats()) console.log("[punk] learned classifier ready");

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

  setBrainRequest(fn) {
    this._brainRequest = fn;
    // Propagate to API backend if it exists
    if (this.backends.api) {
      this.backends.api.setBrainRequest(fn);
    }
  }

  setQuickCall(fn) {
    this._quickCall = fn;
    if (this.backends.api) {
      this.backends.api.setQuickCall(fn);
    }
  }

  setAgentCall(fn) {
    this._agentCall = fn;
    if (this.backends.api) {
      this.backends.api.setAgentCall(fn);
    }
  }

  setRunPunk(fn) {
    this._runPunk = fn;
    if (this.backends.api) {
      this.backends.api.setRunPunk(fn);
    }
  }

  setBrainIndexer(fn) {    this._brainIndexer = fn;
  }

  async initialize(backendOverride) {
    // If we already have backends initialized, just ensure they're ready
    if (this.backends.api) {
      return;
    }

    const onEvent = (projectId, event, requestId) =>
      this.handleBackendEvent(projectId, event, requestId);

    // API backend is always available
    this.backends.api = new ApiBackend(onEvent);
    console.log("[punk] HTTP API backend initialized");

    // Set default backend for backward compatibility
    const settings = await this.loadSettings();
    const backendType = backendOverride || settings.punk_backend || "api";
    this.defaultBackend = this.getBackendForType(backendType);

    // Seed benchmark priors (no-op after first run, refreshes weekly)
    ensurePriors().catch(err =>
      console.warn("[punk] benchmark-scout failed (non-fatal):", err.message)
    );

    // Log learned classifier status at startup (static import already loaded)
    const stats = getClassifierStats();
    if (stats) {
      console.log(`[punk] learned classifier ready (${stats.sampleCount} samples, ${stats.vocabSize} vocab)`);
    } else {
      console.log("[punk] learned classifier initialized");
    }
  }

  /**
   * Get backend instance for a specific backend type.
   * CLI backends have been removed — always returns the API backend.
   */
  getBackendForType(backendType) {
    return this.backends.api;
  }

  /**
   * Route request to appropriate backend based on provider and model.
   * CLI backends have been removed — always returns the API backend.
   */
  getBackendForRequest(request) {
    return this.backends.api;
  }

  /**
   * Get backend availability for UI display.
   * CLI backends have been removed — only the API backend is available.
   */
  getBackendAvailability() {
    return { api: true };
  }

  async reinitialize(backendOverride) {
    // Shutdown the API backend
    if (this.backends.api) {
      await this.backends.api.shutdown().catch(() => {});
      this.backends.api = null;
    }
    
    this.defaultBackend = null;
    
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

  async loadPowerCombo() {
    try {
      const content = await fs.readFile(
        path.join(os.homedir(), ".pane", "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);
      const raw = settings.power_combo;

      // Flat format: { thinking: {...}, execution: {...} }
      if (raw?.thinking && raw?.execution) return raw;

      // Migration: old keyed format { "api": {...}, "claude-code": {...} }
      if (raw && typeof raw === "object") {
        const keyed = raw["claude-code"] || raw["api"] || raw["gemini"];
        if (keyed?.thinking && keyed?.execution) {
          console.log("[punk] migrating keyed power_combo → flat");
          return keyed;
        }
      }

      // Migration: oldest intent_routing format
      const oldRouting = settings.intent_routing;
      if (oldRouting && typeof oldRouting === "object") {
        const r = oldRouting["claude-code"] || oldRouting["api"];
        if (r?.plan && r?.execute) {
          console.log("[punk] migrating intent_routing → power_combo");
          return { thinking: r.plan, execution: r.execute };
        }
      }
    } catch {}

    // Default: Opus thinks, Sonnet builds
    return DEFAULT_POWER_COMBO["claude-code"] || DEFAULT_POWER_COMBO["api"];
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

    // ── Persist SDK model info to model-manager cache ─────────────────────
    if (event.event === "sdk_init_info" && event.data?.models) {
      const sdkModels = event.data.models;
      const normalized = sdkModels.map((m) => {
          const id = m.value || m.id || "";
          const has1m = id.includes("[1m]") || id.includes("1m");
          const isOpus = id.includes("opus");
          const isSonnet = id.includes("sonnet");
          const isDefault = id === "default";
          const context = (has1m || isOpus || isDefault) ? 1000000 : 200000;
          const tier = (isOpus || isDefault) ? 1 : isSonnet ? 2 : 3;

          // Trust the SDK's own display name — never hardcode version numbers,
          // or a newer model hides behind a stale label (e.g. an "Opus 4.6"
          // label pinned over whatever the default alias actually resolves to).
          let name = m.displayName || m.name || id;
          // Mark the default alias only if the SDK name doesn't already say so.
          if (isDefault && !name.toLowerCase().includes("default")) {
            name += " (default)";
          }
          if (has1m && !name.includes("1M") && !name.includes("1m")) name += " (1M)";

          return {
            id,
            name,
            context_length: context,
            provider: "Anthropic",
            tier,
            input_cost: null,
            output_cost: null,
          };
        });
      if (normalized.length > 0 && modelManager.updateModels("anthropic", normalized)) {
        modelManager.saveCache();
        modelManager.notifyRenderer();
      }
    }

    // ── Persist Gemini models ──────────────────────────────────────────
    if (event.event === "gemini_models" && event.data?.models) {
      if (modelManager.updateModels("gemini", event.data.models)) {
        modelManager.saveCache();
        modelManager.notifyRenderer();
      }
      return; // Don't forward to renderer — this is an internal event
    }

    // ── Broadcast SDK account info to ALL windows ─────────────────────────
    // The prefetch sends sdk_init_info with projectId "__prefetch__" which
    // no renderer listens to. Broadcast on a dedicated channel so the
    // Profile settings UI can show auth status immediately.
    if (event.event === "sdk_init_info" && event.data?.account) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send("pane-sdk-auth", {
            models: event.data.models,
            account: event.data.account,
          });
        }
      }
    }

    const channel = `punk-stream:${projectId}`;

    // Attach requestId to the event so the renderer can filter it
    const enrichedEvent = { ...event, requestId };

    // ── Outcome signal capture ─────────────────────────────────────────────
    // Passively accumulate signals from the event stream. No blocking I/O.
    if (requestId && this._activeOutcomes.has(requestId)) {
      const tracked = this._activeOutcomes.get(requestId);

      // Accumulate response text length and full content for extraction.
      // responseText is capped at 200KB to prevent unbounded memory growth
      // that caused 20GB+ runaway processes. The cap is sufficient for
      // principle extraction and memory indexing (the only consumers).
      if (event.event === "message" && event.data?.parsed?.type === "stream_event") {
        const delta = event.data.parsed.data?.delta;
        if (delta?.type === "text_delta" && delta.text) {
          tracked.responseLength += delta.text.length;
          if (tracked.responseText.length < 200_000) {
            tracked.responseText += delta.text;
            if (tracked.responseText.length > 200_000) {
              tracked.responseText = tracked.responseText.slice(0, 200_000);
            }
          }
        }
      }

      // Track tool errors
      if (event.event === "message" && event.data?.parsed?.type === "tool_error") {
        tracked.hadToolErrors = true;
      }

      // ── Quality-based routing adjustment + behavioral fingerprinting ────
      // When the arbiter verdict arrives, adjust the routing score so models
      // that produce low-quality code get deprioritized in future routing.
      // Also record quality metrics to SQLite.
      if (event.event === "arbiter_verdict" && event.data) {
        try {
          const v = event.data;
          let delta = 0;
          if (v.pass && v.score >= 90) delta = +0.05;       // Clean work → small boost
          else if (!v.pass && v.score < 50) delta = -0.20;   // Serious quality failures
          else if (!v.pass && v.score < 70) delta = -0.10;   // Moderate quality issues
          else if (!v.pass) delta = -0.05;                    // Minor issues

          // Suppression attempts are especially bad — intentional evasion
          const suppressions = (v.findings || []).filter(f =>
            f.code === "ts-nocheck" || f.code === "ts-ignore" ||
            f.code === "eslint-disable-file" || f.code === "eslint-disable-line"
          ).length;
          if (suppressions > 0) delta -= 0.10;

          if (delta !== 0) {
            routingStore.adjustOutcomeScore(tracked.outcomeId, delta);
          }

          // Record behavioral fingerprint + correction events (main process has SQLite access).
          try {
            const db = getPaneDb();
            recordQualityMetric(db, {
              projectId: tracked.projectId,
              model: v.model || tracked.model,
              provider: v.provider || tracked.provider,
              verdict: v,
            });
            // Record individual correction events for pattern detection
            if (!v.pass) {
              recordArbiterCorrections(db, tracked.projectId, v, v.model || tracked.model);
            }
          } catch {}

          // Playbook validation loop: the verdict holds injected principles
          // accountable. A finding that matches a principle records a
          // violation; a clean turn slowly reinforces. This is how principle
          // confidence is EARNED rather than assigned.
          if (this._brainRequest) {
            this._brainRequest("playbook_feedback", {
              projectId: tracked.projectId,
              verdict: { pass: v.pass, findings: v.findings || [] },
            }).catch(() => {});
          }
        } catch {}
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

        // ── Fire-and-forget memory extraction ──────────────────────────
        // After each turn, ask "Did anything here matter?" and index
        // findings into the brain knowledge graph. Uses the same quickCall
        // path as principle extraction but asks a more general question:
        // any decision, lesson, pattern, or error_fix discovered this turn.
        if (tracked.projectId && !tracked.projectId.startsWith("mind:") &&
            tracked.userPrompt && tracked.responseText && this.quickCall && this._brainIndexer) {
          const turnMessages = [{ role: "assistant", content: tracked.responseText }];
          extractAndIndex(
            tracked.projectId,
            (sys, usr) => this.quickCall(sys, usr),
            (pid, events) => this._brainIndexer(pid, events),
            turnMessages,
            tracked.userPrompt,
          ).catch(() => {});
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

          // ── Completion Propagation ──────────────────────────────────────
          // If todos were pending at spawn time but fewer are pending now,
          // tasks completed during this turn. Propagate the signal so brain
          // nodes, pins, and mind entries about finished work get decayed.
          if (tracked.pendingTodoCount > 0 && this._brainRequest) {
            try {
              const currentState = readState(tracked.projectId);
              const currentPending = (currentState?.todos || []).filter(t => t.status !== "completed").length;
              const completed = (currentState?.todos || []).filter(t => t.status === "completed");
              if (currentPending < tracked.pendingTodoCount && completed.length > 0) {
                const taskDesc = currentState?.activeTask?.description || tracked.userPrompt?.slice(0, 200) || "";
                propagateCompletion(tracked.projectId, {
                  taskDescription: taskDesc,
                  completedTodos: completed.map(t => t.content),
                  brainRequest: this._brainRequest,
                }).catch(err => console.warn("[punk] completion propagation failed:", err.message));
              }
            } catch {}
          }
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
    // Estimate serialized size via JSON. For small events (<500KB) this is
    // near-instant. For large events (multi-MB tool results), JSON.stringify
    // cost is dwarfed by the structured clone in webContents.send.
    // Threshold: 500KB — well above any normal event (text deltas, status
    // updates, tool_use metadata), catches only rare multi-MB tool results.
    const CHUNK_THRESHOLD = 512 * 1024; // 512KB
    let json;
    try { json = JSON.stringify(event); } catch {
      // Circular reference or other serialization issue — fall through to
      // the normal path and let webContents.send's structured clone handle it.
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, event);
      }
      return;
    }
    if (json.length > CHUNK_THRESHOLD) {
      // Split into 256KB chunks. Each chunk is sent as a separate IPC message
      // with _chunkMeta so the renderer can reassemble. Chunk data is a string,
      // which structured clone handles efficiently (zero-copy string sharing).
      const CHUNK_SIZE = 256 * 1024;
      const total = Math.ceil(json.length / CHUNK_SIZE);
      for (let i = 0; i < total; i++) {
        const chunkPayload = {
          _chunkMeta: {
            total,
            index: i,
            type: event.event,
            requestId: event.requestId,
          },
          _chunkData: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        };
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(channel, chunkPayload);
        }
      }
      console.log(
        `[punk] Chunked large IPC event (${(json.length / 1024).toFixed(1)}KB → ${total} chunks) on channel "${channel}"`
      );
      return;
    }
    // Normal path — small event, send as-is
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }
  }

  drainRelayQueue() {
    if (this.relayDraining) return;
    this.relayDraining = true;

    // Process dynamically-batched events per setImmediate tick.
    // During a burst (e.g. post-compaction event flood), we scale the
    // batch size with queue depth so the drain completes in fewer ticks.
    // Under normal load, we stay at the minimum of 16 per tick.
    const MIN_BATCH = 16;
    const MAX_BATCH = 128;
    const BATCH_SIZE = Math.min(
      MAX_BATCH,
      Math.max(MIN_BATCH, Math.ceil(this.relayQueue.length / 4)),
    );

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

    // ── Correction detection: track user negation patterns ──────────────
    // If the user's message starts with "no", "don't", "wrong", "revert",
    // etc., record it as a correction event for pattern detection.
    if (resolvedRequest.prompt && resolvedRequest.history?.length > 0) {
      if (isUserCorrection(resolvedRequest.prompt)) {
        try {
          const db = getPaneDb();
          recordUserCorrection(
            db,
            resolvedRequest.projectId,
            "user-negation",
            resolvedRequest.prompt.slice(0, 200),
            resolvedRequest.model,
          );
        } catch {}

        // The correction itself is the gold: a human stating a standard. Capture
        // the PAIR (what was rejected → what was demanded) as a high-signal node
        // so reflection can distill it into a durable principle. This is the
        // friction-point capture — born high-signal, not mined from exhaust.
        if (this._brainIndexer) {
          const evt = buildUserCorrectionEvent(resolvedRequest.prompt, resolvedRequest.history);
          if (evt) this._brainIndexer(resolvedRequest.projectId, [evt]).catch(() => {});
        }
      }
    }

    // ── INTELLIGENCE ──────────────────────────────────────────────────────
    // Qwen local model is the sole classifier — strategy + task type + context
    // shape in a single ~50-100ms inference pass. No heuristic fallback.
    //
    const sessionState = readState(resolvedRequest.projectId);
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
    } else if (resolvedRequest.phase) {
      // ── Phase system — single source of truth ──
      // The renderer sends the sticky phase (think/build/verify/idle).
      // Phase is set explicitly by user or approval patterns — never per-message classified.
      const phaseStrategies = {
        think:  { mode: "analyze", discovery: true,  reasoning: "deep",    verification: "none" },
        build:  { mode: "direct",  discovery: false, reasoning: "shallow", verification: "diff" },
        idle:   { mode: "direct",  discovery: false, reasoning: "shallow", verification: "none" },
      };
      const phaseStrat = phaseStrategies[resolvedRequest.phase] || phaseStrategies.build;
      strategy = { ...phaseStrat, confidence: 1.0, reason: `phase: ${resolvedRequest.phase}`, signals: [] };
      // Map phase to intent for context assembly
      const phaseToIntent = { think: "plan", build: "execute", idle: "execute" };
      resolvedRequest.intent = phaseToIntent[resolvedRequest.phase] || resolvedRequest.intent;
      // Strip any leading slash directive the renderer may have prepended
      resolvedRequest.prompt = (resolvedRequest.prompt || "").replace(/^\/[\w]+\s*/, "").trim();
      console.log(`[punk] phase → ${resolvedRequest.phase} (strategy: ${strategy.mode}, intent: ${resolvedRequest.intent})`);
    } else {
      // ── Heuristic routing — zero-latency deterministic classification ──
      // Replaces the LLM classifier call with a pure algorithmic approach.
      // Thread-state tracks consecutive failures for escalation stages 0-4.

      const settings = await this.loadSettings();
      try {
        // Determine effective backend from the user's active provider.
        // anthropic uses the API backend (OAuth or API key) — claude-code binary removed.
        const _activeProvider = settings.selected_model_provider || null;
        const _providerBackendMap = { gemini: "gemini" };
        const _effectiveBackend = _providerBackendMap[_activeProvider]
          || settings.punk_backend || "api";

        catalogData = {
          backend:  _effectiveBackend,
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
    const combo     = request.powerCombo ?? (await this.loadPowerCombo());

    // Phase-based fallback route: think/verify → thinking model, build/idle → execution model
    const phase = resolvedRequest.phase || "build";
    const comboSlot = phase === "think" ? "thinking" : "execution";
    if (!resolvedRequest.intent) resolvedRequest.intent = comboSlot === "thinking" ? "plan" : "execute";

    const intentRoute = combo[comboSlot] || combo["execution"];

    // When autoRoute is off the user has pinned a model — respect it exactly.
    // When autoRoute is on the router owns model selection entirely.
    const userExplicitOverride = !autoRoute;

    // Escalation level from heuristic router (already computed, not from old struggle detection)
    let escalationLevel = localDecision?.escalationStage ?? 0;

    if (userExplicitOverride) {
      // User has pinned a model — always respect their pick.
      // Phase affects strategy (mode, discovery, reasoning) but NOT model selection.
      resolvedRequest.thinking = request.thinking ?? false;
      console.log(`[punk] user model lock → ${resolvedRequest.provider}/${resolvedRequest.model}`);
    } else if (localDecision?.modelTier && autoRoute) {
      // ── Heuristic tier → concrete model resolution ──
      // The heuristic router returns a tier (cheap/mid/capable/frontier).
      // Within-phase escalation: base provider comes from the active combo slot.
      const tier = localDecision.modelTier;
      const isGemini = catalogData?.backend === "gemini";
      const baseProvider = isGemini ? "gemini" : (intentRoute?.provider || "anthropic");

      const TIER_MODELS = {
        gemini: { cheap: "gemini-3-flash-preview", mid: "gemini-3-flash-preview", capable: "gemini-3-flash-preview", frontier: "gemini-3-flash-preview" },
        anthropic: { cheap: "haiku", mid: "sonnet", capable: "sonnet", frontier: "opus" },
      };
      const tierMap = TIER_MODELS[baseProvider] || TIER_MODELS.anthropic;

      resolvedRequest.provider = baseProvider;
      resolvedRequest.model    = tierMap[tier] || tierMap.mid;
      resolvedRequest.thinking = strategy.reasoning === "deep";

      // For API backend, check key availability and remap if needed.
      // anthropic is exempt — OAuth covers it without an explicit API key.
      if (catalogData?.backend === "api") {
        const keys = catalogData.apiKeys || {};
        if (!keys[resolvedRequest.provider] && resolvedRequest.provider !== "anthropic") {
          const firstWithKey = Object.entries(keys).find(([, k]) => !!k)?.[0];
          if (firstWithKey) {
            console.log(`[punk] heuristic route ${resolvedRequest.provider} has no key → redirect to ${firstWithKey}`);
            resolvedRequest.provider = firstWithKey;
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

      // Ensure fallback has a key. anthropic is exempt — OAuth covers it.
      if (catalogData?.backend === "api") {
        const keys = catalogData.apiKeys || {};
        if (!keys[resolvedRequest.provider] && resolvedRequest.provider !== "anthropic") {
          const firstWithKey = Object.entries(keys).find(([, k]) => !!k)?.[0];
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

    // Write local decision to ContextStore (in-memory) so context-orchestrator
    // reads it immediately — no stale JSON file. Disk write happens via
    // debounced serialization for crash recovery.
    if (localDecision && resolvedRequest.projectId) {
      contextStore.updateContextShape(resolvedRequest.projectId, localDecision);
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
            path.join(os.homedir(), ".pane", "memory", resolvedRequest.projectId, "about.md"), "utf-8"
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
            model:       resolvedRequest.model ?? null,
            projectWhy,
          }),
          searchTimeout,
        ]);
      } catch (err) {
        console.warn("[punk] brain contextual search failed (non-fatal):", err.message);
      }
    }

    // ── PINNED MIND INJECTION ──────────────────────────────────────────────
    // If the user explicitly selected @thought references, guarantee those
    // mind entries appear first in the brain context — before any semantic
    // results — regardless of their embedding similarity score.
    //
    // The brain search has already written {projectId}.json; we patch it here
    // so compileContext picks up the pinned entries automatically.
    if (resolvedRequest.minds?.length && resolvedRequest.projectId) {
      try {
        const db = getPaneDb()
        const mindStmt = db.prepare("SELECT id, content FROM mind_entries WHERE id = ?")
        const pinnedMinds = resolvedRequest.minds
          .map(m => {
            const row = mindStmt.get(m.id)
            return row ? { id: row.id, content: row.content, score: 1.0 } : null
          })
          .filter(Boolean)

        if (pinnedMinds.length > 0) {
          const contextPath = path.join(os.homedir(), ".pane", "brain", "context", `${resolvedRequest.projectId}.json`)
          try {
            const raw = await fs.readFile(contextPath, "utf-8")
            const brainCtx = JSON.parse(raw)
            const existing = brainCtx.mindEntries || []
            const pinnedIds = new Set(pinnedMinds.map(m => m.id))
            // Prepend pinned first, then semantic results not already pinned
            brainCtx.mindEntries = [
              ...pinnedMinds,
              ...existing.filter(m => !pinnedIds.has(m.id)),
            ]
            await fs.writeFile(contextPath, JSON.stringify(brainCtx))
            console.log(`[punk] pinned ${pinnedMinds.length} @thought reference(s) into brain context`)
          } catch (err) {
            // Context file may not exist if brain search timed out or is unavailable.
            // In that case, write a minimal context with just the pinned minds.
            if (err.code === "ENOENT") {
              try {
                await fs.mkdir(path.join(os.homedir(), ".pane", "brain", "context"), { recursive: true })
                await fs.writeFile(contextPath, JSON.stringify({ mindEntries: pinnedMinds }))
                console.log(`[punk] wrote minimal brain context with ${pinnedMinds.length} pinned @thought reference(s)`)
              } catch (writeErr) {
                console.warn("[punk] Failed to write pinned mind context:", writeErr.message)
              }
            } else {
              console.warn("[punk] Failed to patch brain context with pinned minds:", err.message)
            }
          }
        }
      } catch (err) {
        console.warn("[punk] Failed to resolve pinned @thought references:", err.message)
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

    // ── ANALYZE MODE ──────────────────────────────────────────────────────
    // Think phase — read-only deep investigation.
    // The model explores broadly, traces connections, and reports findings
    // without modifying any files.
    if (!resolvedRequest._systemOverride && strategy.mode === "analyze") {
      console.log("[punk] ANALYZE mode — deep reading, no execution");
      resolvedRequest.phase = "analyze";
      resolvedRequest._systemPrepend =
        "ANALYZE: You are in analysis mode. Read broadly, trace connections across the codebase, " +
        "and report findings with structured implications and recommendations. " +
        "Do NOT modify any files. Do NOT use write_file, replace, or bash to make changes. " +
        "Use read_file, glob, search, and grep to investigate. " +
        "Structure your response with clear sections: findings, root causes, implications, and next steps.";
      const backend = this.getBackendForRequest(resolvedRequest);
      await backend.spawn(resolvedRequest);
      return;
    }

    try {
      console.log(
        `[punk] spawn attempt: ${resolvedRequest.provider}/${resolvedRequest.model} (thinking=${resolvedRequest.thinking})`,
      );
      
      // Get appropriate backend for this request
      const backend = this.getBackendForRequest(resolvedRequest);
      
      await backend.spawn(resolvedRequest);
    } catch (err) {
      console.error(`[punk] spawn failed: ${err.message}`);
      throw err;
    }
  }

  // _orchestrate() and _verifyExecution() removed — replaced by the Think/Build
  // phase system where the user is the coordinator, not Pane's code.
  // The human-in-the-loop model (Think → review → Build) is more robust than
  // automated plan→execute→verify pipelines.

  async abort(projectId) {
    if (this.backends.api) {
      await this.backends.api.abort(projectId).catch(() => {});
    }
  }

  // Whether a message sent while projectId's task is running should steer
  // into it or queue for after — see ApiBackend.classifySteerIntent.
  classifySteerIntent(projectId, message) {
    if (!this.backends.api) return { decision: "queue", reason: "no-backend" };
    return this.backends.api.classifySteerIntent(projectId, message);
  }

  // Queue a message for injection into the running task at its next turn
  // boundary — see ApiBackend.steer.
  steer(projectId, message) {
    if (!this.backends.api) return { accepted: false };
    return this.backends.api.steer(projectId, message);
  }

  async terminate(projectId) {
    if (this.backends.api) {
      await this.backends.api.terminate(projectId).catch(() => {});
    }
  }

  /**
   * Preview what model the router would pick for a given message.
   * Lightweight — no API calls, no state changes. Used by the UI to show
   * the predicted model as the user types.
   *
   * CRITICAL: Only picks from models in the user's configured routing table.
   * No surprise models, no providers the user hasn't set up.
   */
  async previewRoute(message, projectId) {
    const autoRoute = await this.loadIntentAutoRoute();
    if (!autoRoute) return null; // User has pinned a model — no preview needed

    const settings = await this.loadSettings();
    const combo = await this.loadPowerCombo();

    try {
      const state = readState(projectId);
      const threadState = readThreadState(projectId);

      const decision = await routeIntegrated({
        message:        message || "",
        turnCount:      0,
        workingSetSize: state?.workingSet?.length || 0,
        pendingTodos:   (state?.todos || []).filter(t => t.status !== "completed").length,
        phase:          state?.phase || "idle",
        threadState: {
          consecutiveFailures: threadState?.consecutiveFailures || 0,
          lastFailureType:     threadState?.lastFailureType || null,
          approachesTried:     threadState?.approachesTried?.length || 0,
          lastResponseSummary: null,
          lastUserPromptHash:  null,
        },
        backend: settings.punk_backend || "api",
      });

      if (!decision?.modelTier) return null;

      // Map tier to concrete model from the user's power combo.
      // frontier tier → thinking model, everything else → execution model.
      const tier = decision.modelTier;
      const route = tier === "frontier"
        ? (combo["thinking"] || combo["execution"])
        : (combo["execution"] || combo["thinking"]);

      if (!route) return null;

      return {
        model:      route.model,
        provider:   route.provider,
        tier,
        mode:       decision.mode,
        taskType:   decision.taskType,
        confidence: decision.confidence,
        reason:     decision.reason,
      };
    } catch {
      return null;
    }
  }

  shutdown() {
    // Shutdown the API backend
    if (this.backends.api) {
      try { this.backends.api.shutdown(); } catch { /* best-effort during app quit */ }
    }
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
    const settings = await this.loadSettings();
    const autoRoute = await this.loadIntentAutoRoute();

    let request;

    if (!autoRoute) {
      // Smart routing OFF — use the exact model the user pinned.
      request = {
        provider: settings.selected_model_provider || null,
        model: settings.selected_model || null,
        thinking: false,
      };
    } else {
      // Smart routing ON — use the execution slot from the power combo
      // (the lighter of the two models the user configured).
      const combo = await this.loadPowerCombo();
      const explainRoute = combo["execution"] || combo["thinking"] || {};
      request = {
        provider: explainRoute.provider || settings.selected_model_provider || null,
        model: explainRoute.model || settings.selected_model || null,
        thinking: false,
      };
    }

    // For API-routed providers, ensure we have a key.
    const isCliProvider = request.provider === "anthropic" || request.provider === "gemini";
    if (!isCliProvider) {
      const keys = settings.http_api_keys || {};
      const currentProvider = request.provider || "deepseek";

      if (!keys[currentProvider]) {
        const firstWithKey = Object.entries(keys).find(([, k]) => !!k)?.[0];
        if (firstWithKey) {
          request.provider = firstWithKey;
          request.model = null;
          console.log(`[punk] quickCall: ${currentProvider} has no key, switching to ${firstWithKey}`);
        }
      }
    }

    const backend = this.getBackendForRequest(request);
    console.log(`[punk] quickCall → ${request.provider}/${request.model} (autoRoute=${autoRoute})`);
    return backend.planningCall(systemPrompt, userPrompt, request);
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
  /**
   * Spawn a sub-agent for delegated work.
   *
   * @param {string} systemPrompt - System prompt for the sub-agent
   * @param {string} prompt - User prompt / objective
   * @param {string} workingDir - Project root directory
   * @param {object} [options]
   * @param {'think'|'execution'} [options.phase='think'] - Phase: 'think' = read-only, 'execution' = full read/write
   * @param {number} [options.maxTurns=50] - Max turns (0 = effectively unlimited → 500)
   * @param {string[]} [options.extraTools=[]] - Additional tool names to include
   */
  async agentCall(systemPrompt, prompt, workingDir, options = {}) {
    const {
      phase = 'think',
      maxTurns = 50,
      extraTools = [],
    } = options;

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

    // Base toolkit: navigation, code intelligence, memory, architecture, verification
    const baseTools = [
      // Navigation
      'Read', 'read_file', 'pane_read_files', 'pane_directory',
      'Glob', 'glob', 'Grep', 'grep_search',
      // Code intelligence
      'pane_find_symbol', 'pane_find_references', 'pane_codebase_compass',
      'pane_codebase_navigator', 'explore',
      // Project context & memory
      'pane_project_context', 'pane_brief',
      'pane_recall', 'pane_knowledge_graph', 'pane_profile',
      // Architecture & design constraints
      'pane_architecture_brief', 'pane_ui_constraints',
      // History
      'pane_change_history', 'pane_search_changes',
      // Verification
      'pane_run_in_terminal',
    ];

    // Execution phase: add write tools, memory persistence, checkpoints, task tracking
    const execTools = phase === 'execution' ? [
      'write_file', 'replace',
      'pane_checkpoint', 'pane_checkpoints', 'pane_revert_change',
      'pane_remember', 'TodoWrite', 'ask_user',
      'google_web_search', 'web_fetch',
    ] : [];

    const tools = [...baseTools, ...execTools, ...extraTools];
    const effectiveMaxTurns = maxTurns > 0 ? maxTurns : 500; // 0 = unlimited → 500

    await this.spawn({
      projectId,
      prompt,
      workingDir,
      model: null,
      intent: 'other',
      history: [],
      requestId,
      todos: null,
      tools,
      phase,                         // 'think' = read-only thinker slot, 'execution' = full builder slot
      maxTurns: effectiveMaxTurns,
      systemPromptOverride: systemPrompt,
      _systemOverride: true,
      noExec: false,
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

/**
 * Register all punk IPC handlers synchronously — safe to call before backends
 * are initialized. Each handler that needs backends (spawn, quickCall, etc.)
 * lazy-initializes via `await this.initialize()` internally.
 */
export function registerPunkHandlersSync() {
  ipcMain.handle("send_to_punk", async (_event, args) => {
    const {
      projectId,
      prompt,
      workingDir,
      model,
      intent,
      history,
      requestId,
      thinking,
      provider,
      todos,
      autoRoute,
      powerCombo,
      minds,
      phase,
      wasInterrupted,
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
      model,
      intent,
      history,
      requestId,
      thinking,
      provider,
      todos,
      autoRoute,
      powerCombo,
      minds,
      phase,
      ...(wasInterrupted ? { wasInterrupted } : {}),
      ...(systemPromptOverride ? { systemPromptOverride } : {}),
      ...(_systemOverride ? { _systemOverride } : {}),
      ...(tools ? { tools } : {}),
      ...(maxTurns ? { maxTurns } : {}),
    });
  });

  ipcMain.handle("abort_punk", async (_event, args) => {
    await punkEngine.abort(args.projectId);
  });

  // Preview what model the router would pick — used by InputBar to show
  // the predicted model as the user types. Lightweight, no side effects.
  ipcMain.handle("preview_route", async (_event, args) => {
    return punkEngine.previewRoute(args.message, args.projectId);
  });

  // Classify a message sent while a task is running as steer-into-current
  // vs queue-for-after. Lightweight, no side effects.
  ipcMain.handle("classify_steer_intent", async (_event, args) => {
    return punkEngine.classifySteerIntent(args.projectId, args.message);
  });

  // Inject a message into the running task at its next turn boundary.
  ipcMain.handle("steer_punk", async (_event, args) => {
    return punkEngine.steer(args.projectId, args.message);
  });

  ipcMain.handle("send_to_mind", async (_event, args) => {
    const { threadId, prompt, workingDir, model, provider, thinking, requestId, entryContent } = args;
    console.log(`[pane] Mind chat: thread=${threadId}, prompt=${(prompt || "").slice(0, 60)}`);
    const mindSystemPrompt =
      "You are a thinking partner inside Pane Mind. You help the user think through ideas by exploring code, finding relevant patterns, and offering analysis. You can read files and search the codebase but CANNOT write, edit, or execute anything. Be concise and direct. No emojis.\n\nThe thought being explored:\n" +
      (entryContent || "");
    await punkEngine.spawn({
      projectId: "mind:" + threadId,
      prompt,
      workingDir,
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
    const { postId, prompt, workingDir, model, provider, thinking, requestId, postContent } = args;
    console.log(`[pane] Lens chat: post=${postId}, prompt=${(prompt || "").slice(0, 60)}`);
    const lensSystemPrompt =
      "You are a focused collaborator inside Pane Lens. The user is discussing a specific observation about their codebase. Help them explore it — answer questions, find related code, surface implications. Be concise and direct. No emojis.\n\nThe observation:\n" +
      (postContent || "");
    await punkEngine.spawn({
      projectId: "lens:" + postId,
      prompt,
      workingDir,
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

  ipcMain.handle("get_openrouter_models", async () => {
    return await modelManager.models["openrouter"] || [];
  });

  ipcMain.handle("get_all_models", async () => {
    return await modelManager.models;
  });

  // ── Memory Diagnostics ─────────────────────────────────────────────────
  // Snapshots the main process memory state. Call from renderer or terminal
  // when a leak is suspected. Returns V8 heap + OS-level RSS in MB.
  //
  // Usage from terminal:
  //   echo 'require("electron").ipcMain.emit("get_memory_info")' | ...
  // Or from renderer DevTools:
  //   await window.electronAPI.getMemoryInfo()
  ipcMain.handle("get_memory_info", async () => {
    const usage = process.memoryUsage();
    const resource = process.resourceUsage ? process.resourceUsage() : null;
    let v8heap = null;
    try {
      const { default: v8 } = await import("node:v8");
      v8heap = v8.getHeapStatistics();
    } catch {}

    return {
      timestamp: Date.now(),
      pid: process.pid,
      memory: {
        rss_mb:        Math.round(usage.rss / 1024 / 1024),
        heap_total_mb: Math.round(usage.heapTotal / 1024 / 1024),
        heap_used_mb:  Math.round(usage.heapUsed / 1024 / 1024),
        external_mb:   Math.round(usage.external / 1024 / 1024),
        array_buffers_mb: usage.arrayBuffers
          ? Math.round(usage.arrayBuffers / 1024 / 1024)
          : null,
      },
      resource_usage: resource ? {
        max_rss_mb:         Math.round(resource.maxRSS / 1024),
        shared_mb:          Math.round(resource.sharedSize / 1024),
        unshared_data_mb:   Math.round(resource.unsharedDataSize / 1024),
        unshared_stack_mb:  Math.round(resource.unsharedStackSize / 1024),
      } : null,
      v8_heap: v8heap ? {
        total_heap_size_mb:       Math.round(v8heap.total_heap_size / 1024 / 1024),
        total_heap_executable_mb: Math.round(v8heap.total_heap_size_executable / 1024 / 1024),
        total_physical_mb:        Math.round(v8heap.total_physical_size / 1024 / 1024),
        used_heap_mb:             Math.round(v8heap.used_heap_size / 1024 / 1024),
        heap_size_limit_mb:       Math.round(v8heap.heap_size_limit / 1024 / 1024),
        mallocated_mb:            Math.round(v8heap.malloced_memory / 1024 / 1024),
        peak_mallocated_mb:       Math.round(v8heap.peak_malloced_memory / 1024 / 1024),
        number_of_native_contexts: v8heap.number_of_native_contexts,
        number_of_detached_contexts: v8heap.number_of_detached_contexts,
      } : null,
    };
  });

  // ── Pane-native Claude OAuth ──────────────────────────────────────────────

  ipcMain.handle("pane_claude_login", async () => {
    const { startLogin } = await import("./claude-login.mjs");
    const result = await startLogin({
      onStatus: (status) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send("pane-claude-signin", { type: "status", output: [status] });
          }
        }
      },
    });
    if (result.success) {
      const { invalidateCache } = await import("./claude-oauth.mjs");
      invalidateCache();
    }
    return result;
  });

  ipcMain.handle("pane_claude_logout", async () => {
    const { clearCredentials } = await import("./claude-login.mjs");
    await clearCredentials();
    const { invalidateCache } = await import("./claude-oauth.mjs");
    invalidateCache();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("pane-sdk-auth", { account: null, models: null });
      }
    }
    return { success: true };
  });

  ipcMain.handle("pane_claude_auth_state", async () => {
    const { getAuthState } = await import("./claude-login.mjs");
    return await getAuthState();
  });
}

/**
 * Initialize the punk engine backends. Call in background after the window is shown.
 */
export async function initPunkBackend() {
  await punkEngine.initialize();
}

/**
 * Backwards-compat: register handlers AND initialize backends.
 */
export async function registerPunkHandlers() {
  registerPunkHandlersSync();
  await punkEngine.initialize();
}

/**
 * Deterministic fast-path classifier for trivially obvious intents.
 * Only fires on inputs so clear that calling the LLM is pure waste.
 * Returns a full decision object (same shape as parseDecision output)
 * or null to fall through to the LLM classifier.
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

export function shutdownPunkWorker() {
  punkEngine.shutdown();
}
