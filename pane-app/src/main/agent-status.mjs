/**
 * Agent status — authoritative per-thread status store for Pane.
 *
 * Purpose: give the voice layer (and any future monitoring UI) a single
 * deterministic source of truth for what every thread's agent is doing:
 * current phase, read-only vs editing, recent actions, and agent identity.
 *
 * Why not reuse intents.ndjson: activities are an append-only log
 * reconstructed into a view — voice would be guessing state from partial
 * records. This store is written at the exact phase-transition points by
 * the executor itself (http-backend turn loop, tool-executor), so a read
 * returns current state plus a bounded event ring, never a reconstruction.
 *
 * Security model:
 *   - The store accepts a FIXED schema. There is no free-form "detail"
 *     field, so user prompts, file contents, and command output can never
 *     enter it (contrast: intents.mjs stores 200-char prompt excerpts).
 *   - Voice reads go through voiceSnapshot(), which projects each record
 *     through VOICE_SAFE_FIELDS — a whitelist pick. Fields added to the
 *     store later are invisible to voice until explicitly whitelisted.
 *   - File paths are stored as basenames only (last path segment) — enough
 *     to say "editing Profile.tsx", never enough to expose directory
 *     structure or content.
 *   - No secrets, tokens, or API keys pass through this module, ever.
 *
 * Scoping: single-user local app; every thread belongs to the same user.
 * The point of the store IS cross-thread visibility (multi-agent
 * awareness), so voiceSnapshot() returns all threads. Tenancy is enforced
 * upstream: the renderer only ever renders threads the user opened, and
 * the voice relay reads this store read-only.
 *
 * Lifecycle: in-memory only. It is live monitoring state, not history —
 * persisting would recreate the stale-reconstruction problem this module
 * exists to solve. Stale threads (no event within STALE_MS) are marked
 * stale and excluded from "active" counts but still listed.
 */

/** Phase vocabulary — the standard set of progress events. */
const PHASES = new Set([
  "idle", // no run in flight
  "planning", // read-only exploration / thinking phase
  "editing", // write tools available / write executed
  "waiting", // agent called ask_user, paused for the user
  "done", // run finished cleanly (terminal; next turn resets to planning/idle)
  "error", // run aborted (terminal)
]);

/** Fields voice is ever allowed to see. Whitelist pick — nothing else. */
const VOICE_SAFE_FIELDS = [
  "threadId",
  "threadName",
  "phase",
  "readOnly",
  "currentTool",
  "lastFile",
  "turnCount",
  "agent",
  "updatedAt",
  "updatedAtAgoSec",
  "stale",
  "events",
];

/** Max events kept per thread (ring). Playbook: cap every buffer. */
const MAX_EVENTS = 20;

/** A thread with no event for this long is stale (matches intents TTL). */
const STALE_MS = 30 * 60 * 1000;

/** Max chars for any string we store — defensive, schema is already tight. */
const MAX_STR = 120;

// ── Store ────────────────────────────────────────────────────────────────

/** @type {Map<string, {threadId: string, threadName: string, phase: string, readOnly: boolean, currentTool: string|null, lastFile: string|null, turnCount: number, agent: string|null, updatedAt: number, events: Array<{ts: number, phase: string, tool?: string, file?: string}>}>} */
const threads = new Map();

/** Tests reset state; production never calls this. */
export function _resetForTest() {
  threads.clear();
  _lastTs = 0;
}

/**
 * Monotonic timestamp: wall clock, but never equal to or lower than the
 * previous issued value. Two transitions in the same millisecond would
 * otherwise tie and make recency sorting non-deterministic — voice must
 * never see events out of order.
 */
let _lastTs = 0;
function nextTs() {
  const now = Date.now();
  const ts = now > _lastTs ? now : _lastTs + 1;
  _lastTs = ts;
  return ts;
}

/**
 * Basename only — the last path segment of whatever path-ish thing arrived.
 * Handles forward slashes and backslashes; null-safe.
 * @param {string|undefined|null} p
 * @returns {string|null}
 */
function basename(p) {
  if (typeof p !== "string" || !p) return null;
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1].slice(0, MAX_STR) : null;
}

/**
 * Record a phase transition. Fixed schema — extra fields on `opts` are
 * ignored, unknown phases are ignored (store unchanged), and strings are
 * clamped. Failures never throw: monitoring must not break execution.
 *
 * @param {string} projectId
 * @param {object} opts
 * @param {string} opts.phase — one of PHASES
 * @param {boolean} [opts.readOnly] — true when the run's toolset is read-only
 * @param {string|null} [opts.tool] — tool currently executing
 * @param {string|null} [opts.file] — file involved (stored as basename)
 * @param {number} [opts.turn] — turn number within the run
 * @param {string|null} [opts.agent] — agent identity, e.g. "gpt-5.6-sol@openai"
 * @param {string|null} [opts.threadName] — display name when known
 */
