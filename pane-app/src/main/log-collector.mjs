/**
 * Log Collector — Pane's own observability layer.
 *
 * Patches console.log/warn/error in the main process and writes JSONL
 * entries to userData/logs/. Utility-process output is piped in by main
 * via attachWorker(). Renderer console messages arrive via the existing
 * webContents "console-message" hook.
 *
 * Design constraints (from the playbook):
 * - Never block the main thread: writes are batched, flush on interval
 *   or threshold, wrapped so a write failure can never throw into the app.
 * - Cap everything: per-message size, daily files, retention days.
 * - Import FIRST in main.mjs — the console patch must be in place before
 *   any other module logs.
 */

import fs from "node:fs";
import path from "node:path";

// ── Config ────────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS = 2000;   // batch window
const FLUSH_THRESHOLD = 64;       // entries buffered before early flush
const MAX_ENTRY_CHARS = 4000;     // truncate single huge messages (stacks included)
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per day-file, then roll to .1, .2 …
const MAX_ROLLS = 3;              // main-YYYY-MM-DD.jsonl → .1 .2 .3
const RETENTION_DAYS = 7;
const MAX_BUFFER_ON_FAILURE = 200; // if disk writes fail, drop oldest, keep going

// ── State ─────────────────────────────────────────────────────────────────
let logsDir = null;
let currentFile = null;
let currentDate = null;
let currentSize = 0;
let buffer = [];
let flushTimer = null;
let writeFailedRecently = false;

const startedAt = Date.now();

export function initLogCollector(userDataDir) {
  if (!userDataDir) return;
  try {
    logsDir = path.join(userDataDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    logsDir = null;
    return;
  }

  patchConsole();
  scheduleRotationSweep();
  pruneOldFiles().catch(() => {});
}

// ── Console patch ─────────────────────────────────────────────────────────
function patchConsole() {
  for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      pushEntry({
        level,
        source: "main",
        message: formatArgs(args),
      });
    };
  }
}

function formatArgs(args) {
  const parts = [];
  for (const a of args) {
    if (typeof a === "string") parts.push(a);
    else if (a instanceof Error) parts.push(a.stack || `${a.name}: ${a.message}`);
    else {
      try { parts.push(JSON.stringify(a)); }
      catch { parts.push(String(a)); }
    }
  }
  const out = parts.join(" ");
  return out.length > MAX_ENTRY_CHARS ? out.slice(0, MAX_ENTRY_CHARS) + " …[truncated]" : out;
}

// ── Entry intake ──────────────────────────────────────────────────────────
export function pushEntry({ level, source, message }) {
  if (!logsDir) return;
  const entry = {
    ts: Date.now(),
    level: level === "warn" ? "warn" : level === "error" ? "error" : "info",
    source: source || "unknown",
    message: typeof message === "string" ? message : String(message ?? ""),
  };
  if (entry.message.length > MAX_ENTRY_CHARS) {
    entry.message = entry.message.slice(0, MAX_ENTRY_CHARS) + " …[truncated]";
  }
  buffer.push(entry);
  if (buffer.length > FLUSH_THRESHOLD) flush();
}

// ── File sink ─────────────────────────────────────────────────────────────
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resolveFile() {
  const key = dateKey();
  if (currentFile && currentDate === key && currentSize < MAX_FILE_BYTES) return;
  currentDate = key;
  currentFile = path.join(logsDir, `main-${key}.jsonl`);
  try {
    currentSize = fs.existsSync(currentFile) ? fs.statSync(currentFile).size : 0;
  } catch { currentSize = 0; }
}

function rollIfNeeded() {
  if (!currentFile || currentSize < MAX_FILE_BYTES) return;
  const key = currentDate;
  // Shift .2 → .3, .1 → .2, base → .1 — best-effort: if a rename fails
  // (file locked, disk full) we keep appending to the base file and retry
  // on the next flush. Size overshoot for a few cycles is acceptable.
  for (let i = MAX_ROLLS - 1; i >= 1; i--) {
    const from = path.join(logsDir, `main-${key}.jsonl.${i}`);
    const to = path.join(logsDir, `main-${key}.jsonl.${i + 1}`);
    try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* rotation retried next flush */ }
  }
  const base = path.join(logsDir, `main-${key}.jsonl`);
  const next = path.join(logsDir, `main-${key}.jsonl.1`);
  try { fs.renameSync(base, next); } catch { /* rotation retried next flush */ }
  currentFile = base; // new writes create it fresh
  currentSize = 0;
}

function flush() {
  if (!logsDir || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    resolveFile();
    rollIfNeeded();
    const payload = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(currentFile, payload, "utf-8");
    currentSize += Buffer.byteLength(payload);
    writeFailedRecently = false;
  } catch (err) {
    // Disk failure — never throw into the app. Keep a bounded buffer so we
    // don't grow without limit; drop oldest when full.
    writeFailedRecently = true;
    for (const e of batch) {
      buffer.push(e);
      if (buffer.length > MAX_BUFFER_ON_FAILURE) buffer.shift();
    }
    // Re-emit a single diagnostics line to stderr only (not the patched
    // console) so a broken collector can't recurse. If even fd 2 is broken
    // there is nowhere left to report — swallow silently and keep running.
    try { fs.writeSync(2, `[log-collector] flush failed: ${err?.message ?? err}\n`); } catch { /* fd 2 broken — nothing left to report to */ }
  }
}

