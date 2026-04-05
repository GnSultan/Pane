/**
 * Pane Tool Executor
 *
 * Executes tools locally for HTTP backends (DeepSeek, Kimi, Anthropic, etc.)
 * Handles Bash commands, file operations, and other tools that CLI backends
 * would execute themselves.
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
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import crypto from "node:crypto";

import { getPaneDb } from "./pane-db.mjs";
import { findReferences, formatReferencesOutput } from "./find-references.mjs";

const execAsync = promisify(exec);

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

// ── Structural integrity checks ───────────────────────────────────────────
// These analyze the file as a whole — brace balance, truncated declarations,
// unclosed blocks. Common failure mode of junior/small models that truncate
// output or drop closing braces.

/**
 * Count delimiter balance while skipping strings, template literals, comments,
 * and regex literals. Returns the net imbalance and the line where the last
 * unmatched opener was seen.
 *
 * @param {string} content - Full file content
 * @param {string} open - Opening delimiter character
 * @param {string} close - Closing delimiter character
 * @returns {{ balance: number, lastOpenerLine: number }}
 */
function countDelimiterBalance(content, open, close) {
  let balance = 0;
  let lastOpenerLine = 0;
  let line = 1;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    // Track line numbers
    if (ch === "\n") { line++; i++; continue; }

    // Skip single-line comments
    if (ch === "/" && next === "/") {
      i = content.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }

    // Skip block comments
    if (ch === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end === -1) break;
      // Count newlines inside the comment
      for (let j = i; j < end + 2; j++) { if (content[j] === "\n") line++; }
      i = end + 2;
      continue;
    }

    // Skip strings (single/double quotes)
    if (ch === '"' || ch === "'") {
      i++;
      while (i < content.length) {
        if (content[i] === "\n") { line++; break; } // Unterminated — let it go
        if (content[i] === "\\" ) { i += 2; continue; }
        if (content[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }

    // Skip template literals (backtick) — handle nested ${} by tracking depth
    if (ch === "`") {
      i++;
      let templateDepth = 0;
      while (i < content.length) {
        if (content[i] === "\n") line++;
        if (content[i] === "\\" ) { i += 2; continue; }
        if (content[i] === "$" && content[i + 1] === "{") { templateDepth++; i += 2; continue; }
        if (content[i] === "}" && templateDepth > 0) { templateDepth--; i++; continue; }
        if (content[i] === "`" && templateDepth === 0) { i++; break; }
        i++;
      }
      continue;
    }

    // Count delimiters
    if (ch === open) {
      balance++;
      lastOpenerLine = line;
    } else if (ch === close) {
      balance--;
    }

    i++;
  }

  return { balance, lastOpenerLine };
}

/**
 * Detect truncated / incomplete file endings.
 * Junior models often cut off mid-declaration or mid-expression.
 *
 * @param {string} content - Full file content
 * @returns {Array<{id, severity, message, line}>}
 */
function checkTruncation(content) {
  const lines = content.split("\n");
  const violations = [];

  // Find last non-empty, non-comment line
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && /^\s*(\/\/.*)?$/.test(lines[lastIdx])) lastIdx--;
  if (lastIdx < 0) return violations;

  const lastLine = lines[lastIdx].trim();

  // Patterns that indicate truncated output
  const truncationPatterns = [
    // Ends with an assignment/arithmetic/logical operator — expression was cut off
    // Excludes: > (JSX closing), comma (trailing comma style), + in package versions
    { pattern: /[=\-*/%&|^!<]\s*$/, id: "truncated-expression",
      message: "File ends with an incomplete expression (trailing operator). The output appears to have been cut off." },
    // Ends with opening brace/paren — block never started
    { pattern: /[\{(\[]\s*$/, id: "truncated-block",
      message: "File ends with an opening brace/bracket that is never closed. The output appears to have been cut off." },
    // Ends with 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'export', 'import', 'return'
    { pattern: /\b(const|let|var|function|class|interface|type|export|import|return|extends|implements|async|await)\s*$/, id: "truncated-declaration",
      message: "File ends with an incomplete declaration keyword. The output appears to have been cut off mid-statement." },
    // Ends with arrow — function body never written
    { pattern: /=>\s*$/, id: "truncated-arrow",
      message: "File ends with an arrow (=>) but no function body. The output appears to have been cut off." },
    // Ends with colon (outside ternary/object, likely a type annotation cut off)
    { pattern: /:\s*$/, id: "truncated-type",
      message: "File ends with a colon but no type or value after it. The output appears to have been cut off." },
  ];

  for (const { pattern, id, message } of truncationPatterns) {
    if (pattern.test(lastLine)) {
      violations.push({ id, severity: "error", message, line: lastIdx + 1 });
      break; // One truncation error is enough
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

  // ── Structural integrity checks (whole-file analysis) ───────────────────
  // These run on the FINAL file content, not diffed — a broken file is broken
  // regardless of who introduced the imbalance.

  // Brace balance: { vs }
  const braces = countDelimiterBalance(newContent, "{", "}");
  if (braces.balance > 0) {
    violations.push({
      id: "unclosed-brace",
      severity: "error",
      message: `${braces.balance} unclosed brace(s) — opening '{' without matching '}'. Last unmatched opener is near line ${braces.lastOpenerLine}. The file has broken syntax.`,
      line: braces.lastOpenerLine,
    });
  } else if (braces.balance < 0) {
    violations.push({
      id: "extra-closing-brace",
      severity: "error",
      message: `${Math.abs(braces.balance)} extra closing brace(s) — '}' without matching '{'. The file has broken syntax.`,
      line: newLines.length,
    });
  }

  // Parenthesis balance: ( vs )
  const parens = countDelimiterBalance(newContent, "(", ")");
  if (parens.balance > 0) {
    violations.push({
      id: "unclosed-paren",
      severity: "error",
      message: `${parens.balance} unclosed parenthesis(es) — '(' without matching ')'. Last unmatched opener is near line ${parens.lastOpenerLine}. The file has broken syntax.`,
      line: parens.lastOpenerLine,
    });
  } else if (parens.balance < 0) {
    violations.push({
      id: "extra-closing-paren",
      severity: "error",
      message: `${Math.abs(parens.balance)} extra closing parenthesis(es) — ')' without matching '('. The file has broken syntax.`,
      line: newLines.length,
    });
  }

  // Bracket balance: [ vs ]
  const brackets = countDelimiterBalance(newContent, "[", "]");
  if (brackets.balance > 0) {
    violations.push({
      id: "unclosed-bracket",
      severity: "error",
      message: `${brackets.balance} unclosed bracket(s) — '[' without matching ']'. Last unmatched opener is near line ${brackets.lastOpenerLine}. The file has broken syntax.`,
      line: brackets.lastOpenerLine,
    });
  } else if (brackets.balance < 0) {
    violations.push({
      id: "extra-closing-bracket",
      severity: "error",
      message: `${Math.abs(brackets.balance)} extra closing bracket(s) — ']' without matching '['. The file has broken syntax.`,
      line: newLines.length,
    });
  }

  // Truncation detection: file ends mid-statement
  const truncations = checkTruncation(newContent);
  violations.push(...truncations);

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

// Dangerous command patterns (blacklist)
const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+.*-rf?\s+\//, // Root deletion
  /rm\s+.*-rf?\s+\*/, // Catch-all deletion
  /rm\s+.*\.\.\//,    // Relative deletion
  /mkfs/,             // Disk formatting
  /dd\s+if=.*(of=\/dev\/(sd|xvd|vd|nvme|loop|nbd))/, // Raw disk writing to block devices
  /passwd/,           // Password changing
  /shutdown|reboot/,  // System control
  /chmod\s+.*777/,    // Dangerous permissions
  // Block writes to system devices EXCEPT harmless ones
  // Allowed: /dev/null, /dev/zero, /dev/random, /dev/urandom, /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/
  />\s*\/dev\/(?!null|zero|random|urandom|stdin|stdout|stderr|fd\/)/,
];

/**
 * Validates a shell command for safety.
 *
 * Switch to Blacklist approach: Allow everything EXCEPT explicitly dangerous
 * patterns and attempts to escape the project directory.
 */
function validateCommand(command, projectRoot) {
  const trimmed = command.trim();
  if (!trimmed) return { valid: false, error: "Empty command" };

  // 1. Check against blacklist
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error: `Command contains dangerous pattern: ${pattern}`,
      };
    }
  }

  // 2. Check for attempts to escape directory
  // Allow 'node_modules/..' as it's common in npm operations.
  if (trimmed.includes("..") && !trimmed.includes("node_modules/..")) {
    if (trimmed.includes("../../")) {
      return {
        valid: false,
        error: "Path traversal detected (attempt to escape project)",
      };
    }
  }

  // 3. Block absolute paths to system directories
  const systemPaths = ["/etc/", "/var/", "/bin/", "/sbin/", "/usr/", "/root/"];
  for (const sysPath of systemPaths) {
    if (trimmed.includes(sysPath) && !trimmed.includes(projectRoot)) {
      return {
        valid: false,
        error: `Attempt to access system directory: ${sysPath}`,
      };
    }
  }

  return { valid: true };
}

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
   * Validate a shell command for safety
   */
  validateCommand(command) {
    return validateCommand(command, this.projectRoot);
  }

  /**
   * Execute a Bash command
   */
  async executeBash(toolId, command, background = false, cwd = null) {
    try {
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

      if (background) {
        // Run in background
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
        // Run and capture output
        const startTime = Date.now();

        const { stdout, stderr } = await execAsync(command, {
          ...execOptions,
          encoding: DEFAULT_ENCODING,
        });

        const duration = Date.now() - startTime;

        // Combine stdout and stderr
        let output = "";
        if (stdout) output += stdout;
        if (stderr) {
          if (output) output += "\n";
          output += `STDERR: ${stderr}`;
        }

        // Truncate if too large
        if (output.length > MAX_OUTPUT_SIZE) {
          output =
            output.substring(0, MAX_OUTPUT_SIZE) + "\n...[output truncated]";
        }

        return {
          success: true,
          output: output || "(no output)",
          toolId,
          duration,
          exitCode: 0,
        };
      }
    } catch (error) {
      // execAsync throws on non-zero exit code
      if (error.code && error.signal === null) {
        // Command failed with exit code
        return {
          success: false,
          error: `Command failed with exit code ${error.code}`,
          output: error.stderr || error.stdout || error.message,
          toolId,
          exitCode: error.code,
        };
      } else if (error.signal) {
        // Command killed by signal
        return {
          success: false,
          error: `Command killed by signal: ${error.signal}`,
          output: error.stderr || error.stdout || error.message,
          toolId,
          signal: error.signal,
        };
      } else {
        // Other error
        return {
          success: false,
          error: error.message,
          toolId,
        };
      }
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
          error: `${filePath} is a directory. Use list_directory to see its contents.`,
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

      // Ensure directory exists
      await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });

      // Write file
      await fsPromises.writeFile(resolvedPath, content, DEFAULT_ENCODING);

      // Invalidate cache — file content changed
      fileReadCache.invalidate(resolvedPath);

      // Record the change in change history
      try {
        const relativePath = path.relative(this.projectRoot, resolvedPath);
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
      const baseOutput = `File written successfully: ${filePath} (${stats.size} bytes)`;

      return {
        success: true,
        output: gate.summary ? baseOutput + gate.summary : baseOutput,
        toolId,
        metadata: {
          path: filePath,
          size: stats.size,
          violations: gate.violations.length > 0 ? gate.violations : undefined,
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

      // Replace
      const newContent = currentContent.replace(oldString, newString);
      await fsPromises.writeFile(resolvedPath, newContent, DEFAULT_ENCODING);

      // Invalidate cache — file content changed
      fileReadCache.invalidate(resolvedPath);

      // Record the change in change history
      try {
        const relativePath = path.relative(this.projectRoot, resolvedPath);
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
      const baseOutput = `File edited: ${filePath}\nNew size: ${stats.size} bytes`;

      return {
        success: true,
        output: gate.summary ? baseOutput + gate.summary : baseOutput,
        toolId,
        metadata: gate.violations.length > 0 ? { violations: gate.violations } : undefined,
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

      const includeRegex = includePattern 
        ? new RegExp(includePattern.replace(/\*/g, ".*").replace(/\?/g, "."))
        : null;

      const walk = async (dir) => {
        let files = [];
        try {
          const items = await fsPromises.readdir(dir, { withFileTypes: true });
          for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              if (![ "node_modules", ".git", ".next", ".nuxt", ".output", "dist", "build", "coverage", ".cache", ].includes(item.name)) {
                files = files.concat(await walk(fullPath));
              }
            } else {
              const ext = path.extname(item.name).toLowerCase();
              if (includeRegex) {
                if (includeRegex.test(item.name) || includeRegex.test(fullPath)) {
                  files.push(fullPath);
                }
              } else if (commonExtensions.includes(ext)) {
                files.push(fullPath);
              }
            }
          }
        } catch (error) {}
        return files;
      };

      const allFiles = await walk(resolvedSearchPath);
      const filesToSearch = allFiles.slice(0, 100);

      for (const file of filesToSearch) {
        try {
          const content = await fsPromises.readFile(file, DEFAULT_ENCODING);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              results.push({
                file: path.relative(this.projectRoot, file),
                line: i + 1,
                content: lines[i].trim(),
              });
              if (results.length >= 50) break;
            }
          }
          if (results.length >= 50) break;
        } catch (error) { continue; }
      }

      if (results.length === 0) {
        return { success: true, output: `No matches found for "${query}"`, toolId };
      }

      const output = results.map((r) => `${r.file}:${r.line}: ${r.content}`).join("\n");
      return { success: true, output: `Found ${results.length} match(es) for "${query}":\n\n${output}`, toolId };
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
  async executeWebFetch(toolId, prompt) {
    const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      return { success: false, output: "No URL found in the prompt.", toolId };
    }
    const url = urlMatch[0];
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        return { success: false, output: `Failed to fetch URL: ${response.status} ${response.statusText}`, toolId };
      }
      const text = await response.text();
      // Very basic HTML to text conversion
      const cleanText = text
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 15000); // Cap at 15k chars

      return { success: true, output: cleanText, toolId };
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
      const tavilyKey = settings.tavilyApiKey;

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
            return { success: true, output: `Search results for "${query}":\n\n${parts.join("\n\n")}`, toolId };
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

      return { success: true, output: `Search results for "${query}":\n\n${formatted}`, toolId };
    } catch (err) {
      return { success: false, error: `Search failed: ${err.message}`, toolId };
    }
  }

  /**
   * Resolve a file path relative to project root, with safety checks
   */
  resolveProjectPath(filePath) {
    if (!filePath || typeof filePath !== "string") {
      return null;
    }

    // Normalize path
    const normalized = path.normalize(filePath);

    // Check for path traversal attempts
    if (normalized.includes("..") || path.isAbsolute(normalized)) {
      // Only allow relative paths within project
      if (
        path.isAbsolute(normalized) &&
        !normalized.startsWith(this.projectRoot)
      ) {
        return null;
      }
    }

    // Resolve relative to project root
    const resolved = path.resolve(this.projectRoot, normalized);

    // Ensure the resolved path is within project root
    if (!resolved.startsWith(this.projectRoot)) {
      return null;
    }

    return resolved;
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

        case "list_directory":
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
          return await this.executeWebFetch(toolId, input.prompt);

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

        case "pane_recent_terminal": {
          const data = await readJson(path.join(stateDir, "terminal.json"));
          if (!data?.commands?.length) return { success: true, output: "No terminal history.", toolId };
          const cmds = data.commands.slice(-50);

          // Show tab labels when more than one source is present
          const sources = new Set(cmds.map(c => c.tabId || c.source || "terminal"));
          const needsLabels = sources.size > 1;

          const out = cmds.map(c => {
            // Tail of output — most useful for servers where latest lines matter most
            const raw = c.output || "(no output)";
            const output = raw.length > 1000 ? "...\n" + raw.slice(-1000) : raw;
            const runningMark = c.partial ? " (running)" : "";

            let prefix = "";
            if (needsLabels) {
              if (c.source === "claude" || c.tabId === "claude") {
                prefix = "[claude] ";
              } else if (c.tabTitle) {
                prefix = `[${c.tabTitle}] `;
              } else if (c.tabId) {
                prefix = "[terminal] ";
              }
            }

            return `${prefix}$ ${c.cmd}${runningMark}\n${output}`;
          }).join("\n\n");

          // Contextual augmentation: auto-attach referenced files from errors
          const lastOutput = cmds[cmds.length - 1]?.output || "";
          const augmentation = await augmentWithReferencedFiles(lastOutput, this.projectRoot);
          return { success: true, output: out + augmentation, toolId };
        }

        case "pane_run_in_terminal": {
          const command = (input?.command || "").trim();
          if (!command) return { success: false, error: "No command provided.", toolId };
          const result = await this.executeBash(toolId, command, false, null);
          // Append to terminal history so pane_recent_terminal and the UI reflect what Claude ran
          try {
            const termPath = path.join(stateDir, "terminal.json");
            let termData = null;
            try { termData = JSON.parse(await fsPromises.readFile(termPath, "utf-8")); } catch {}
            const commands = Array.isArray(termData?.commands) ? termData.commands : [];
            commands.push({
              cmd: command,
              output: result.output || result.error || "",
              timestamp: Date.now(),
              tabId: "claude",
              tabTitle: "claude",
              source: "claude",
            });
            await fsPromises.mkdir(stateDir, { recursive: true });
            await fsPromises.writeFile(termPath, JSON.stringify({ commands: commands.slice(-50) }));
          } catch {}

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
              }).filter(s => s.score > 0.15).sort((a, b) => b.score - a.score);

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
          const event = {
            type: input.type || "decision",
            content: input.content,
            timestamp: Date.now(),
            source: "http-backend",
          };
          await fsPromises.mkdir(memoryDir, { recursive: true });
          await fsPromises.appendFile(
            path.join(memoryDir, "events.jsonl"),
            JSON.stringify(event) + "\n",
          );
          return { success: true, output: `Saved to project memory: [${event.type}] ${event.content}`, toolId };
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
          const typeOrder = ["decision", "lesson", "pattern", "error_fix", "principle", "mind"];
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

        case "pane_synthesize": {
          // Read synthesis from contextual export (written by brain-engine)
          const contextPath = path.join(paneDir, "brain", "context", `${this.projectId}.json`);
          let ctx = null;
          try { ctx = JSON.parse(await fsPromises.readFile(contextPath, "utf-8")); } catch {}

          if (ctx?.synthesis) {
            return { success: true, output: `## Project DNA\n\n${ctx.synthesis}`, toolId };
          }

          // Fallback: check if brain export has enough nodes to build one
          const brainExportPath = path.join(paneDir, "brain", "exports", `${this.projectId}.json`);
          let exported = null;
          try { exported = JSON.parse(await fsPromises.readFile(brainExportPath, "utf-8")); } catch {}

          if (!exported || exported.length === 0) {
            return { success: true, output: "Project DNA not available yet — it builds as decisions and lessons accumulate through your work.", toolId };
          }

          const decisions = exported.filter(n => n.type === "decision" && (n.confidence || 0) >= 0.70).slice(0, 12);
          const patterns  = exported.filter(n => n.type === "pattern"  && (n.confidence || 0) >= 0.70).slice(0, 8);
          const lessons   = exported.filter(n => n.type === "lesson"   && (n.confidence || 0) >= 0.72).slice(0, 8);
          const fixes     = exported.filter(n => n.type === "error_fix"&& (n.confidence || 0) >= 0.70).slice(0, 6);

          if (decisions.length + patterns.length + lessons.length + fixes.length === 0) {
            return { success: true, output: "Project DNA not available yet — memory confidence is still building.", toolId };
          }

          const parts = ["## Project DNA\n"];
          if (decisions.length > 0) {
            parts.push("Architectural decisions:");
            for (const d of decisions) parts.push(`- ${d.content}`);
          }
          if (patterns.length > 0) {
            parts.push("\nEstablished patterns:");
            for (const p of patterns) parts.push(`- ${p.content}`);
          }
          if (lessons.length > 0) {
            parts.push("\nLessons learned:");
            for (const l of lessons) parts.push(`- ${l.content}`);
          }
          if (fixes.length > 0) {
            parts.push("\nKnown anti-patterns:");
            for (const f of fixes) parts.push(`- ${f.content}`);
          }

          return { success: true, output: parts.join("\n"), toolId };
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
          const name = input.name || "unknown";
          return { success: true, output: `Skill "${name}" activated. (Note: Skill instructions are normally injected into context; this is a mock confirmation.)`, toolId };
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

        case "codebase_investigator": {
          const objective = input.objective || "none";
          return { success: true, output: `Delegating investigation to codebase_investigator: ${objective}\n(Note: Sub-agent execution is simulated in this environment. Please use available tools like grep_search and read_file directly.)`, toolId };
        }

        case "generalist": {
          const request = input.request || "none";
          return { success: true, output: `Delegating to generalist: ${request}\n(Note: Sub-agent execution is simulated.)`, toolId };
        }

        case "cli_help": {
          const question = input.question || "";
          return { success: true, output: `Gemini CLI Help for: ${question}\n(Note: Help system is simulated. Refer to project documentation.)`, toolId };
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
            // Search for file by name
            const { execSync } = await import("node:child_process");
            try {
              const found = execSync(`find "${rootDir}/src" -name "${target}.*" -not -path "*/node_modules/*" 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
              if (found) primaryFile = found;
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
            if (componentKey.includes("terminal")) inferredCategories.add("terminal");

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
    for (const [toolId, process] of this.activeProcesses) {
      try { process.kill("SIGTERM"); } catch {}
    }
    this.activeProcesses.clear();
  }
}