export function setPhase(projectId, opts = {}) {
  if (typeof projectId !== "string" || !projectId) return;
  const phase = opts.phase;
  if (!PHASES.has(phase)) return; // unknown phase → no write, store stays valid

  let rec = threads.get(projectId);
  if (!rec) {
    rec = {
      threadId: projectId,
      threadName: "",
      phase: "idle",
      readOnly: true,
      currentTool: null,
      lastFile: null,
      turnCount: 0,
      agent: null,
      updatedAt: 0,
      events: [],
    };
    threads.set(projectId, rec);
  }

  const prevPhase = rec.phase;
  const ts = nextTs();

  rec.phase = phase;
  if (typeof opts.readOnly === "boolean") rec.readOnly = opts.readOnly;
  else if (phase === "editing") rec.readOnly = false; // phase implies it — never contradictory
  if (opts.tool === null) rec.currentTool = null;
  else if (typeof opts.tool === "string" && opts.tool) rec.currentTool = opts.tool.slice(0, MAX_STR);
  const f = basename(opts.file);
  if (f) rec.lastFile = f;
  if (typeof opts.turn === "number" && Number.isFinite(opts.turn)) rec.turnCount = opts.turn;
  if (typeof opts.agent === "string" && opts.agent) rec.agent = opts.agent.slice(0, MAX_STR);
  if (typeof opts.threadName === "string" && opts.threadName) rec.threadName = opts.threadName.slice(0, MAX_STR);
  rec.updatedAt = ts;

  // Event ring: append every transition (even repeated phases — a tool call
  // mid-run re-asserts liveness), then trim to the cap.
  const ev = { ts, phase };
  if (rec.currentTool) ev.tool = rec.currentTool;
  if (rec.lastFile) ev.file = rec.lastFile;
  rec.events.push(ev);
  if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);

  // Terminal phases clear the tool marker — "done" with a stale
  // currentTool would read as still mid-action.
  if (phase === "done" || phase === "error" || phase === "idle" || phase === "waiting") {
    rec.currentTool = null;
  }

  return prevPhase;
}

/**
 * Current status of one thread (internal shape — NOT voice-safe).
 * @param {string} projectId
 */
export function getThreadStatus(projectId) {
  return threads.get(projectId) || null;
}

/**
 * Annotate a stored record with derived fields for display.
 * Pure function — no mutation.
 */
function decorate(rec) {
  const now = Date.now();
  return {
    ...rec,
    updatedAtAgoSec: rec.updatedAt ? Math.round((now - rec.updatedAt) / 1000) : null,
    stale: !rec.updatedAt || now - rec.updatedAt > STALE_MS,
  };
}

/**
 * Full snapshot — every thread, most recently active first.
 * Internal consumers only (renderer UI, tests). Voice must use
 * voiceSnapshot().
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] — cap number of threads returned
 */
export function getSnapshot(opts = {}) {
  const now = Date.now();
  const all = [...threads.values()].map(decorate);
  all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) ? opts.limit : null;
  return {
    threads: limit ? all.slice(0, limit) : all,
    activeThreads: all.filter((t) => !t.stale && t.phase !== "idle" && t.phase !== "done" && t.phase !== "error").length,
    generatedAt: now,
  };
}

/**
 * Voice-facing snapshot. Projects every thread through VOICE_SAFE_FIELDS —
 * a strict whitelist pick, so any field not explicitly listed is dropped
 * even if the store grows one later. This is the structural guarantee that
 * voice can only ever see safe monitoring metadata.
 */
export function voiceSnapshot() {
  const snap = getSnapshot();
  return {
    ...snap,
    threads: snap.threads.map((t) => {
      const out = {};
      for (const k of VOICE_SAFE_FIELDS) {
        if (k === "events") {
          // Events too are projected: only ts/phase/tool/file survive.
          out.events = (t.events || []).map((e) => {
            const ev = { ts: e.ts, phase: e.phase };
            if (e.tool) ev.tool = e.tool;
            if (e.file) ev.file = e.file;
            return ev;
          });
        } else if (t[k] !== undefined) {
          out[k] = t[k];
        }
      }
      return out;
    }),
  };
}

/** Phase vocabulary, exported for tests and callers that validate input. */
export const AGENT_PHASES = PHASES;
