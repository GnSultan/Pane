/**
 * Pane Tool Executor
 *
 * Executes tools locally for all backends (DeepSeek, Kimi, Anthropic, etc.)
 * Handles Bash commands, file operations, and other tools.
 *
 * Architecture:
 * 1. Receives tool calls from HTTP backend
 * 2. Executes them locally with proper sandboxing
 * 3. Returns results formatted for the LLM
 * 4. Maintains execution context per project
 */

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import vm from "node:vm";

import { getPaneDb, pruneChangeHistory } from "./pane-db.mjs";
import { findReferences, formatReferencesOutput } from "./find-references.mjs";
import { readState, readHandoff, mergeState } from "./pane-system-prompt.mjs";
import { replay as replayJournal, readLastProgress } from "./session-journal.mjs";
import { sanitizeString } from "./sanitize.mjs";
import { validateCommand, hasWriteIntent } from "./command-validator.mjs";
import { readFileForJournal, snapshotAllFiles, flushJournal } from "./checkpoint-engine.mjs";
import { recordIntent, checkConflict, readPeerIntents } from "./intents.mjs";
import {
  activateSkill,
  deactivateSkill,
  getActiveSkills,
  discoverAll,
  findSkill,
  loadSkill,
  buildSkillListing,
  installSkill,
  ensureGlobalSkillsDir,
} from "./skill-registry.mjs";

// ── CMD Worker (utility process for shell execution) ──────────────────────
// In Electron 40's packaged macOS app, child_process.spawn/execSync fails with
// EBADF because Chromium's integrated event loop conflicts with libuv's kqueue
// EVFILT_PROC registration. The cmd-worker runs in its own V8 isolate via
// utilityProcess.fork() with a clean libuv loop — execSync works there.
// Set via setCmdWorker() from main.mjs after pre-forking the worker.
let _cmdWorker = null;

// Tracks in-flight execThroughWorker requests so they can be cleaned up
// when the cmd-worker process exits unexpectedly. Maps request ID → { resolve, timeoutId }.
const _pendingRequests = new Map();

/**
 * Register the cmd-worker instance from main.mjs.
 * Called once at startup after utilityProcess.fork("cmd-worker.mjs").
 */
export function setCmdWorker(worker) {
  _cmdWorker = worker;
  if (_cmdWorker && typeof _cmdWorker.setMaxListeners === 'function') {
    _cmdWorker.setMaxListeners(100);
  }
}

/**
 * Clean up all pending requests when the cmd-worker exits unexpectedly.
 * Resolves each with a graceful "worker exited" error so callers don't hang.
 * Called from main.mjs's exit handler before auto-respawn.
 */
export function onCmdWorkerExit() {
  const count = _pendingRequests.size;
  if (count > 0) {
    console.warn(`[pane] Cleaning up ${count} pending cmd-worker request(s) after worker exit`);
  }
  for (const [id, entry] of _pendingRequests) {
    clearTimeout(entry.timeoutId);
    entry.resolve({ success: false, stdout: "", stderr: "", exitCode: -1, errorMessage: "cmd-worker exited unexpectedly" });
  }
  _pendingRequests.clear();
}

/**
 * Execute a command through the cmd-worker utility process.
 * Returns a promise that resolves with { success, stdout, stderr, exitCode }.
 */
export function execThroughWorker(command, options = {}) {
  return new Promise((resolve) => {
    if (!_cmdWorker || _cmdWorker.killed) {
      resolve({ success: false, stdout: "", stderr: "", exitCode: -1, errorMessage: "cmd-worker not available" });
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const handler = (response) => {
      if (response.id === id) {
        _cmdWorker.removeListener("message", handler);
        clearTimeout(_pendingRequests.get(id)?.timeoutId);
        _pendingRequests.delete(id);
        resolve(response);
      }
    };
    _cmdWorker.on("message", handler);

    _cmdWorker.postMessage({
      id,
      command,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout || 120,
    });

    // Safety timeout — if worker never responds, reject
    const safeTimeout = setTimeout(() => {
      _cmdWorker.removeListener("message", handler);
      _pendingRequests.delete(id);
      resolve({ success: false, stdout: "", stderr: "", exitCode: -1, errorMessage: "cmd-worker timed out" });
    }, (options.timeout || 120) * 1000 + 10000);
    // Unref so it doesn't keep the process alive
    if (safeTimeout.unref) safeTimeout.unref();

    // Track for cleanup on unexpected worker exit
    _pendingRequests.set(id, { resolve, timeoutId: safeTimeout });
  });
}

// ============================================================================
// Semantic Search Helpers (Lazy-loaded)
// ============================================================================

let globalEmbedder = null;
let globalEmbedderLoading = false;

async function getEmbedder(paneDir) {
  if (globalEmbedder) return globalEmbedder;
  if (globalEmbedderLoading) return null;
  globalEmbedderLoading = true;
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(paneDir, "brain", "models");
    env.backends.onnx.wasm.numThreads = 1;
    globalEmbedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    return globalEmbedder;
  } catch (err) {
    console.error("[tool-executor] Failed to load embedder:", err.message);
    globalEmbedderLoading = false;
    return null;
  }
}

async function embedText(text, paneDir) {
  const embedder = await getEmbedder(paneDir);
  if (!embedder) return null;
  try {
    const result = await embedder(text, { pooling: "mean", normalize: true });
    return Array.from(result.data);
  } catch {
    return null;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function fuzzyScore(query, text) {
  const queryWords = query.split(/\s+/).filter((w) => w.length > 2);
  if (queryWords.length === 0) return 0;
  const lower = text.toLowerCase();
  const matches = queryWords.filter((w) => lower.includes(w)).length;
  return matches / queryWords.length;
}

// ============================================================================
// Reflex Gates — catch quality violations at write time
// ============================================================================
// Scans file content AFTER write, BEFORE result goes back to the LLM.
// Deterministic regex — no LLM cost, <5ms. The LLM cannot sneak bad patterns
// through because Pane inspects every write and augments the tool result with
// correction directives the user never sees.
//
// Only flags NEW violations introduced by this write (compares against previous
// content). Existing violations in the codebase are not the LLM's fault.

const VIOLATION_PATTERNS = [
  // ── Suppression directives ──────────────────────────────────────────────
  {
    id: "ts-nocheck",
    pattern: /^\s*\/\/\s*@ts-nocheck/,
    severity: "error",
    message: "@ts-nocheck disables ALL type checking for this file. This hides real errors. Remove it and fix the actual type errors.",
  },
  {
    id: "ts-ignore",
    pattern: /\/\/\s*@ts-ignore(?!\s*\()/,
    severity: "error",
    message: "@ts-ignore suppresses a specific TypeScript error without explaining why. Fix the underlying type error instead of hiding it.",
  },
  {
    id: "ts-expect-error-bare",
    // @ts-expect-error without a description is a lazy suppression
    pattern: /\/\/\s*@ts-expect-error\s*$/,
    severity: "warning",
    message: "@ts-expect-error without an explanation. If this is genuinely needed, add a comment explaining what error is expected and why it can't be fixed.",
  },
  {
    id: "eslint-disable-file",
    pattern: /\/\*\s*eslint-disable\s*\*\//,
    severity: "error",
    message: "eslint-disable disables ALL lint rules for this file. This hides real problems. Remove it and fix the specific lint errors.",
  },
  {
    id: "eslint-disable-line",
    // Blanket eslint-disable-next-line (no specific rule) is a red flag
    pattern: /\/\/\s*eslint-disable-next-line\s*$/,
    severity: "warning",
    message: "eslint-disable-next-line without specifying which rule. If a rule must be disabled, name it and explain why.",
  },
  // ── Type escape hatches ─────────────────────────────────────────────────
  {
    id: "as-any",
    pattern: /\bas\s+any\b/,
    severity: "warning",
    message: "'as any' erases type safety. Find the correct type or fix the type mismatch instead of casting to any.",
    maxPerFile: 2, // Only flag if the file introduces 2+ new instances
  },
  {
    id: "explicit-any-param",
    // Catches : any in function params and variable declarations, but not in type definitions
    pattern: /:\s*any\b(?!\s*[|&)\]])/,
    severity: "warning",
    message: "Explicit 'any' type removes type safety. Use the specific type, a generic, or 'unknown' if the type is truly unpredictable.",
    maxPerFile: 3,
  },
  // ── Dead error handling ─────────────────────────────────────────────────
  {
    id: "empty-catch",
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    severity: "warning",
    message: "Empty catch block silently swallows errors. At minimum, log the error. If it's intentionally ignored, add a comment explaining why.",
  },
  // ── Debug residue ───────────────────────────────────────────────────────
  {
    id: "console-log",
    pattern: /\bconsole\.(log|debug|info)\s*\(/,
    severity: "info",
    message: "console.log left in code. Remove debug logging before considering the work complete.",
    maxPerFile: 3,
    skipFiles: [/\.test\.|\.spec\.|__tests__|test\/|tests\/|\.config\.|vite\.config|jest\.config|eslint/],
  },
  {
    id: "debugger",
    pattern: /^\s*debugger\s*;?\s*$/,
    severity: "error",
    message: "debugger statement left in code. This will pause execution in the browser. Remove it.",
  },
];

/**
 * Check JavaScript syntax using node -c.
 * Replaces the old hand-rolled delimiter balance checker which produced
 * false positives. Uses the actual Node.js parser — 100% correct.
 *
 * @param {string} content - File content to check
 * @param {string} ext - File extension (lowercase, with dot)
 * @returns {Array<{id, severity, message, line}>}
 */
function checkSyntax(content, ext) {
  const violations = [];
  // Only JS/MJS/CJS files — TypeScript uses its own compiler
  if (ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") return violations;

  // Use in-process vm.Script to detect syntax errors.
  // Same V8 parser Node.js uses — no subprocess, no Electron binary quirks,
  // no event loop blocking. Completes in <1ms.
  //
  // vm.Script only supports classic scripts (CommonJS), not ES modules.
  // For ESM files (detected by top-level import/export), we skip syntax
  // checking — the code-arbiter's runTurnSentinel covers those via tsc.
  const isESM = /^\s*(import|export)\s/.test(content) ||
                 ext === ".mjs";
  if (isESM) return violations;

  try {
    new vm.Script(content, { filename: `pane-syntax-check${ext}` });
  } catch (e) {
    const isImportExport = e.message?.includes("import") || e.message?.includes("export");
    if (!isImportExport) {
      const line = e.lineNumber || content.split("\n").length;
      violations.push({
        id: "syntax-error",
        severity: "error",
        message: e.message || "File has broken JavaScript syntax",
        line,
      });
    }
  }
  return violations;
}

/**
 * Scan file content for quality violations introduced by this write.
 *
 * @param {string} newContent - The content just written
 * @param {string} previousContent - The content before the write (empty string for new files)
 * @param {string} filePath - Relative or absolute path (used for skip rules)
 * @returns {{ violations: Array<{id, severity, message, line}>, summary: string|null }}
 */
function scanForViolations(newContent, previousContent, filePath) {
  // Skip non-code files
  const ext = path.extname(filePath).toLowerCase();
  const codeExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  if (!codeExts.includes(ext)) return { violations: [], summary: null };

  // Skip type declaration files — they legitimately use 'any'
  if (filePath.endsWith(".d.ts")) return { violations: [], summary: null };

  const newLines = newContent.split("\n");
  const prevLines = new Set(previousContent.split("\n").map(l => l.trim()));

  const violations = [];

  // ── Pattern-based checks (line-by-line, only NEW lines) ─────────────────
  for (const rule of VIOLATION_PATTERNS) {
    // Check file-level skip rules
    if (rule.skipFiles?.some(re => re.test(filePath))) continue;

    let matchCount = 0;

    for (let i = 0; i < newLines.length; i++) {
      const line = newLines[i];
      if (!rule.pattern.test(line)) continue;

      // Only flag NEW violations — skip lines that existed before
      if (prevLines.has(line.trim())) continue;

      matchCount++;

      // For rules with maxPerFile, only flag when threshold is exceeded
      if (rule.maxPerFile && matchCount < rule.maxPerFile) continue;

      violations.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        line: i + 1,
      });
    }
  }

  // ── Syntax validation via node -c (JS/MJS/CJS only) ──────────────────────
  // Replaces the old hand-rolled delimiter balance checker which produced
  // false positives. Uses the actual Node.js parser — 100% correct.
  const syntaxErrors = checkSyntax(newContent, ext);
  violations.push(...syntaxErrors);

  // ── Build summary ───────────────────────────────────────────────────────
  if (violations.length === 0) return { violations: [], summary: null };

  const errors = violations.filter(v => v.severity === "error");
  const warnings = violations.filter(v => v.severity === "warning");

  let summary = "\n\n⚠ QUALITY GATE — Pane detected violations in this write:";

  for (const v of violations) {
    const tag = v.severity === "error" ? "ERROR" : v.severity === "warning" ? "WARNING" : "INFO";
    summary += `\n  [${tag}] Line ${v.line}: ${v.message}`;
  }

  if (errors.length > 0) {
    summary += "\n\nYou MUST fix the ERROR violations above. Do not suppress errors — fix the root cause.";
  } else if (warnings.length > 0) {
    summary += "\n\nFix the WARNING violations above. Use proper types instead of 'any', handle errors instead of swallowing them.";
  }

  return { violations, summary };
}

// ============================================================================
// Constants & Configuration
// ============================================================================

const MAX_OUTPUT_SIZE = 100 * 1024; // 100KB max output
const COMMAND_TIMEOUT_MS = 30000; // 30 seconds for commands
const DEFAULT_ENCODING = "utf-8";

// validateCommand imported from ./command-validator.mjs

// ============================================================================
// File Read Cache — eliminates redundant disk reads across turns and sessions.
//
// The model reads the same files repeatedly: once to understand, again to edit,
// again to verify. Each read returns the same content if the file hasn't changed.
// At ~3,000 tokens per file read × 15 reads/session × 50 sessions/day, redundant
// reads cost ~2.25M tokens/day. This cache eliminates them.
//
// Cache key: resolved absolute path
// Validation: mtime — if the file's mtime changed, the cache entry is stale.
// Eviction: LRU with max 200 entries, auto-clear entries older than 30 minutes.
// ============================================================================

const FILE_CACHE_MAX_ENTRIES = 200;
const FILE_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

class FileReadCache {
  constructor() {
    this._cache = new Map(); // resolvedPath → { content, mtime, cachedAt, hits }
    this._stats = { hits: 0, misses: 0, evictions: 0, bytesServed: 0 };
  }

  /**
   * Get cached file content if valid (same mtime, not expired).
   * @param {string} resolvedPath - absolute file path
   * @param {number} currentMtimeMs - file's current mtime in ms
   * @returns {string|null} cached content or null
   */
  get(resolvedPath, currentMtimeMs) {
    const entry = this._cache.get(resolvedPath);
    if (!entry) {
      this._stats.misses++;
      return null;
    }

    // Stale: file changed on disk
    if (entry.mtime !== currentMtimeMs) {
      this._cache.delete(resolvedPath);
      this._stats.misses++;
      return null;
    }

    // Expired: too old
    if (Date.now() - entry.cachedAt > FILE_CACHE_MAX_AGE_MS) {
      this._cache.delete(resolvedPath);
      this._stats.evictions++;
      this._stats.misses++;
      return null;
    }

    entry.hits++;
    this._stats.hits++;
    this._stats.bytesServed += entry.content.length;
    return entry.content;
  }

  /**
   * Store file content in cache.
   * @param {string} resolvedPath - absolute file path
   * @param {string} content - file content
   * @param {number} mtimeMs - file's mtime in ms
   */
  set(resolvedPath, content, mtimeMs) {
    // LRU eviction: if at capacity, remove oldest entry
    if (this._cache.size >= FILE_CACHE_MAX_ENTRIES) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, entry] of this._cache) {
        if (entry.cachedAt < oldestTime) {
          oldestTime = entry.cachedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this._cache.delete(oldestKey);
        this._stats.evictions++;
      }
    }

    this._cache.set(resolvedPath, {
      content,
      mtime: mtimeMs,
      cachedAt: Date.now(),
      hits: 0,
    });
  }

  /**
   * Invalidate a specific path (e.g., after a write/edit).
   */
  invalidate(resolvedPath) {
    this._cache.delete(resolvedPath);
  }

  /**
   * Invalidate all entries for a project root.
   */
  invalidateProject(projectRoot) {
    for (const key of this._cache.keys()) {
      if (key.startsWith(projectRoot)) this._cache.delete(key);
    }
  }

  /**
   * Get cache statistics for diagnostics.
   */
  getStats() {
    const hitRate = this._stats.hits + this._stats.misses > 0
      ? Math.round((this._stats.hits / (this._stats.hits + this._stats.misses)) * 100)
      : 0;
    return {
      ...this._stats,
      hitRate,
      entries: this._cache.size,
      tokensSaved: Math.round(this._stats.bytesServed / 4), // ~4 chars/token
    };
  }
}

