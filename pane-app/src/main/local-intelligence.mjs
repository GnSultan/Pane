// ============================================================================
// Local Intelligence — IPC proxy to the brain UtilityProcess.
// ============================================================================
//
// The Qwen2.5-0.5B model lives in brain-engine.mjs (UtilityProcess) to avoid
// crashing the main process with a 512MB WASM load alongside Chromium's V8 heap.
//
// This module is the interface layer: main.mjs injects the brain sender once at
// startup, and punk-engine calls classify() exactly as before.

// ── State ────────────────────────────────────────────────────────────────────

let _brainSend = null;     // injected by main.mjs via setBrainSender()
let _ready = false;        // true once brain reports local_intel_ready
let _loadError = null;
let _loading = false;

let _classifyCounter = 0;
const _pendingClassify = new Map(); // requestId → { resolve, timeout }

// Progress listeners (for UI download progress bar)
const _listeners = new Set();

// ── Public API ───────────────────────────────────────────────────────────────

export function isReady()     { return _ready; }
export function getLoadError(){ return _loadError; }

export function onProgress(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

/**
 * Called by main.mjs once at startup. Provides the channel to the brain worker.
 * Using a getter fn so the call always goes to the current worker even after restarts.
 */
export function setBrainSender(fn) {
  _brainSend = fn;
}

/**
 * Called by main.mjs when a message arrives from the brain worker that belongs
 * to local intelligence (local_intel_ready, local_intel_result, local_intel_error).
 */
export function handleBrainMessage(message) {
  if (message.type === "local_intel_ready") {
    _ready = true;
    _loading = false;
    _loadError = null;
    console.log("[local-intel] Model loaded and ready (brain UtilityProcess)");
    _emit({ status: "ready", message: "Local intelligence ready" });
  }

  if (message.type === "local_intel_error") {
    _loading = false;
    _loadError = message.error || "Unknown error";
    _emit({ status: "error", message: _loadError });
  }

  if (message.type === "local_intel_result") {
    const pending = _pendingClassify.get(message.requestId);
    if (pending) {
      _pendingClassify.delete(message.requestId);
      clearTimeout(pending.timeout);
      pending.resolve(message.result ?? null);
    }
  }
}

/**
 * Called by main.mjs when the brain worker exits (process crashed or restarted).
 * Resets ready state so classify() falls back to heuristics until brain reloads.
 */
export function resetIntelReady() {
  _ready = false;
  _loading = false;
  // Reject pending classify requests
  for (const [id, pending] of _pendingClassify) {
    clearTimeout(pending.timeout);
    pending.resolve(null);
  }
  _pendingClassify.clear();
}

/**
 * Trigger model load in the brain UtilityProcess. Idempotent.
 */
export async function load() {
  if (_ready || _loading || !_brainSend) return;
  _loading = true;
  _loadError = null;
  _emit({ status: "loading", message: "Loading local intelligence model..." });
  _brainSend({ type: "local_intel_load" });
}

/**
 * Classify a user message. Returns a LocalDecision — sole classifier, no fallback.
 *
 * Deadline: 500ms. The first call per session takes ~300-500ms (WASM JIT
 * compilation on first inference). Subsequent calls are ~50-150ms, well under
 * the deadline. The caller (punk-engine) awaits readiness before calling.
 */
export async function classify(input) {
  if (!_ready || !_brainSend) return null;

  return new Promise((resolve) => {
    const requestId = `intel-${++_classifyCounter}`;
    const timeout = setTimeout(() => {
      _pendingClassify.delete(requestId);
      console.warn(`[local-intel] classify timed out (${requestId})`);
      resolve(null);
    }, 500);
    _pendingClassify.set(requestId, { resolve, timeout });
    _brainSend({ type: "local_intel_classify", requestId, input });
  });
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _emit(event) {
  for (const fn of _listeners) {
    try { fn(event); } catch { /* listener errors don't propagate */ }
  }
}

// ── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {object} LocalDecision
 * @property {string} mode           — direct|orchestrate|discuss
 * @property {boolean} discovery     — run alignment conversation before planning?
 * @property {string} reasoning      — shallow|deep
 * @property {string} verification   — none|diff|test
 * @property {string} taskType       — debug|implement|explain|architect|refactor|review|conversation|quick-answer|other
 * @property {string} complexity     — low|medium|high
 * @property {boolean} preferFrontier — should this go to a frontier model?
 * @property {string[]} atomHints    — keywords to bridge atom selection vocabulary gap
 * @property {number} historyDepth   — suggested conversation history depth (1-20)
 * @property {boolean} includeBrief  — include project brief in context?
 * @property {string} fileDepth      — none|names|shallow|deep
 */