function scheduleRotationSweep() {
  // Hourly: prune files older than RETENTION_DAYS and flush any stragglers.
  const sweep = () => {
    flush();
    pruneOldFiles().catch(() => {});
  };
  const t = setInterval(sweep, 60 * 60 * 1000);
  if (t.unref) t.unref();
  const f = setInterval(flush, FLUSH_INTERVAL_MS);
  if (f.unref) f.unref();
  flushTimer = f;
}

async function pruneOldFiles() {
  if (!logsDir) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let names;
  try { names = await fs.promises.readdir(logsDir); } catch { return; /* unreadable dir — nothing to prune this sweep */ }
  const removed = [];
  for (const name of names) {
    if (!name.startsWith("main-")) continue;
    const m = name.match(/^main-(\d{4}-\d{2}-\d{2})\.jsonl/);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) {
      // Pruning is best-effort housekeeping — a failed unlink (file locked
      // by another reader) just means we retry on the next hourly sweep.
      try { await fs.promises.rm(path.join(logsDir, name)); removed.push(name); } catch { /* retried next sweep */ }
    }
  }
  if (removed.length > 0) {
    console.log(`[log-collector] pruned ${removed.length} old log file(s)`);
  }
}

// ── Utility-process attach ────────────────────────────────────────────────
/**
 * Pipe a utility process's stdout/stderr into the collector, tagged with
 * the worker name. Call right after utilityProcess.fork().
 */
export function attachWorker(child, name) {
  if (!child || !logsDir) return;
  const source = `worker:${name}`;
  const lineBuf = { out: "", err: "" };
  const ingest = (stream, key, level) => {
    if (!stream) return;
    stream.setEncoding?.("utf-8");
    stream.on("data", (chunk) => {
      lineBuf[key] += chunk;
      // Split into lines so entries stay parseable; keep partials buffered.
      const lines = lineBuf[key].split("\n");
      lineBuf[key] = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.length === 0) continue;
        pushEntry({ level, source, message: trimmed });
      }
      // Cap the partial buffer so a pathological no-newline stream can't grow it.
      if (lineBuf[key].length > MAX_ENTRY_CHARS) {
        pushEntry({ level, source, message: lineBuf[key] });
        lineBuf[key] = "";
      }
    });
    stream.on("error", () => {}); // EPIPE etc — never throw
  };
  ingest(child.stdout, "out", "info");
  ingest(child.stderr, "err", "error");
}

// ── Query API (used by the pane_logs tool) ────────────────────────────────
export function logsDirPath() {
  return logsDir;
}

/**
 * Read log entries. Newest-first across today's file + rolls + recent days.
 * @returns {{ entries: Array<{ts,level,source,message}>, fileCount: number, truncated: boolean }}
 */
export function readLogs({ hours = 24, level = "all", source = null, limit = 200, grep = null }) {
  if (!logsDir) return { entries: [], fileCount: 0, truncated: false };
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const files = listLogFiles();
  const entries = [];
  let fileCount = 0;
  let truncated = false;

  const minLevel = level === "error" ? 2 : level === "warn" ? 1 : 0;

  let regex = null;
  if (grep) {
    try { regex = new RegExp(grep, "i"); } catch { return { entries: [], fileCount: 0, truncated: true, error: `invalid grep pattern: ${grep}` }; }
  }

  // Files sort newest-first by date; iterate until we're older than cutoff.
  for (const f of files) {
    if (entries.length >= limit) break;
    fileCount++;
    let content;
    try { content = fs.readFileSync(f.path, "utf-8"); } catch { continue; }
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.ts < cutoff) continue;
      const lvl = e.level === "error" ? 2 : e.level === "warn" ? 1 : 0;
      if (lvl < minLevel) continue;
      if (source && e.source !== source) continue;
      if (regex && !regex.test(e.message)) continue;
      entries.push(e);
      if (entries.length >= limit) { truncated = true; break; }
    }
  }

  return { entries, fileCount, truncated, logDir: logsDir };
}

function listLogFiles() {
  let names;
  try { names = fs.readdirSync(logsDir); } catch { return []; }
  return names
    .filter((n) => n.startsWith("main-") && n.includes(".jsonl"))
    .map((n) => {
      const m = n.match(/^main-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.\d+)?$/);
      return { name: n, path: path.join(logsDir, n), date: m ? m[1] : "0000" };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function logCollectorStats() {
  return {
    dir: logsDir,
    buffered: buffer.length,
    currentFile,
    currentSize,
    writeFailedRecently,
    uptimeMs: Date.now() - startedAt,
  };
}