// Singleton — shared across all ToolExecutor instances in this process.
// Exported for diagnostics and external invalidation (e.g., file watcher).
const fileReadCache = new FileReadCache();
export { fileReadCache, scanForViolations, VIOLATION_PATTERNS };

// ============================================================================
// Contextual Memory Triggering — memories that activate when files are touched
// ============================================================================
// When a file is read, check if any memories reference it.
// This is the "behavioral wiring" path — memories fire at the moment they're
// relevant, not through semantic search or manual recall.

const MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 min cache for file→memory index
let _memoryIndex = null;       // Map<normalizedPath, string[]> — path → memory texts
let _memoryIndexBuiltAt = 0;
let _memoryIndexProjectId = null;

function getMemoriesForFile(filePath, projectId) {
  // Rebuild index if stale or wrong project
  if (!_memoryIndex || Date.now() - _memoryIndexBuiltAt > MEMORY_CACHE_TTL
      || _memoryIndexProjectId !== projectId) {
    _memoryIndex = new Map();
    _memoryIndexProjectId = projectId;
    _memoryIndexBuiltAt = Date.now();

    try {
      const eventsPath = path.join(os.homedir(), ".pane", "memory", projectId, "events.jsonl");
      const raw = fs.readFileSync(eventsPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Only index meaningful memory types
          if (!["decision", "lesson", "pattern", "error_fix"].includes(event.type)) continue;
          const content = event.content || "";
          if (content.length < 10) continue;

          // Extract file paths mentioned in the memory
          const fileRefs = content.match(/[\w/.-]+\.(ts|tsx|js|mjs|jsx|css|json|md)/g) || [];
          for (const ref of fileRefs) {
            const normalized = ref.toLowerCase();
            if (!_memoryIndex.has(normalized)) _memoryIndex.set(normalized, []);
            const existing = _memoryIndex.get(normalized);
            if (existing.length < 5) { // Max 5 memories per file
              existing.push(`[${event.type}] ${content.slice(0, 200)}`);
            }
          }
        } catch {}
      }
    } catch {}
  }

  // Look up by filename (not full path — memories often use relative paths)
  const fileName = path.basename(filePath).toLowerCase();
  const dirAndFile = filePath.split("/").slice(-2).join("/").toLowerCase();

  const matches = [];
  for (const [key, mems] of _memoryIndex) {
    if (key.includes(fileName) || key.includes(dirAndFile)) {
      matches.push(...mems);
    }
  }

  return [...new Set(matches)].slice(0, 3); // Dedupe, max 3
}

// ============================================================================
// Contextual Augmentation — auto-attach referenced files from error output
// ============================================================================
// When terminal output contains stack traces (file:line), auto-attach the
// referenced code so the model doesn't need extra Read round-trips.

const FILE_LINE_RE = /(?:at\s+(?:\S+\s+\()?)?((?:\/[^\s:()]+|src\/[^\s:()]+|[a-zA-Z][a-zA-Z0-9._/-]+\.[a-z]{1,4})):(\d+)/g;
const MAX_AUGMENT = 3;
const AUGMENT_LINES = 10;

async function augmentWithReferencedFiles(output, projectRoot) {
  if (!output || output.length < 20) return "";

  const refs = new Map();
  let m;
  const re = new RegExp(FILE_LINE_RE.source, "g");
  while ((m = re.exec(output)) !== null) {
    const [, fp, ln] = m;
    const line = parseInt(ln, 10);
    if (isNaN(line) || line < 1) continue;
    if (fp.includes("node_modules") || fp.startsWith("node:")) continue;
    const resolved = path.isAbsolute(fp) ? fp : path.join(projectRoot, fp);
    if (!refs.has(resolved)) refs.set(resolved, new Set());
    refs.get(resolved).add(line);
  }

  if (refs.size === 0) return "";

  const parts = [];
  let count = 0;
  for (const [resolved, lines] of refs) {
    if (count >= MAX_AUGMENT) break;
    try {
      const content = await fsPromises.readFile(resolved, "utf-8");
      const allLines = content.split("\n");
      const rel = path.relative(projectRoot, resolved);

      for (const lineNum of [...lines].sort((a, b) => a - b).slice(0, 2)) {
        const start = Math.max(0, lineNum - 1 - AUGMENT_LINES);
        const end = Math.min(allLines.length, lineNum + AUGMENT_LINES);
        const snippet = allLines.slice(start, end)
          .map((l, i) => {
            const num = start + i + 1;
            return `${num === lineNum ? "→" : " "}${String(num).padStart(4)} ${l}`;
          }).join("\n");
        parts.push(`\n--- auto-attached: ${rel}:${lineNum} ---\n${snippet}`);
      }
      count++;
    } catch {}
  }

  return parts.length > 0
    ? `\n\n[Pane auto-attached ${parts.length} referenced location${parts.length > 1 ? "s" : ""}]${parts.join("")}`
    : "";
}

// ============================================================================
// Tool Executor Class
// ============================================================================

export class ToolExecutor {
  /**
   * @param {string} projectId - The project ID for context
   * @param {string} projectRoot - Root directory of the project
   * @param {Function} onEvent - Callback for emitting events
   */
  constructor(projectId, projectRoot, onEvent) {
    this.projectId = projectId;
    this.projectRoot = projectRoot;
    this.onEvent = onEvent;
    this.activeProcesses = new Map(); // toolId -> child process
    this._brainRequest = null;
    /** @type {Map<string, string|null>} relativePath → preEditContent (null = file didn't exist) */
    this.fileJournal = new Map();
    this.executionContext = {
      cwd: projectRoot,
      env: this.getSafeEnvironment(),
      shell: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_SIZE,
      killSignal: "SIGTERM",
    };
  }

  setBrainRequest(fn) {
    this._brainRequest = fn;
  }

  setQuickCall(fn) {
    this._quickCall = fn;
  }

  setAgentCall(fn) {
    this._agentCall = fn;
  }

  /**
   * Read the distilled playbook for this project (+ global craft profile).
   * These are tested principles the reflection engine graduated from accumulated
   * experience — injected so they shape behavior without needing recall.
   * Mirrors context-orchestrator.mjs's readPlaybook().
   */
  _readPlaybook() {
    const PLAYBOOKS_DIR = path.join(os.homedir(), ".pane", "profile", "playbooks");
    const MAX_PLAYBOOK_CHARS = 4000;
    const sections = [];
    try {
      const globalPath = path.join(PLAYBOOKS_DIR, "global.md");
      if (fs.existsSync(globalPath)) {
        const global = fs.readFileSync(globalPath, "utf-8").trim();
        if (global) sections.push(global);
      }
    } catch {}
    try {
      const projectPath = path.join(PLAYBOOKS_DIR, `${this.projectId}.md`);
      if (fs.existsSync(projectPath)) {
        const project = fs.readFileSync(projectPath, "utf-8").trim();
        if (project) sections.push(project);
      }
    } catch {}
    if (sections.length === 0) return null;

    const body = sections.join("\n").slice(0, MAX_PLAYBOOK_CHARS);
    return (
      "## Playbook — principles earned from working in this codebase\n\n" +
      "These were distilled from real sessions: mistakes made, fixes that held, " +
      "approaches that worked. Follow them by default; if one seems wrong for " +
      "the current task, say so rather than silently ignoring it.\n\n" +
      body
    );
  }

  /**
   * Record a change in the change history.
   */
  async recordChange(change) {
    const id = `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestamp = change.timestamp || Date.now();
    
    try {
      const db = getPaneDb();
      db.stmts.insertChange.run(
        id,
        this.projectId,
        change.filePath,
        change.oldString ?? null,
        change.newString ?? "",
        change.description || "",
        timestamp,
        this.projectRoot
      );
      // Cap retention at 7 days — cheap indexed range delete per write.
      pruneChangeHistory(this.projectId);
    } catch (err) {
      console.error("[tool-executor] Failed to record change to SQLite:", err.message);
    }

    return { id, success: true };
  }

  /**
   * Get safe environment variables for command execution
   */
  getSafeEnvironment() {
    const env = { ...process.env };

    // Safe PATH - only include common binary directories
    const safePaths = [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin", // Homebrew on Apple Silicon
      "/opt/local/bin", // MacPorts
      `${os.homedir()}/.local/bin`,
      `${os.homedir()}/.cargo/bin`,
      `${os.homedir()}/.npm-global/bin`,
    ].filter((p) => fs.existsSync(p));

    env.PATH = safePaths.join(":");

    // Remove dangerous environment variables
    delete env.SSH_AUTH_SOCK;
    delete env.GPG_AGENT_INFO;
    delete env.DBUS_SESSION_BUS_ADDRESS;

    // Set safe defaults
    env.HOME = os.homedir();
    env.USER = os.userInfo().username;
    env.SHELL = "/bin/bash";
    env.TERM = "xterm-256color";

    return env;
  }

  /**
   * Validate a shell command for safety.
   * Passes projectRoot for path-boundary enforcement (rejects escapes).
   */
  validateCommand(command) {
    return validateCommand(command, this.projectRoot);
  }

  /**
   * Snapshot a file's current content into the turn journal before the first
   * write to it. Safe to call multiple times for the same file — only the
   * first call (pre-edit state) is saved.
   * @param {string} filePath - relative or absolute path within the project
   */
  async journalFileWrite(filePath) {
    const resolvedPath = this.resolveProjectPath(filePath);
    if (!resolvedPath) return;
    const relativePath = path.relative(this.projectRoot, resolvedPath);
    if (this.fileJournal.has(relativePath)) return; // already captured pre-edit state

    const content = await readFileForJournal(resolvedPath);
    if (content !== undefined) {
      this.fileJournal.set(relativePath, content);
    }
  }

  /**
   * Reset the file journal for a new turn.
   */
  resetJournal() {
    this.fileJournal.clear();
  }

  /**
   * Get a reference to the current file journal (for flushing to checkpoint).
   * @returns {Map<string, string|null>}
   */
  getJournal() {
    return this.fileJournal;
  }

  /**
   * Execute a Bash command
   */
  async executeBash(toolId, command, background = false, cwd = null) {
    // Validate command
    const validation = this.validateCommand(command);
    if (!validation.valid) {
      return {
        success: false,
        error: `Command validation failed: ${validation.error}`,
        toolId,
      };
    }

    const execOptions = { ...this.executionContext };
    if (cwd) {
      const resolvedCwd = this.resolveProjectPath(cwd);
      if (resolvedCwd) execOptions.cwd = resolvedCwd;
    }

    // Copy-on-write: if command has write intent, pre-snapshot all project files
    // as a safety net — shell commands can modify any file, not just ones the
    // model has explicitly opened via write_file/replace.
    if (hasWriteIntent(command)) {
      try {
        await snapshotAllFiles(this.projectRoot, this.fileJournal);
      } catch {
        // snapshot failure shouldn't block the command
      }
    }

    try {
      if (background) {
        // Background spawn: single long-lived process — negligible kqueue leak.
        // Use spawn (not execSync) because execSync blocks.
        const child = spawn(command, {
          ...execOptions,
          detached: true,
          stdio: "ignore",
        });

        child.unref();
        this.activeProcesses.set(toolId, child);

        return {
          success: true,
          output: `Command running in background (PID: ${child.pid})`,
          toolId,
          pid: child.pid,
        };
      } else {
        // Use cmd-worker (utility process) — bypasses main process uv_spawn/kqueue issue.
        // The cmd-worker runs in its own V8 isolate via utilityProcess.fork() and has
        // a clean libuv loop where execSync works without EBADF.
        const startTime = Date.now();

        const result = await execThroughWorker(command, {
          cwd: execOptions.cwd,
          timeout: 120,
        });

        const duration = Date.now() - startTime;

        if (result.success) {
          // Truncate if too large
          let output = result.stdout || "";
          output = sanitizeString(output);
          if (output.length > MAX_OUTPUT_SIZE) {
            output = output.substring(0, MAX_OUTPUT_SIZE) + "\n...[output truncated]";
          }

          return {
            success: true,
            output: output || "(no output)",
            toolId,
            duration,
            exitCode: 0,
          };
        } else {
          // Worker unavailable or command failed — fail cleanly.
          // The worker is pre-forked at startup (main.mjs:2541). If it's dead,
          // do NOT degrade to main-process execSync — that bypasses isolation.
          // Command failed with non-zero exit code
          const stderr = sanitizeString(result.stderr || "");
          const stdout = sanitizeString(result.stdout || "");
          return {
            success: false,
            error: `Command failed with exit code ${result.exitCode}: ${stderr || stdout || result.errorMessage}`,
            output: stderr || stdout,
            toolId,
            exitCode: result.exitCode,
          };
        }
      }
    } catch (error) {
      // Unexpected error in the orchestration itself (not command execution)
      return {
        success: false,
        error: `Execution error: ${error.message}`,
        toolId,
      };
    }
  }

  /**
   * Read file contents
   */
  async executeReadFile(toolId, filePath, startLine = null, endLine = null) {
    try {
      // Resolve and validate path
      const resolvedPath = this.resolveProjectPath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: `Invalid file path: ${filePath}`,
          toolId,
        };
      }

      // Check if file exists
      try {
        await fsPromises.access(resolvedPath, fs.constants.R_OK);
      } catch {
        return {
          success: false,
          error: `File does not exist or is not readable: ${filePath}`,
          toolId,
        };
      }

      // Get file stats
      const stats = await fsPromises.stat(resolvedPath);

      // Check if it's a directory
      if (stats.isDirectory()) {
        return {
          success: false,
          error: `${filePath} is a directory. Use pane_directory to see its contents.`,
          toolId,
        };
      }

      // Check cache first — same file + same mtime = no disk read needed.
      // Full-file reads (no line range) are the common case and cache perfectly.
      const mtimeMs = stats.mtimeMs;
      let content;
      const isFullRead = startLine === null && endLine === null;

      if (isFullRead) {
        const cached = fileReadCache.get(resolvedPath, mtimeMs);
        if (cached !== null) {
          content = cached;
        } else {
          content = await fsPromises.readFile(resolvedPath, DEFAULT_ENCODING);
          fileReadCache.set(resolvedPath, content, mtimeMs);
        }
      } else {
        // Partial reads: check cache for full content, slice from it
        const cached = fileReadCache.get(resolvedPath, mtimeMs);
        if (cached !== null) {
          content = cached;
        } else {
          content = await fsPromises.readFile(resolvedPath, DEFAULT_ENCODING);
          fileReadCache.set(resolvedPath, content, mtimeMs);
        }
      }

      let output = content;

      // Apply line limits if provided
      if (startLine !== null || endLine !== null) {
        const lines = content.split("\n");
        const start = startLine !== null ? Math.max(0, startLine - 1) : 0;
        const end = endLine !== null ? Math.min(lines.length, endLine) : lines.length;
        output = lines.slice(start, end).join("\n");
      }

      // Check output size
      if (output.length > 10 * 1024 * 1024) {
        // 10MB limit
        return {
          success: false,
          error: `Content too large (${Math.round(output.length / 1024 / 1024)}MB). Max size is 10MB.`,
          toolId,
        };
      }

      // Contextual memory triggering: if memories reference this file,
      // append them so the model has relevant context without needing pane_recall.
      const fileMemories = getMemoriesForFile(filePath, this.projectId);
      if (fileMemories.length > 0) {
        output += `\n\n[Pane memory for this file]\n${fileMemories.join("\n")}`;
      }

      output = sanitizeString(output);

      return {
        success: true,
        output,
        toolId,
        metadata: {
          path: filePath,
          size: stats.size,
          mtime: stats.mtime,
          startLine,
          endLine,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        toolId,
      };
    }
  }

  /**
   * List directory contents
   */
  async executeListDirectory(toolId, dirPath) {
    try {
      const resolvedPath = this.resolveProjectPath(dirPath);
      if (!resolvedPath) {
        return { success: false, error: `Invalid path: ${dirPath}`, toolId };
      }

      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return { success: false, error: `${dirPath} is not a directory.`, toolId };
      }

      const files = await fsPromises.readdir(resolvedPath);
      const fileList = files.map((f) => {
        try {
          const fullPath = path.join(resolvedPath, f);
          const fileStat = fs.statSync(fullPath);
          return {
            name: f,
            type: fileStat.isDirectory() ? "directory" : "file",
            size: fileStat.size,
            modified: fileStat.mtime,
          };
        } catch {
          return { name: f, type: "unknown" };
        }
      });

      return {
        success: true,
        output: JSON.stringify({
          path: dirPath,
          contents: fileList,
          fileCount: files.length,
        }, null, 2),
        toolId,
      };
    } catch (error) {
      return { success: false, error: error.message, toolId };
    }
  }

  /**
   * Write file contents
   */
  async executeWriteFile(toolId, filePath, content) {
    try { await fsPromises.appendFile(path.join(os.homedir(), ".pane", "record-change-debug.log"), `[${new Date().toISOString()}] executeWriteFile called: file=${filePath}\n`); } catch {}
    try {
      // Resolve and validate path
      const resolvedPath = this.resolveProjectPath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: `Invalid file path: ${filePath}`,
          toolId,
        };
      }

      // Read previous content before overwriting (for change history)
      let previousContent = "";
      try {
        previousContent = await fsPromises.readFile(resolvedPath, DEFAULT_ENCODING);
      } catch {
        // File doesn't exist yet — new file creation, oldString stays ""
      }

      // ── Cross-thread conflict check ──
      const relativePath = path.relative(this.projectRoot, resolvedPath);
      const conflict = checkConflict(this.projectRoot, this.projectId, relativePath);

      // Copy-on-write: save pre-edit state for checkpoint/restore
      await this.journalFileWrite(filePath);

      // Ensure directory exists
      await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });

      // Write file
      await fsPromises.writeFile(resolvedPath, content, DEFAULT_ENCODING);

      // ── Record intent for cross-thread awareness ──
      recordIntent(this.projectId, relativePath, { action: "editing" });

      // Invalidate cache — file content changed
      fileReadCache.invalidate(resolvedPath);

      // Record the change in change history
      try {
        await this.recordChange({
          filePath: relativePath,
          oldString: previousContent,
          newString: content,
          timestamp: Date.now(),
        });
      } catch (recorderError) {
        console.error("Failed to record change:", recorderError);
      }

      // Get file stats
      const stats = await fsPromises.stat(resolvedPath);

      // ── Reflex Gate: scan for quality violations ──
      const gate = scanForViolations(content, previousContent, filePath);
      let baseOutput = `File written successfully: ${filePath} (${stats.size} bytes)`;

      // ── Cross-thread conflict warning ──
      if (conflict.conflicted) {
        const peerIds = conflict.by.map((c) => `\`${c.threadId.slice(0, 8)}\``).join(", ");
        baseOutput += `\n\n⚠ Peer conflict: another thread (${peerIds}) recently touched this file. They may be mid-change — coordinate with the user if this wasn't intentional.`;
      }

      return {
        success: true,
        output: gate.summary ? baseOutput + gate.summary : baseOutput,
        toolId,
        metadata: {
          path: filePath,
          size: stats.size,
          violations: gate.violations.length > 0 ? gate.violations : undefined,
          peerConflict: conflict.conflicted ? conflict.by.map((c) => ({ threadId: c.threadId, file: c.file })) : undefined,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        toolId,
      };
    }
  }

  /**
   * Surgical edit: replace old_string with new_string
   */
  async executeReplace(toolId, filePath, oldString, newString) {
    try { await fsPromises.appendFile(path.join(os.homedir(), ".pane", "record-change-debug.log"), `[${new Date().toISOString()}] executeReplace called: file=${filePath}\n`); } catch {}
    try {
      // Resolve and validate path
      const resolvedPath = this.resolveProjectPath(filePath);
      if (!resolvedPath) {
        return {
          success: false,
          error: `Invalid file path: ${filePath}`,
          toolId,
        };
      }

      // Check if file exists and is readable
      try {
        await fsPromises.access(
          resolvedPath,
          fs.constants.R_OK | fs.constants.W_OK,
        );
      } catch {
        return {
          success: false,
          error: `File does not exist or is not writable: ${filePath}`,
          toolId,
        };
      }

      // Read current content
      const currentContent = await fsPromises.readFile(
        resolvedPath,
        DEFAULT_ENCODING,
      );

      // Check for exact match
      if (!currentContent.includes(oldString)) {
        return {
          success: false,
          error: "Could not find the specified string to replace",
          toolId,
          hint: "Make sure old_string exactly matches the content in the file, including indentation and whitespace.",
        };
      }

      // Check for multiple occurrences
      const occurrences = currentContent.split(oldString).length - 1;
      if (occurrences > 1) {
        return {
          success: false,
          error: `Found ${occurrences} occurrences of old_string. Please provide more context to make it unique.`,
          toolId,
        };
      }

      // Compute start line from file position
      const matchIndex = currentContent.indexOf(oldString);
      const startLine = matchIndex >= 0
        ? currentContent.substring(0, matchIndex).split("\n").length
        : 1;

      // ── Cross-thread conflict check ──
      const relativePath = path.relative(this.projectRoot, resolvedPath);
      const conflict = checkConflict(this.projectRoot, this.projectId, relativePath);

      // Copy-on-write: save pre-edit state for checkpoint/restore
      await this.journalFileWrite(filePath);

      // Replace
      const newContent = currentContent.replace(oldString, newString);
      await fsPromises.writeFile(resolvedPath, newContent, DEFAULT_ENCODING);

      // ── Record intent for cross-thread awareness ──
      recordIntent(this.projectId, relativePath, { action: "editing" });

      // Invalidate cache — file content changed
      fileReadCache.invalidate(resolvedPath);

      // Record the change in change history
      try {
        await this.recordChange({
          filePath: relativePath,
          oldString,
          newString,
          timestamp: Date.now(),
        });
      } catch (recorderError) {
        console.error("Failed to record change:", recorderError);
        // Don't fail the operation if recording fails
      }

      const stats = await fsPromises.stat(resolvedPath);

      // ── Reflex Gate: scan for quality violations ──
      const gate = scanForViolations(newContent, currentContent, filePath);
      let baseOutput = `File edited: ${filePath}\nNew size: ${stats.size} bytes`;

      // ── Cross-thread conflict warning ──
      if (conflict.conflicted) {
        const peerIds = conflict.by.map((c) => `\`${c.threadId.slice(0, 8)}\``).join(", ");
        baseOutput += `\n\n⚠ Peer conflict: another thread (${peerIds}) recently touched this file. They may be mid-change — coordinate with the user if this wasn't intentional.`;
      }

      return {
        success: true,
        output: gate.summary ? baseOutput + gate.summary : baseOutput,
        toolId,
        metadata: { startLine, ...(gate.violations.length > 0 ? { violations: gate.violations } : {}), ...(conflict.conflicted ? { peerConflict: conflict.by.map((c) => ({ threadId: c.threadId, file: c.file })) } : {}) },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        toolId,
      };
    }
  }

  /**
   * Search for patterns in files (grep)
   */
  async executeGrepSearch(toolId, query, searchPath = ".", includePattern = null) {
    try {
      const resolvedSearchPath = this.resolveProjectPath(searchPath);
      if (!resolvedSearchPath) {
        return { success: false, error: `Invalid search path: ${searchPath}`, toolId };
      }

      const results = [];
      const commonExtensions = [
        ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", ".py", ".rb", ".java", ".cpp", ".c", ".h", ".hpp", ".go", ".rs", ".php", ".html", ".css", ".scss", ".less", ".json", ".yml", ".yaml", ".toml", ".md", ".txt", ".sh", ".bash",
      ];

      // Build matcher: try regex first (since tool is called grep_search), fall back to substring
      let matchFn;
      try {
        const re = new RegExp(query, "m");
        matchFn = (line) => re.test(line);
      } catch {
        // Not valid regex — use substring match
        matchFn = (line) => line.includes(query);
      }

      const includeRegex = includePattern
        ? new RegExp(includePattern.replace(/\*/g, ".*").replace(/\?/g, "."))
        : null;

      const shouldIncludeFile = (filePath) => {
        const name = path.basename(filePath);
        if (includeRegex) {
          return includeRegex.test(name) || includeRegex.test(filePath);
        }
        const ext = path.extname(name).toLowerCase();
        return commonExtensions.includes(ext);
      };

      const searchFile = async (filePath) => {
        try {
          const content = await fsPromises.readFile(filePath, DEFAULT_ENCODING);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matchFn(lines[i])) {
              results.push({
                file: path.relative(this.projectRoot, filePath),
                line: i + 1,
                content: lines[i].trim(),
              });
              if (results.length >= 50) return true; // signal to stop
            }
          }
        } catch {
          // skip unreadable files
        }
        return false;
      };

      // Check if path is a file or directory
      const stat = await fsPromises.stat(resolvedSearchPath).catch(() => null);
      if (stat && stat.isFile()) {
        // Single file search — no extension filtering needed
        await searchFile(resolvedSearchPath);
      } else if (stat && stat.isDirectory()) {
        // Directory walk — collect matching files up to a cap
        const walk = async (dir) => {
          const files = [];
          try {
            const items = await fsPromises.readdir(dir, { withFileTypes: true });
            for (const item of items) {
              if (files.length >= 1000) break;
              const fullPath = path.join(dir, item.name);
              if (item.isDirectory()) {
                if (!["node_modules", ".git", ".next", ".nuxt", ".output", "dist", "build", "coverage", ".cache"].includes(item.name)) {
                  files.push(...await walk(fullPath));
                }
              } else if (shouldIncludeFile(fullPath)) {
                files.push(fullPath);
              }
            }
          } catch {
            // skip unreadable dirs
          }
          return files;
        };

        const allFiles = await walk(resolvedSearchPath);
        for (const file of allFiles) {
          const shouldStop = await searchFile(file);
          if (shouldStop) break;
        }
      } else {
        // Path doesn't exist or can't be stated
        if (resolvedSearchPath === this.projectRoot || searchPath === ".") {
          // Fallback: walk project root
          const walk = async (dir) => {
            const files = [];
            try {
              const items = await fsPromises.readdir(dir, { withFileTypes: true });
              for (const item of items) {
                if (files.length >= 1000) break;
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                  if (!["node_modules", ".git", ".next", ".nuxt", ".output", "dist", "build", "coverage", ".cache"].includes(item.name)) {
                    files.push(...await walk(fullPath));
                  }
                } else if (shouldIncludeFile(fullPath)) {
                  files.push(fullPath);
                }
              }
            } catch {}
            return files;
          };

          const allFiles = await walk(resolvedSearchPath);
          for (const file of allFiles) {
            const shouldStop = await searchFile(file);
            if (shouldStop) break;
          }
        } else {
          return { success: false, error: `Search path does not exist: ${searchPath}`, toolId };
        }
      }

      if (results.length === 0) {
        return { success: true, output: `No matches found for "${query}"`, toolId };
      }

      const output = results.map((r) => `${r.file}:${r.line}: ${r.content}`).join("\n");
      return { success: true, output: sanitizeString(`Found ${results.length} match(es) for "${query}":\n\n${output}`), toolId };
    } catch (error) {
      return { success: false, error: error.message, toolId };
    }
  }

  /**
   * Glob search for files
   */
  async executeGlob(toolId, pattern, dirPath = null) {
    try {
      let cwd = this.projectRoot;
      if (dirPath) {
        const resolved = this.resolveProjectPath(dirPath);
        if (resolved) cwd = resolved;
      }

      const { glob } = await import("glob");
      const matches = await glob(pattern, { cwd, absolute: false, ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"] });
      
      if (matches.length === 0) {
        return { success: true, output: `No files matched pattern: ${pattern}`, toolId };
      }

      return {
        success: true,
        output: matches.join("\n"),
        toolId,
        metadata: { pattern, count: matches.length, cwd }
      };
    } catch (error) {
      return { success: false, error: error.message, toolId };
    }
  }

  /**
   * Fetch a URL and extract text content
   */
  async executeWebFetch(toolId, url, instructions = "") {
    if (!url || !url.trim()) {
      return { success: false, output: "No URL provided.", toolId };
    }
    const urlMatch = url.trim().match(/^https?:\/\/[^\s]+/);
    if (!urlMatch) {
      return { success: false, output: `Invalid URL: "${url.slice(0, 100)}"`, toolId };
    }
    const cleanUrl = urlMatch[0];

    const header = instructions
      ? `[Fetched: ${cleanUrl}]\n[Focus: ${instructions}]\n\n`
      : `[Fetched: ${cleanUrl}]\n\n`;

    // Try Tavily Extract first — handles JS-rendered pages, returns clean markdown.
    try {
      const settingsPath = path.join(os.homedir(), ".pane", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const tavilyKey = settings.http_api_keys?.tavily || settings.tavilyApiKey;

      if (tavilyKey) {
        const response = await fetch("https://api.tavily.com/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyKey,
            urls: [cleanUrl],
            include_images: false,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (response.ok) {
          const data = await response.json();
          const result = data.results?.[0];
          if (result?.raw_content) {
            const content = sanitizeString(result.raw_content.slice(0, 15000));
            return { success: true, output: header + content, toolId };
          }
        }
      }
    } catch {
      // Tavily unavailable or failed — fall through to direct fetch
    }

    // Fallback: direct fetch with HTML → plain text stripping
    try {
      const response = await fetch(cleanUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        return { success: false, output: `Failed to fetch URL: ${response.status} ${response.statusText}`, toolId };
      }
      const text = await response.text();
      const cleanText = text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 15000);
      const sanitizedText = sanitizeString(cleanText);

      return { success: true, output: header + sanitizedText, toolId };
    } catch (err) {
      return { success: false, output: `Error fetching URL: ${err.message}`, toolId };
    }
  }

  /**
   * Web search — returns structured results from the web.
   * Uses Brave Search API if key is configured, DuckDuckGo HTML fallback otherwise.
   */
  async executeGoogleWebSearch(toolId, query) {
    if (!query || !query.trim()) {
      return { success: false, error: "Empty search query", toolId };
    }

    // Try Tavily Search API first (if key configured) — AI-native search
    // that returns extracted page content, not just snippets.
    try {
      const settingsPath = path.join(os.homedir(), ".pane", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const tavilyKey = settings.http_api_keys?.tavily || settings.tavilyApiKey;

      if (tavilyKey) {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyKey,
            query,
            max_results: 5,
            include_answer: true,
            search_depth: "basic",
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (response.ok) {
          const data = await response.json();
          const parts = [];

          // Tavily can return a direct answer
          if (data.answer) {
            parts.push(`Answer: ${data.answer}\n`);
          }

          const results = (data.results || []).slice(0, 5);
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            parts.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || ""}`);
          }

          if (parts.length > 0) {
            return { success: true, output: sanitizeString(`Search results for "${query}":\n\n${parts.join("\n\n")}`), toolId };
          }
        }
      }
    } catch {}

    // Fallback: DuckDuckGo HTML (no API key needed)
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        return { success: false, error: `Search failed: ${response.status}`, toolId };
      }

      const html = await response.text();

      // Parse DuckDuckGo HTML results — each result is in a .result class
      const results = [];
      const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
        const url = match[1];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        if (title && url) {
          results.push({ title, url, snippet });
        }
      }

      // Fallback regex if the above didn't match (DDG changes their HTML occasionally)
      if (results.length === 0) {
        const linkRegex = /<a[^>]*class="result__url"[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = linkRegex.exec(html)) !== null && results.length < 8) {
          const url = match[1].trim();
          const snippet = match[2].replace(/<[^>]+>/g, "").trim();
          if (url) results.push({ title: url, url, snippet });
        }
      }

      if (results.length === 0) {
        return { success: true, output: `No results found for "${query}".`, toolId };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      ).join("\n\n");

      return { success: true, output: sanitizeString(`Search results for "${query}":\n\n${formatted}`), toolId };
    } catch (err) {
      return { success: false, error: `Search failed: ${err.message}`, toolId };
    }
  }

  /**
   * Resolve a file path relative to project root — no boundary restrictions
   */
  resolveProjectPath(filePath) {
    if (!filePath || typeof filePath !== "string") return null;
    return path.resolve(this.projectRoot, path.normalize(filePath));
  }

  /**
   * Execute any tool by name
   */
  async executeTool(toolId, toolName, input) {
    const paneDir = path.join(os.homedir(), ".pane");
    const stateDir = path.join(paneDir, "state", this.projectId);
    const memoryDir = path.join(paneDir, "memory", this.projectId);

    const readJson = async (p) => {
      try { return JSON.parse(await fsPromises.readFile(p, "utf-8")); }
      catch { return null; }
    };

    try {
      switch (toolName) {
        case "pane_codebase_compass": {
          if (!this._brainRequest) return { success: false, error: "Brain worker not available for codebase compass.", toolId };
          const query = input?.query || "";
          const limit = input?.limit || 8;
          
          try {
            const resp = await this._brainRequest("codebase_compass", {
              projectId: this.projectId,
              query,
              projectRoot: this.projectRoot,
              limit
            });
            
            if (resp.error) return { success: false, error: resp.error, toolId };
            
            const results = resp.result || [];
            if (results.length === 0) return { success: true, output: "Codebase compass found no relevant neighborhood for this query.", toolId };

            const out = results.map(r => {
              const reasons = r.reasons.join(", ");
              return `- ${r.path}\n    ${r.description || ""}\n    (Context: ${reasons})`;
            }).join("\n");

            return { success: true, output: `Codebase Compass - Relevant neighborhood for "${query}":\n\n${out}`, toolId };
          } catch (err) {
            return { success: false, error: `Codebase compass failed: ${err.message}`, toolId };
          }
        }

        case "run_shell_command":
        case "bash":
          return await this.executeBash(toolId, input.command, input.is_background || input.background || false, input.dir_path || null);

        case "Read":
        case "read_file":
          return await this.executeReadFile(toolId, input.file_path || input.path, input.start_line || null, input.end_line || null);

        case "pane_read_files": {
          // Batch read: read multiple files in one tool call.
          // Eliminates sequential round-trips where each resends full history.
          const paths = input.paths || [];
          if (paths.length === 0) return { success: false, error: "No paths provided", toolId };
          if (paths.length > 15) return { success: false, error: "Maximum 15 files per batch read", toolId };

          const results = [];
          for (const p of paths) {
            const result = await this.executeReadFile(toolId, p);
            if (result.success) {
              results.push(`### ${p}\n\`\`\`\n${result.output}\n\`\`\``);
            } else {
              results.push(`### ${p}\n[Error: ${result.error}]`);
            }
          }
          return {
            success: true,
            output: `Read ${paths.length} files:\n\n${results.join("\n\n")}`,
            toolId,
          };
        }

        case "pane_directory":
          return await this.executeListDirectory(toolId, input.dir_path || input.path);

        case "write_file":
          return await this.executeWriteFile(toolId, input.file_path || input.path, input.content);

        case "replace":
          return await this.executeReplace(toolId, input.file_path || input.path, input.old_string, input.new_string);

        case "Glob":
        case "glob":
          return await this.executeGlob(toolId, input.pattern, input.dir_path || null);

        case "Grep":
        case "grep_search":
          return await this.executeGrepSearch(toolId, input.pattern || input.query, input.dir_path || input.path || ".", input.include_pattern || null);

        case "google_web_search":
          return await this.executeGoogleWebSearch(toolId, input.query);

        case "web_fetch":
          return await this.executeWebFetch(toolId, input.url, input.instructions || "");

        case "pane_project_context": {
          const data = await readJson(path.join(stateDir, "project.json"));
          if (!data) {
            return {
              success: true,
              output: `Project: ${this.projectId}\nRoot: ${this.projectRoot}\nNo state file found yet — Pane hasn't synced state.`,
              toolId
            };
          }
          let out = `Project: ${data.name}\nRoot: ${data.root}`;
          if (data.gitBranch) out += `\nGit branch: ${data.gitBranch}`;
          if (data.topLevelFiles?.length) out += `\nTop-level files:\n${data.topLevelFiles.map(f => `  ${f}`).join("\n")}`;
          return { success: true, output: out, toolId };
        }

        case "pane_open_files": {
          const data = await readJson(path.join(stateDir, "editor.json"));
          if (!data || !data.activeFile) return { success: true, output: "No file currently open in editor.", toolId };
          let out = `Open file: ${data.activeFile}`;
          if (data.recentFiles?.length > 1) {
            out += `\nRecent files: ${data.recentFiles.slice(0, 10).join(", ")}`;
          }
          if (data.content) {
            const lines = data.content.split("\n");
            const preview = lines.length > 200
              ? lines.slice(0, 200).join("\n") + `\n... (${lines.length - 200} more lines)`
              : data.content;
            out += `\n\n--- Content ---\n${preview}`;
          }
          return { success: true, output: out, toolId };
        }

            case "pane_run_in_terminal": {
          const command = (input?.command || "").trim();
          if (!command) return { success: false, error: "No command provided.", toolId };
          const result = await this.executeBash(toolId, command, false, null);
          // Contextual augmentation: if command failed, auto-attach error-referenced files
          if (!result.success && result.output) {
            const aug = await augmentWithReferencedFiles(result.output || result.error || "", this.projectRoot);
            if (aug) result.output = (result.output || result.error || "") + aug;
          }
          return result;
        }

        case "pane_recall": {
          const query = (input?.query || "").trim();

          // Try brain semantic search first (if export exists)
          const brainExportPath = path.join(paneDir, "brain", "exports", `${this.projectId}.json`);
          if (query && fs.existsSync(brainExportPath)) {
            const exported = await readJson(brainExportPath);
            if (exported && exported.length > 0) {
              const queryEmbedding = await embedText(query, paneDir);
              const queryLower = query.toLowerCase();

              const scored = exported.map(node => {
                let score = 0;
                if (queryEmbedding && node.embedding) {
                  score = 0.6 * cosineSimilarity(queryEmbedding, node.embedding);
                }
                score += 0.4 * fuzzyScore(queryLower, (node.content || "").toLowerCase());
                return { ...node, score };
              }).filter(s => s.type !== "mind" && s.score > 0.15).sort((a, b) => b.score - a.score);

              if (scored.length > 0) {
                const matches = scored.slice(0, 30);
                const out = matches.map(r => {
                  return `[${r.type}] (match: ${(r.score * 100).toFixed(0)}%)\n${r.content}`;
                }).join("\n\n");
                return { success: true, output: out, toolId };
              }
            }
          }

          // Fallback: JSONL fuzzy search
          const eventsPath = path.join(memoryDir, "events.jsonl");
          let raw = "";
          try { raw = await fsPromises.readFile(eventsPath, "utf-8"); }
          catch { return { success: true, output: "No project memory yet — this is the first session.", toolId }; }

          const events = raw.trim().split("\n").map(line => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);

          let matches;
          if (query) {
            const queryLower = query.toLowerCase();
            const scored = events.map(e => {
              const content = (e.content || "").toLowerCase();
              const type = (e.type || "").toLowerCase();
              const score = Math.max(fuzzyScore(queryLower, content), fuzzyScore(queryLower, type));
              return { event: e, score };
            }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
            matches = scored.map(s => s.event).slice(0, 30);
          } else {
            matches = events.slice(-30);
          }

          if (matches.length === 0) {
            return { success: true, output: query ? `No memories matching "${query}".` : "No memories recorded yet.", toolId };
          }

          const timeSince = (timestamp) => {
            const seconds = Math.floor((Date.now() - timestamp) / 1000);
            if (seconds < 60) return "just now";
            if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
            if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
            return `${Math.floor(seconds / 86400)}d ago`;
          };

          const out = matches.map(e => {
            const ago = e.timestamp ? timeSince(e.timestamp) : "";
            const meta = e.metadata ? Object.entries(e.metadata).map(([k, v]) => `${k}=${v}`).join(" ") : "";
            return `[${e.type}]${ago ? ` (${ago})` : ""}${meta ? ` {${meta}}` : ""}\n${e.content}`;
          }).join("\n\n");
          return { success: true, output: out, toolId };
        }

        case "pane_remember": {
          if (!input?.content) return { success: false, error: "Nothing to remember — content is required.", toolId };

          // Tag with active skills so the playbook engine can correlate
          // observations with skills and build skill-specific principles.
          const activeSkills = getActiveSkills(this.projectId);
          const skillTags = activeSkills.size > 0 ? [...activeSkills] : [];

          const event = {
            type: input.type || "decision",
            content: input.content,
            timestamp: Date.now(),
            source: "http-backend",
            ...(skillTags.length > 0 ? { skills: skillTags } : {}),
          };
          await fsPromises.mkdir(memoryDir, { recursive: true });
          await fsPromises.appendFile(
            path.join(memoryDir, "events.jsonl"),
            JSON.stringify(event) + "\n",
          );
          // Immediately index into brain knowledge graph so it's semantically
          // searchable on the next turn — fire-and-forget, non-blocking.
          if (this._brainRequest) {
            this._brainRequest("index_events", {
              projectId: this.projectId,
              events: [event],
            }).catch(err => console.warn("[tool-executor] brain index_events (from pane_remember) failed:", err.message));
          }
          const tagNote = skillTags.length > 0 ? ` [skills: ${skillTags.join(", ")}]` : "";
          return { success: true, output: `Saved to project memory: [${event.type}] ${event.content}${tagNote}`, toolId };
        }

        case "pane_recall_all": {
          const query = (input?.query || "").trim();
          if (!query) return { success: false, error: "Query is required for cross-project search.", toolId };

          const memoryRoot = path.join(paneDir, "memory");
          let projectDirs;
          try { projectDirs = await fsPromises.readdir(memoryRoot); }
          catch { return { success: true, output: "No project memory found.", toolId }; }

          const queryLower = query.toLowerCase();
          const allResults = [];
          for (const projectDir of projectDirs) {
            const eventsPath = path.join(memoryRoot, projectDir, "events.jsonl");
            let raw = "";
            try { raw = await fsPromises.readFile(eventsPath, "utf-8"); } catch { continue; }

            const events = raw.trim().split("\n").map(line => {
              try { return JSON.parse(line); } catch { return null; }
            }).filter(Boolean);

            for (const e of events) {
              const content = (e.content || "").toLowerCase();
              const score = fuzzyScore(queryLower, content);
              if (score > 0) {
                allResults.push({ event: e, project: projectDir, score });
              }
            }
          }

          allResults.sort((a, b) => b.score - a.score);
          const top = allResults.slice(0, 20);

          if (top.length === 0) {
            return { success: true, output: `No memories matching "${query}" across any project.`, toolId };
          }

          const out = top.map(r => {
            const e = r.event;
            return `[${r.project}] [${e.type}]\n${e.content}`;
          }).join("\n\n");
          return { success: true, output: out, toolId };
        }

        case "pane_knowledge_graph": {
          if (!this.projectId) return { success: false, error: "No project active.", toolId };
          if (!this._brainRequest) return { success: false, error: "Brain worker not available — knowledge graph requires brain.", toolId };

          try {
            const result = await this._brainRequest("knowledge_graph", { projectId: this.projectId });
            if (!result || result.error) {
              return { success: true, output: "Knowledge graph not yet available — create memories with pane_remember first.", toolId };
            }

            const { typeCounts, nodes, edgeTypes, totalEdges } = result;
            if (!typeCounts || typeCounts.length === 0) {
              return { success: true, output: "No nodes in knowledge graph yet. Use pane_remember to record decisions and lessons.", toolId };
            }

            const parts = [];

            // Summary stats
            const totalNodes = typeCounts.reduce((s, t) => s + t.count, 0);
            parts.push(`Knowledge graph: ${totalNodes} nodes, ${totalEdges || 0} edges`);
            parts.push("");

            // Type breakdown
            parts.push("Node types:");
            for (const t of typeCounts) {
              parts.push(`  ${t.entity_type}: ${t.count}`);
            }
            if (edgeTypes && Object.keys(edgeTypes).length > 0) {
              parts.push("");
              parts.push("Edge types:");
              for (const [type, count] of Object.entries(edgeTypes)) {
                parts.push(`  ${type}: ${count}`);
              }
            }

            // Top nodes by confidence
            if (nodes && nodes.length > 0) {
              parts.push("");
              parts.push("Top memories:");
              const typeLabel = (t) => {
                const labels = { decision: "Decision", lesson: "Lesson", error_fix: "Fix", pattern: "Pattern", principle: "Principle" };
                return labels[t] || t;
              };
              for (const n of nodes.slice(0, 10)) {
                const label = typeLabel(n.entity_type);
                const conf = (n.confidence * 100).toFixed(0);
                const accesses = n.access_count || 0;
                parts.push(`  [${label}] (${conf}% conf, ${accesses}x) ${n.content?.slice(0, 200) || n.name}`);
              }
              if (nodes.length > 10) parts.push(`  ... and ${nodes.length - 10} more`);
            }

            return { success: true, output: parts.join("\n"), toolId };
          } catch (err) {
            return { success: false, error: `Knowledge graph query failed: ${err.message}`, toolId };
          }
        }

        case "pane_brief": {
          const briefPath = path.join(memoryDir, "brief.md");
          let brief = "";
          try { brief = await fsPromises.readFile(briefPath, "utf-8"); }
          catch { return { success: true, output: "No project brief yet — memory will accumulate as you work.", toolId }; }
          return { success: true, output: brief, toolId };
        }

        case "pane_checkpoints": {
          const cpDir = path.join(paneDir, "checkpoints", this.projectId);
          let manifest = null;
          try { manifest = JSON.parse(await fsPromises.readFile(path.join(cpDir, "manifest.json"), "utf-8")); }
          catch { return { success: true, output: "No checkpoints available.", toolId }; }

          if (!manifest?.checkpoints?.length) return { success: true, output: "No checkpoints available.", toolId };

          const out = manifest.checkpoints.map(cp => {
            return `${cp.id} — ${cp.fileCount} files`;
          }).join("\n");
          return { success: true, output: `${manifest.checkpoints.length} checkpoints:\n${out}`, toolId };
        }

        case "pane_checkpoint": {
          const result = await flushJournal({
            projectId: this.projectId,
            workingDir: this.projectRoot,
            journal: this.fileJournal,
            label: input.label,
          });
          if (!result.id) {
            const why = result.reason === "no-files-journaled"
              ? "no files have been modified in this turn yet"
              : "no snapshot could be taken";
            return { success: false, error: `Checkpoint not saved — ${why}.`, toolId };
          }
          // Flushed — clear the journal for the next turn
          this.fileJournal.clear();
          return {
            success: true,
            output: `Checkpoint saved (${result.fileCount} file${result.fileCount === 1 ? "" : "s"})${input.label ? ` — ${input.label}` : ""}. This state can be restored later if the changes don't work out.`,
            toolId,
          };
        }

        case "pane_change_history": {
          const db = getPaneDb();
          const rows = db.stmts.getChanges.all(this.projectId);
          if (rows.length === 0) return { success: true, output: "No change history yet. Changes will be recorded as you edit files.", toolId };

          const out = rows.map(c => {
            const date = new Date(c.timestamp).toLocaleString();
            const oldStr = c.old_string || "";
            const newStr = c.new_string || "";
            const shortOld = oldStr.length > 50 ? oldStr.slice(0, 50) + "..." : oldStr;
            const shortNew = newStr.length > 50 ? newStr.slice(0, 50) + "..." : newStr;
            return `${c.id} — ${c.file_path}\n  ${date}\n  "${shortOld}" → "${shortNew}"`;
          }).join("\n\n");
          return { success: true, output: `${rows.length} changes:\n\n${out}`, toolId };
        }

        case "pane_search_changes": {
          const { query, file_path: filePath } = input;
          const db = getPaneDb();
          let rows = [];

          if (filePath) {
            rows = db.stmts.searchChangesByFile.all(this.projectId, filePath);
          } else if (query) {
            const like = `%${query}%`;
            rows = db.stmts.searchChanges.all(this.projectId, like, like, like, like);
          } else {
            rows = db.stmts.getChanges.all(this.projectId);
          }

          if (rows.length === 0) return { success: true, output: "No matching changes found.", toolId };

          const out = rows.map(c => {
            const date = new Date(c.timestamp).toLocaleString();
            return `${c.id} — ${c.file_path}\n  ${date}\n  "${c.old_string || ""}" → "${c.new_string || ""}"`;
          }).join("\n\n");
          return { success: true, output: `${rows.length} matching changes:\n\n${out}`, toolId };
        }

        case "pane_revert_change": {
          const { change_id: changeId } = input;
          const db = getPaneDb();
          const change = db.stmts.getChangeById.get(changeId);

          if (!change) return { success: false, error: `Change ${changeId} not found.`, toolId };

          const resolvedPath = path.isAbsolute(change.file_path) 
            ? change.file_path 
            : path.join(this.projectRoot, change.file_path);

          try {
            const currentContent = await fsPromises.readFile(resolvedPath, "utf-8");
            const oldStr = change.old_string || "";
            const newStr = change.new_string || "";

            if (!currentContent.includes(newStr)) {
              return { success: false, error: "File content doesn't match expected change. The file may have been modified since this change was made.", toolId };
            }

            const revertedContent = currentContent.replace(newStr, oldStr);
            await fsPromises.writeFile(resolvedPath, revertedContent, "utf-8");

            db.stmts.deleteChangeById.run(changeId);

            return { success: true, output: `Reverted change in ${change.file_path}`, toolId };
          } catch (error) {
            return { success: false, error: error.message, toolId };
          }
        }

        case "pane_knowledge_graph": {
          const exportsDir = path.join(paneDir, "brain", "exports");
          let exported = null;
          try { exported = JSON.parse(await fsPromises.readFile(path.join(exportsDir, `${this.projectId}.json`), "utf-8")); }
          catch { return { success: true, output: "Knowledge graph is empty — it grows as you work.", toolId }; }

          if (!exported || exported.length === 0) return { success: true, output: "Knowledge graph is empty — it grows as you work.", toolId };

          // Group by type, sort by confidence within each group
          const byType = {};
          for (const node of exported) {
            if (!node.type) continue;
            if (!byType[node.type]) byType[node.type] = [];
            byType[node.type].push(node);
          }

          const parts = [`Knowledge graph: ${exported.length} nodes\n`];

          // Priority order: decisions and lessons first, then patterns, then everything else
          const typeOrder = ["decision", "lesson", "pattern", "error_fix", "principle"];
          const orderedTypes = [
            ...typeOrder.filter(t => byType[t]),
            ...Object.keys(byType).filter(t => !typeOrder.includes(t)),
          ];

          for (const type of orderedTypes) {
            const nodes = byType[type];
            if (!nodes || nodes.length === 0) continue;
            // Sort by confidence descending, show top 8 per type with FULL content
            const sorted = nodes
              .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
              .slice(0, 8);
            parts.push(`## ${type} (${nodes.length} total, showing top ${sorted.length})`);
            for (const n of sorted) {
              const conf = n.confidence != null ? ` [confidence: ${n.confidence.toFixed(2)}]` : "";
              parts.push(`- ${n.content}${conf}`);
            }
            parts.push("");
          }

          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_cross_project": {
          const query = (input?.query || "").trim();
          if (!query) return { success: false, error: "Query is required for cross-project search.", toolId };

          const exportsDir = path.join(paneDir, "brain", "exports");
          let files;
          try { files = await fsPromises.readdir(exportsDir); }
          catch { return { success: true, output: "No brain exports found.", toolId }; }

          const queryEmbedding = await embedText(query, paneDir);
          const queryLower = query.toLowerCase();

          const allResults = [];
          for (const file of files) {
            if (!file.endsWith(".json")) continue;
            const otherProjectId = file.replace(".json", "");
            if (otherProjectId === this.projectId) continue;

            let exported = null;
            try { exported = JSON.parse(await fsPromises.readFile(path.join(exportsDir, file), "utf-8")); } catch { continue; }
            if (!exported || exported.length === 0) continue;

            for (const node of exported) {
              if (!["decision", "lesson", "pattern", "error_fix"].includes(node.type)) continue;
              
              let score = 0;
              if (queryEmbedding && node.embedding) {
                score = 0.6 * cosineSimilarity(queryEmbedding, node.embedding);
              }
              score += 0.4 * fuzzyScore(queryLower, (node.content || "").toLowerCase());

              if (score > 0.3) {
                allResults.push({ ...node, project: otherProjectId, score });
              }
            }
          }

          allResults.sort((a, b) => b.score - a.score);
          const top = allResults.slice(0, 15);

          if (top.length === 0) return { success: true, output: `No cross-project insights found for "${query}".`, toolId };

          const out = top.map(r => `[${r.project}] [${r.type}] (match: ${(r.score * 100).toFixed(0)}%)\n${r.content}`).join("\n\n");
          return { success: true, output: out, toolId };
        }

        case "pane_find_symbol": {
          const query = (input?.query || "").trim();
          if (!query) return { success: false, error: "Query is required.", toolId };

          const symbolsPath = path.join(paneDir, "brain", "symbols", `${this.projectId}.json`);
          let exported = null;
          try { exported = JSON.parse(await fsPromises.readFile(symbolsPath, "utf-8")); }
          catch { return { success: true, output: "Symbol index not available yet — it builds automatically when you open a project in Pane.", toolId }; }

          if (!exported?.symbols?.length) return { success: true, output: "No symbols indexed for this project.", toolId };

          const q = query.toLowerCase();
          const kindFilter = input?.kind;
          const fileFilter = input?.file?.toLowerCase();

          // Fuzzy score: exact > prefix > contains > file/doc
          const scored = exported.symbols
            .filter(s => !kindFilter || s.kind === kindFilter)
            .filter(s => !fileFilter || s.file.toLowerCase().includes(fileFilter))
            .map(s => {
              const n = s.name.toLowerCase();
              let score = 0;
              if (n === q)              score = 1.0;
              else if (n.startsWith(q)) score = 0.8;
              else if (n.includes(q))   score = 0.6;
              else if (s.file.toLowerCase().includes(q)) score = 0.3;
              else if (s.doc?.toLowerCase().includes(q)) score = 0.2;
              return score > 0 ? { ...s, score } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);

          if (scored.length === 0) {
            return { success: true, output: `No symbols matching "${query}" found.${kindFilter ? ` (kind: ${kindFilter})` : ""}`, toolId };
          }

          // Return symbols with code excerpts — the model gets location AND
          // implementation in one call, eliminating the follow-up read_file.
          const parts = [`${scored.length} symbol${scored.length > 1 ? "s" : ""} matching "${query}":\n`];
          for (const s of scored) {
            const doc = s.doc ? ` — ${s.doc}` : "";
            parts.push(`${s.name} (${s.kind}) → ${s.file}:${s.line}${doc}`);

            // Include code excerpt for top 5 results (10 lines around definition)
            if (scored.indexOf(s) < 5 && s.file && s.line) {
              try {
                const filePath = path.isAbsolute(s.file) ? s.file : path.join(this.projectRoot, s.file);
                const content = await fsPromises.readFile(filePath, "utf-8");
                const lines = content.split("\n");
                const start = Math.max(0, s.line - 2);
                const end = Math.min(lines.length, s.line + 12);
                const excerpt = lines.slice(start, end)
                  .map((l, i) => `  ${start + i + 1} │ ${l}`)
                  .join("\n");
                parts.push("```");
                parts.push(excerpt);
                parts.push("```");
              } catch {}
            }
            parts.push("");
          }

          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_find_references": {
          const symbol = (input?.symbol || "").trim();
          if (!symbol) return { success: false, error: "Symbol is required.", toolId };
          const projectRoot = input?.projectRoot || this.projectRoot;
          const projectId = input?.projectId || this.projectId;
          const { byFile, totalMatches, filesSearched } = await findReferences(symbol, projectRoot, { projectId });
          return { success: true, output: formatReferencesOutput(symbol, byFile, totalMatches, filesSearched), toolId };
        }

        case "pane_check_intents": {
          const file = (input?.file || "").trim();

          if (file) {
            // Check for conflicts on a specific file
            const conflict = checkConflict(this.projectRoot, this.projectId, file);
            if (conflict.conflicted) {
              const peerList = conflict.by.map((c) =>
                `- Thread \`${c.threadId.slice(0, 8)}\` touched \`${c.file}\` ${Math.round((Date.now() - c.ts) / 60000)}m ago`
              ).join("\n");
              return {
                success: true,
                output: `⚠ Conflict: other threads recently touched \`${file}\`:\n${peerList}\n\nCoordinate with the user before modifying this file.`,
                toolId,
              };
            }
            return {
              success: true,
              output: `No conflicts on \`${file}\`. No other active threads have touched it recently.`,
              toolId,
            };
          }

          // Get all peer intents
          const intents = readPeerIntents(this.projectRoot, this.projectId);
          if (intents.length === 0) {
            return { success: true, output: "No other threads are actively working on this project.", toolId };
          }

          // Group by threadId
          const byThread = new Map();
          for (const intent of intents) {
            let list = byThread.get(intent.threadId);
            if (!list) { list = []; byThread.set(intent.threadId, list); }
            list.push(intent);
          }

          const lines = [`${intents.length} active intent(s) from ${byThread.size} peer thread(s):`];
          for (const [threadId, threadIntents] of byThread) {
            const shortId = threadId.slice(0, 8);
            const fileList = [...new Set(threadIntents.map((i) => i.file))];
            lines.push(`\nThread \`${shortId}\`:`);
            for (const f of fileList.slice(0, 10)) {
              const latest = threadIntents.filter((i) => i.file === f).reduce((a, b) => (b.ts > a.ts ? b : a));
              lines.push(`  - \`${f}\` (${Math.round((Date.now() - latest.ts) / 60000)}m ago)`);
            }
            if (fileList.length > 10) lines.push(`  ... and ${fileList.length - 10} more files`);
          }

          return { success: true, output: lines.join("\n"), toolId };
        }

        case "pane_profile": {
          const profileDir = path.join(paneDir, "profile");
          const parts = [];

          try {
            const exported = await fsPromises.readFile(path.join(profileDir, "profile-export.md"), "utf-8");
            if (exported.trim().length > 10) parts.push(exported.trim());
          } catch {}

          if (parts.length === 0) return { success: true, output: "Profile is empty — it will grow as Pane observes your work patterns.", toolId };
          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_set_rule": {
          const rule = (input?.rule || "").trim();
          if (!rule) return { success: false, error: "Rule text is required.", toolId };

          const rulesPath = path.join(paneDir, "profile", "rules.md");
          let content = "";
          try { content = await fsPromises.readFile(rulesPath, "utf-8"); }
          catch { content = "# Explicit Rules\n"; }

          if (content.includes(rule)) return { success: true, output: `Rule already exists: "${rule}"`, toolId };

          content += `\n- ${rule}`;
          await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
          await fsPromises.writeFile(rulesPath, content);
          return { success: true, output: `Rule added: "${rule}"`, toolId };
        }

        case "pane_set_philosophy": {
          const philosophy = (input?.philosophy || "").trim();
          if (!philosophy) return { success: false, error: "Philosophy text is required.", toolId };

          const philPath = path.join(paneDir, "profile", "philosophy.md");
          await fsPromises.mkdir(path.dirname(philPath), { recursive: true });
          await fsPromises.writeFile(philPath, philosophy);
          return { success: true, output: "Design philosophy updated.", toolId };
        }

        case "pane_set_about": {
          const about = (input?.about || "").trim();
          if (!about) return { success: false, error: "About text is required.", toolId };

          const projectId = process.env.PANE_PROJECT_ID || "";
          const aboutDir = path.join(paneDir, "memory", projectId);
          await fsPromises.mkdir(aboutDir, { recursive: true });
          await fsPromises.writeFile(path.join(aboutDir, "about.md"), about);
          return { success: true, output: "Project context recorded.", toolId };
        }

        case "TodoWrite": {
          // Handled primarily by renderer side parsing, but acknowledge here
          const count = input.todos?.length || 0;
          return { success: true, output: `Updated TODO list with ${count} item(s).`, toolId };
        }

        case "Task": {
          const task = input.task || "unknown";
          return { success: true, output: `Active task set to: ${task}`, toolId };
        }

        case "activate_skill": {
          const name = (input.name || "").trim();
          if (!name) return { success: false, error: "Skill name is required.", toolId };

          const result = activateSkill(this.projectId, name, this.projectRoot);
          if (!result.success) {
            return { success: false, error: result.error, toolId };
          }

          const body = result.body;
          const outputParts = [
            `## Skill Activated: ${name}`,
            "",
            body.instructions,
          ];

          // Include compose info if present
          if (body.compose) {
            outputParts.push("");
            outputParts.push("### Compatibility");
            const c = body.compose;
            if (c.extends?.length) outputParts.push(`- Extends: ${c.extends.join(", ")}`);
            if (c.conflicts?.length) outputParts.push(`- Conflicts with: ${c.conflicts.join(", ")}`);
            if (c.requires?.length) outputParts.push(`- Requires: ${c.requires.join(", ")}`);
          }

          // Include playbook if present
          if (body.playbook) {
            outputParts.push("");
            outputParts.push("### Domain Principles");
            outputParts.push(body.playbook);
          }

          // Include tool info if present
          if (body.tools) {
            outputParts.push("");
            outputParts.push(`### Bundled Tools: ${body.tools.length || Object.keys(body.tools).length} tool(s) available`);
          }

          // Persist active skill in session state so context-orchestrator injects it
          try {
            mergeState(this.projectId, {
              activeSkills: [...(readState(this.projectId)?.activeSkills || []), name.toLowerCase()]
                .filter((v, i, a) => a.indexOf(v) === i), // dedupe
            });
          } catch {
            // mergeState not critical — skill still works via tool result
          }

          return { success: true, output: outputParts.join("\n"), toolId };
        }

        case "deactivate_skill": {
          const name = (input.name || "").trim();
          if (!name) return { success: false, error: "Skill name is required.", toolId };

          const activeSkills = getActiveSkills(this.projectId);
          if (!activeSkills.has(name.toLowerCase())) {
            return {
              success: true,
              output: `Skill "${name}" is not currently active. Active skills: ${activeSkills.size > 0 ? [...activeSkills].join(", ") : "none"}.`,
              toolId,
            };
          }

          deactivateSkill(this.projectId, name);

          // Persist deactivation in session state
          try {
            const current = readState(this.projectId)?.activeSkills || [];
            mergeState(this.projectId, {
              activeSkills: current.filter((s) => s.toLowerCase() !== name.toLowerCase()),
            });
          } catch {
            // mergeState not critical
          }

          const remaining = getActiveSkills(this.projectId);
          return {
            success: true,
            output: `Skill "${name}" deactivated.${remaining.size > 0 ? ` Remaining active: ${[...remaining].join(", ")}.` : " No skills currently active."}`,
            toolId,
          };
        }

        case "pane_list_active_skills": {
          const activeSkills = getActiveSkills(this.projectId);

          if (activeSkills.size === 0) {
            return {
              success: true,
              output: "No skills are currently active. Use `pane_list_skills` to see available skills and `activate_skill` to load one.",
              toolId,
            };
          }

          const lines = [];
          for (const name of activeSkills) {
            const body = loadSkill(name, this.projectRoot);
            const meta = findSkill(name, this.projectRoot);
            const desc = meta?.description || (body?.instructions ? body.instructions.slice(0, 100) + "..." : "no description");
            const tags = meta?.tags?.length ? ` [${meta.tags.join(", ")}]` : "";
            lines.push(`- **${name}**${tags}: ${desc}`);
          }

          return {
            success: true,
            output: `## Active Skills (${activeSkills.size})\n\n${lines.join("\n")}\n\nUse \`deactivate_skill\` to unload a skill when it's no longer needed.`,
            toolId,
          };
        }

        case "pane_install_skill": {
          const url = (input.url || "").trim();
          if (!url) return { success: false, error: "Skill URL or path is required.", toolId };

          const renameTo = (input.name || "").trim() || null;

          // Handle github: URLs
          if (url.startsWith("github:")) {
            const githubPath = url.slice(7);
            const parts = githubPath.split("/");
            if (parts.length < 3) {
              return { success: false, error: "GitHub path must be: github:owner/repo/path/to/skill", toolId };
            }

            const owner = parts[0];
            const repo = parts[1];
            const skillPath = parts.slice(2).join("/");
            const repoUrl = `https://github.com/${owner}/${repo}.git`;

            const tmpDir = path.join(os.tmpdir(), `pane-skill-${repo}-${Date.now()}`);

            try {
              execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, {
                stdio: "pipe",
                timeout: 30_000,
              });
            } catch (err) {
              return { success: false, error: `Failed to clone repo: ${err.message}`, toolId };
            }

            const skillDir = path.join(tmpDir, skillPath);
            if (!fs.existsSync(skillDir)) {
              try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
              return { success: false, error: `Skill path "${skillPath}" not found in repo.`, toolId };
            }

            const skillName = renameTo || parts[parts.length - 1];
            ensureGlobalSkillsDir();
            const result = installSkill(skillDir, skillName);

            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

            if (!result.success) {
              return { success: false, error: result.error, toolId };
            }

            return {
              success: true,
              output: `## Skill Installed: ${result.name}\n\nInstalled from \`${url}\` to ~/.pane/skills/${result.name}/\n\nUse \`pane_list_skills\` to see all available skills, and \`activate_skill\` to load it.`,
              toolId,
            };
          }

          // Local directory path
          const resolved = path.resolve(url);
          if (!fs.existsSync(resolved)) {
            return { success: false, error: `Path "${resolved}" does not exist.`, toolId };
          }
          if (!fs.statSync(resolved).isDirectory()) {
            return { success: false, error: `Path "${resolved}" is not a directory.`, toolId };
          }

          ensureGlobalSkillsDir();
          const result = installSkill(resolved, renameTo);
          if (!result.success) {
            return { success: false, error: result.error, toolId };
          }

          return {
            success: true,
            output: `## Skill Installed: ${result.name}\n\nInstalled from \`${resolved}\` to ~/.pane/skills/${result.name}/\n\nUse \`pane_list_skills\` to see all available skills, and \`activate_skill\` to load it.`,
            toolId,
          };
        }

        case "pane_list_skills": {
          const query = (input.query || "").toLowerCase();
          const skills = discoverAll(this.projectRoot);

          if (skills.length === 0) {
            return {
              success: true,
              output: "No skills installed. Skills can be installed to ~/.pane/skills/ or to .pane/skills/ in your project. Each skill is a directory with a SKILL.md file.",
              toolId,
            };
          }

          let filtered = skills;
          if (query) {
            filtered = skills.filter(
              (s) =>
                s.name.toLowerCase().includes(query) ||
                s.description.toLowerCase().includes(query) ||
                s.tags.some((t) => t.toLowerCase().includes(query)),
            );
          }

          if (filtered.length === 0) {
            return {
              success: true,
              output: `No skills match "${input.query}". Use pane_list_skills without a query to see all ${skills.length} available skills.`,
              toolId,
            };
          }

          const lines = filtered.map((s) => {
            const tagStr = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
            const sourceLabel = s.source === "project" ? " (project)" : s.source === "builtin" ? " (built-in)" : "";
            return `- **${s.name}**${sourceLabel}${tagStr}: ${s.description}`;
          });

          return {
            success: true,
            output: `## Available Skills (${filtered.length}${query ? ` matching "${input.query}"` : ""} of ${skills.length} total)\n\n${lines.join("\n")}\n\nUse \`activate_skill\` with a skill name to load its instructions. Use \`pane_skill_info\` for full details on a specific skill.`,
            toolId,
          };
        }

        case "pane_skill_info": {
          const name = (input.name || "").trim();
          if (!name) return { success: false, error: "Skill name is required.", toolId };

          const meta = findSkill(name, this.projectRoot);
          if (!meta) {
            return {
              success: true,
              output: `Skill "${name}" not found. Use pane_list_skills to see available skills.`,
              toolId,
            };
          }

          const body = loadSkill(name, this.projectRoot);
          const parts = [
            `## ${meta.name}`,
            `**Version:** ${meta.version}`,
            `**Source:** ${meta.source}${meta.projectRoot ? ` (${meta.projectRoot})` : ""}`,
            `**Tags:** ${meta.tags.length > 0 ? meta.tags.join(", ") : "none"}`,
            `**Path:** ${meta.path}`,
            "",
            `### Description`,
            meta.description,
          ];

          if (body?.instructions) {
            parts.push("");
            parts.push("### Instructions");
            parts.push(body.instructions);
          }

          if (body?.compose) {
            parts.push("");
            parts.push("### Composition");
            const c = body.compose;
            if (c.extends?.length) parts.push(`- Extends: ${c.extends.join(", ")}`);
            if (c.provides?.length) parts.push(`- Provides: ${c.provides.join(", ")}`);
            if (c.conflicts?.length) parts.push(`- Conflicts: ${c.conflicts.join(", ")}`);
            if (c.requires?.length) parts.push(`- Requires: ${c.requires.join(", ")}`);
            if (c.priority !== undefined) parts.push(`- Priority: ${c.priority}`);
          }

          if (body?.playbook) {
            parts.push("");
            parts.push("### Domain Principles");
            parts.push(body.playbook);
          }

          if (body?.tools) {
            parts.push("");
            parts.push("### Bundled Tools");
            const tools = body.tools;
            const toolNames = Array.isArray(tools) 
              ? tools.map(t => typeof t === "string" ? t : t.function?.name || t.name || "unnamed")
              : Object.keys(tools);
            parts.push(toolNames.map(t => `- ${t}`).join("\n"));
          }

          if (body?.modelPrefs) {
            parts.push("");
            parts.push("### Model Preferences");
            parts.push(JSON.stringify(body.modelPrefs, null, 2));
          }

          return { success: true, output: parts.join("\n"), toolId };
        }

        case "save_memory": {
          const fact = input.fact || "";
          if (!fact) return { success: false, error: "Fact is required.", toolId };
          
          const globalMemoryPath = path.join(os.homedir(), ".gemini", "memory.md");
          try {
            await fsPromises.mkdir(path.dirname(globalMemoryPath), { recursive: true });
            await fsPromises.appendFile(globalMemoryPath, `- ${fact}\n`);
            return { success: true, output: `Saved to global memory: ${fact}`, toolId };
          } catch (err) {
            return { success: false, error: `Failed to save memory: ${err.message}`, toolId };
          }
        }

        case "pane_delegate": {
          const objective = (input?.objective || "").trim();
          if (!objective) return { success: false, error: "Research objective is required.", toolId };
          if (!this._agentCall) return { success: false, error: "Sub-agent engine not available (agentCall not wired).", toolId };

          // ── Compile the system prompt ─────────────────────────────────
          const playbook = this._readPlaybook();

          // Load project about for context
          let aboutBlock = "";
          try {
            const aboutPath = path.join(os.homedir(), ".pane", "memory", this.projectId, "about.md");
            if (fs.existsSync(aboutPath)) {
              aboutBlock = `\n## Project context\n\n${fs.readFileSync(aboutPath, "utf-8").trim().slice(0, 2000)}`;
            }
          } catch {}

          const systemPrompt = `You are pane_delegate, an autonomous executor sub-agent with full read/write access to the codebase.

Your job: accomplish the given objective. You have access to all tools — read files, write files, edit code, run shell commands, search the web, record memories, create checkpoints. Work until the objective is fully complete — there is no turn limit.

${aboutBlock}

${playbook || ""}

## Working in Pane

You are working inside a Pane project. You have access to the full tool set. Use it.

### Execution approach
1. **Understand first**: read relevant files before making changes
2. **Execute methodically**: one step at a time, verify each change
3. **Create checkpoints**: use pane_checkpoint before risky or large changes (you decide when)
4. **Record discoveries**: use pane_remember to persist important decisions, patterns, or lessons
5. **Report completion**: when the objective is fully accomplished, return a structured summary

### Finishing
When you are done, return a summary with:
- What was accomplished
- What files were changed and why
- Key decisions made
- Any follow-up items for the parent session`;

          try {
            const output = await this._agentCall(
              systemPrompt,
              `## Objective\n\n${objective}`,
              this.projectRoot,
              { phase: 'execution', maxTurns: 0 }
            );
            return { success: true, output, toolId };
          } catch (err) {
            return { success: false, error: `Execution failed: ${err.message}`, toolId };
          }
        }

        case "explore": {
          const { explore } = await import("./tool-explore.mjs");
          const result = await explore(
            input?.query || "",
            this.projectId,
            this.projectRoot,
            { brainRequest: this._brainRequest },
          );
          return { success: true, output: result || "No relevant results found.", toolId };
        }

        case "pane_codebase_navigator": {
          const target = (input?.target || "").trim();
          if (!target) return { success: false, error: "Target is required.", toolId };

          // Resolve target to a file — check direct path, then search src/
          let primaryFile = null;
          const rootDir = this.projectRoot;
          if (target.includes("/") || /\.\w+$/.test(target)) {
            const resolved = path.isAbsolute(target) ? target : path.join(rootDir, target);
            if (fs.existsSync(resolved)) primaryFile = resolved;
            if (!primaryFile) {
              for (const ext of [".tsx", ".ts", ".js", ".mjs"]) {
                if (fs.existsSync(resolved + ext)) { primaryFile = resolved + ext; break; }
              }
            }
          } else {
            // Search for file by name — route through cmd-worker (utility process)
            // to avoid SyncProcessRunner crash on main thread during streaming.
            try {
              const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
              const findCmd = `find ${sq(path.join(rootDir, "src"))} -name ${sq(`${target}.*`)} -not -path ${sq("*/node_modules/*")} 2>/dev/null | head -1`;
              const findResult = await execThroughWorker(findCmd, { timeout: 5 });
              if (findResult.success) {
                const firstLine = findResult.stdout.trim();
                if (firstLine) primaryFile = firstLine;
              }
            } catch {}
          }
          if (!primaryFile) return { success: false, error: `No file found matching "${target}".`, toolId };

          // Read file and extract imports
          const content = await fsPromises.readFile(primaryFile, "utf-8");
          const lines = content.split("\n");
          const relPath = path.relative(rootDir, primaryFile);
          const imports = [];
          const importedBy = [];

          // Extract imports from this file
          for (const line of lines) {
            const m = line.match(/^import\s+.*from\s+["']([^"']+)["']/);
            if (m && !m[1].startsWith("node:") && !m[1].includes("node_modules")) {
              imports.push(m[1]);
            }
          }

          // Find files that import this file (via symbol index if available)
          if (this._brainRequest) {
            try {
              const resp = await this._brainRequest("find_importers", { projectId: this.projectId, filePath: relPath });
              if (resp?.importers) importedBy.push(...resp.importers);
            } catch {}
          }

          const out = [`Dependency Map: ${relPath}\n`];
          out.push(`Imports (${imports.length}):`);
          for (const imp of imports) out.push(`  → ${imp}`);
          out.push(`\nImported by (${importedBy.length}):`);
          for (const imp of importedBy) out.push(`  ← ${imp}`);
          out.push(`\nFile: ${lines.length} lines`);

          return { success: true, output: out.join("\n"), toolId };
        }

        case "pane_ui_constraints": {
          const componentKey = (input?.component || "").toLowerCase();
          const constraintsPath = path.join(os.homedir(), ".pane", "memory", this.projectId, "ui-constraints.json");
          try {
            const data = JSON.parse(await fsPromises.readFile(constraintsPath, "utf-8"));
            const constraints = Array.isArray(data.constraints) ? data.constraints : [];

            const inferredCategories = new Set();
            if (componentKey.includes("input") || componentKey.includes("textarea")) inferredCategories.add("input");
            if (componentKey.includes("search")) inferredCategories.add("search");
            if (componentKey.includes("float") || componentKey.includes("panel") || componentKey.includes("picker")) inferredCategories.add("floating");

            const filtered = inferredCategories.size > 0
              ? constraints.filter(c => Array.isArray(c.categories) && c.categories.some(cat => inferredCategories.has(cat)))
              : constraints;

            const parts = [`UI Constraints for: ${input.component}\n`];
            for (const c of filtered) {
              parts.push(`• ${c.rule}`);
              if (c.forbiddenPatterns?.length) parts.push(`  Forbidden: ${c.forbiddenPatterns.join(", ")}`);
              if (c.positiveExample) parts.push(`  Do: ${c.positiveExample}`);
              if (c.negativeExample) parts.push(`  Don't: ${c.negativeExample}`);
            }
            return { success: true, output: parts.join("\n") || "No constraints found for this component type.", toolId };
          } catch {
            return { success: true, output: "No UI constraints registered for this project.", toolId };
          }
        }

        case "pane_architecture_brief": {
          const subsystemArg = (input?.subsystem || "").trim().toLowerCase();
          if (!subsystemArg) return { success: false, error: "Subsystem is required.", toolId };

          const subsystemsPath = path.join(os.homedir(), ".pane", "memory", this.projectId, "subsystems.json");
          try {
            const data = JSON.parse(await fsPromises.readFile(subsystemsPath, "utf-8"));
            const subsystems = Array.isArray(data.subsystems) ? data.subsystems : [];

            const matched = subsystems.find(s =>
              (s.id || "").toLowerCase() === subsystemArg ||
              (s.name || "").toLowerCase() === subsystemArg ||
              (Array.isArray(s.filePatterns) && s.filePatterns.some(p => subsystemArg.includes(p.toLowerCase())))
            );

            if (!matched) {
              const available = subsystems.map(s => `  • ${s.id} — ${s.name}`).join("\n");
              return { success: true, output: `No subsystem matched "${input.subsystem}".\n\nAvailable:\n${available}`, toolId };
            }

            const out = [`Architecture Brief: ${matched.name}\n`];
            if (matched.patternInEffect) out.push(`Pattern: ${matched.patternInEffect}\n`);
            const locked = Array.isArray(matched.lockedDecisions) ? matched.lockedDecisions : [];
            if (locked.length > 0) {
              out.push(`Locked decisions (${locked.length}):`);
              for (const d of locked) out.push(`  • ${d.decision}${d.rationale ? ` — ${d.rationale}` : ""}`);
            }
            return { success: true, output: out.join("\n"), toolId };
          } catch {
            return { success: true, output: "No subsystem registry found for this project.", toolId };
          }
        }

        // ── On-demand context tools ────────────────────────────────────────
        // These serve context the model explicitly requests instead of Pane
        // pre-loading it into the system prompt.

        case "pane_get_session_state": {
          const state = readState(this.projectId);
          const parts = [];

          // Stale task retirement — 8-hour threshold. Same policy as context-orchestrator.mjs.
          const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000;
          if (state.activeTask && (!state.activeTask.timestamp || (Date.now() - state.activeTask.timestamp) > STALE_THRESHOLD_MS)) {
            state.activeTask = null;
            // PERSIST: the caller doesn't have projectId for mergeState here, so we just report it
            parts.push("No active task set (previous task was stale and has been cleared).");
          } else if (state.activeTask) {
            const age = Math.round((Date.now() - state.activeTask.timestamp) / (1000 * 60 * 60));
            parts.push(`Active task (set ${age}h ago): ${state.activeTask.description}`);
            if (state.activeTask.goal) parts.push(`Goal: ${state.activeTask.goal}`);
          } else {
            parts.push("No active task set.");
          }

          // Todos with age annotation
          const todos = state.todos || [];
          if (todos.length > 0) {
            parts.push("\nTodos:");
            for (const t of todos) {
              const mark = t.status === "completed" ? "[✓]" : t.status === "in_progress" ? "[→]" : "[ ]";
              parts.push(`${mark} ${t.content}`);
            }
          }

          // Decisions
          const decisions = state.decisions || [];
          if (decisions.length > 0) {
            parts.push("\nLocked decisions:");
            for (const d of decisions.slice(0, 8)) {
              const age = d.timestamp
                ? `(${Math.round((Date.now() - d.timestamp) / (1000 * 60 * 60))}h ago)`
                : "";
              parts.push(`- ${d.content} ${age}`);
            }
          }

          // Recent actions
          const actions = state.recentActions || [];
          if (actions.length > 0) {
            parts.push("\nRecent actions:");
            for (const a of actions.slice(-5)) {
              parts.push(`- [${a.type}] ${a.content}`);
            }
          }

          // Working set
          if (state.workingSet?.length > 0) {
            parts.push("\nWorking set:");
            for (const f of state.workingSet.slice(0, 8)) {
              parts.push(`- ${f.path}${f.purpose ? ` — ${f.purpose}` : ""}`);
            }
          }

          parts.push(`\nSession: turn ${state.turnCount}, phase: ${state.phase}`);

          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_get_project_map": {
          // Read the codebase map from brain context export
          const mapPath = path.join(paneDir, "brain", "context", `${this.projectId}.json`);
          try {
            const data = JSON.parse(await fsPromises.readFile(mapPath, "utf-8"));
            if (data.codebaseMap) {
              return { success: true, output: data.codebaseMap, toolId };
            }
            // Fall back to listing files from the export
            if (Array.isArray(data) && data.length > 0) {
              const files = data.filter(n => n.type === "file").map(n => n.path || n.content).slice(0, 200);
              return { success: true, output: `Project files (${files.length}):\n${files.join("\n")}`, toolId };
            }
          } catch {}

          // Fallback: list files from working directory via cmd-worker
          try {
            const projResult = await execThroughWorker(
              `find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -200`,
              { cwd: this.workingDir, timeout: 5 }
            );
            if (projResult.success) {
              return { success: true, output: `Project files:\n${projResult.stdout}`, toolId };
            }
            return { success: true, output: "Could not read project file structure.", toolId };
          } catch {
            return { success: true, output: "Could not read project file structure.", toolId };
          }
        }

        case "pane_get_recent_changes": {
          const parts = [];

          // Git status via cmd-worker
          try {
            const statusR = await execThroughWorker("git status --short", { cwd: this.workingDir, timeout: 5 });
            const branchR = await execThroughWorker("git branch --show-current", { cwd: this.workingDir, timeout: 3 });
            if (branchR.success) {
              parts.push(`Branch: ${branchR.stdout.trim()}`);
            }
            if (statusR.success && statusR.stdout.trim()) {
              parts.push(`\nChanged files:\n${statusR.stdout.trim()}`);
            } else {
              parts.push("Working tree clean.");
            }
          } catch {
            parts.push("Git status unavailable.");
          }

          // Recent git log via cmd-worker
          try {
            const logR = await execThroughWorker("git log --oneline -5", { cwd: this.workingDir, timeout: 5 });
            if (logR.success && logR.stdout.trim()) {
              parts.push(`\nRecent commits:\n${logR.stdout.trim()}`);
            }
          } catch {}

          // Git diff summary via cmd-worker
          try {
            const diffR = await execThroughWorker("git diff --stat HEAD 2>/dev/null || git diff --stat", { cwd: this.workingDir, timeout: 5 });
            if (diffR.success && diffR.stdout.trim()) {
              parts.push(`\nDiff summary:\n${diffR.stdout.trim()}`);
            }
          } catch {}

          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_read_journal": {
          const query = (input?.query || "").trim().toLowerCase();
          const limit = Math.min(input?.limit || 10, 30);

          const journalData = replayJournal(this.projectId);
          if (!journalData.messages.length) {
            return { success: true, output: "No session journal entries found.", toolId };
          }

          // Get the last progress snapshot
          const progress = journalData.progress || readLastProgress(this.projectId);

          let entries = journalData.messages;

          // Filter by query if provided
          if (query) {
            entries = entries.filter(msg => {
              const text = typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content);
              return text.toLowerCase().includes(query);
            });
          }

          // Take last N entries
          entries = entries.slice(-limit);

          const parts = [];

          if (progress) {
            parts.push("[Last progress snapshot]");
            if (progress.accomplishments?.length > 0) {
              parts.push(`Completed: ${progress.accomplishments.join("; ")}`);
            }
            if (progress.decisions?.length > 0) {
              parts.push(`Decisions: ${progress.decisions.join("; ")}`);
            }
            if (progress.pendingTodos?.length > 0) {
              parts.push(`Pending: ${progress.pendingTodos.join("; ")}`);
            }
            parts.push("");
          }

          parts.push(`[Journal entries: ${entries.length}${query ? ` matching "${input.query}"` : ""}]`);
          for (const msg of entries) {
            const content = typeof msg.content === "string"
              ? msg.content.slice(0, 300)
              : Array.isArray(msg.content)
                ? msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").slice(0, 300)
                : JSON.stringify(msg.content).slice(0, 300);
            parts.push(`[${msg.role}] ${content}${content.length >= 300 ? "..." : ""}`);
          }

          return { success: true, output: parts.join("\n"), toolId };
        }

        case "pane_get_handoff": {
          const handoff = readHandoff(this.projectId);
          if (!handoff) {
            return { success: true, output: "No previous session handoff found. This may be the first session for this project.", toolId };
          }

          const parts = [];
          const age = handoff.timestamp
            ? Math.round((Date.now() - handoff.timestamp) / (1000 * 60 * 60))
            : null;

          parts.push(`Previous session handoff${age ? ` (${age}h ago)` : ""}:`);

          if (handoff._exitReason) {
            parts.push(`Exit reason: ${handoff._exitReason}${handoff._errorMessage ? ` — ${handoff._errorMessage}` : ""}`);
          }

          if (handoff.currentObjective) parts.push(`Objective: ${handoff.currentObjective}`);
          if (handoff.progress) parts.push(`Progress: ${handoff.progress}`);

          const renderItems = (label, items) => {
            if (!items?.length) return;
            parts.push(`\n${label}:`);
            for (const item of items) {
              const text = typeof item === "string" ? item : item.text || item.content || JSON.stringify(item);
              parts.push(`- ${text}`);
            }
          };

          renderItems("Accomplished", handoff.accomplishment);
          renderItems("Completed from history", handoff.completed_from_history);
          renderItems("Blockers", handoff.blockers);
          renderItems("Next steps", handoff.nextSteps);
          renderItems("Findings", handoff.findings);
          renderItems("Decisions", handoff.decisionsLocked);

          if (handoff.workingSet?.length > 0) {
            parts.push(`\nWorking set: ${handoff.workingSet.map(f => f.path || f).join(", ")}`);
          }

          return { success: true, output: parts.join("\n"), toolId };
        }

        default:
          return { success: false, error: `Unknown tool: ${toolName}`, toolId };
      }
    } catch (error) {
      return { success: false, error: `Tool execution error: ${error.message}`, toolId };
    }
  }

  /**
   * Kill a running background process
   */
  killProcess(toolId) {
    const process = this.activeProcesses.get(toolId);
    if (process) {
      try {
        process.kill("SIGTERM");
        this.activeProcesses.delete(toolId);
        return { success: true, toolId };
      } catch (error) {
        return { success: false, error: error.message, toolId };
      }
    }
    return { success: false, error: "Process not found", toolId };
  }

  /**
   * Clean up all resources
   */
  cleanup() {
    for (const [, activeProcess] of this.activeProcesses) {
      try { activeProcess.kill("SIGTERM"); } catch {} // Best-effort cleanup — process may already be dead
    }
    this.activeProcesses.clear();
  }
}
