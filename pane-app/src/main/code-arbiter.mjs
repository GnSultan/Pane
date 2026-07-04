/**
 * Code Arbiter — Turn Sentinel
 *
 * After each LLM turn completes, independently verifies the work by running
 * real tools (tsc, eslint) on changed files. Produces a structured verdict
 * and persists unresolved findings so the context orchestrator can inject
 * them as CRITICAL priority into the next turn.
 *
 * The LLM cannot outrun its own mistakes — if it breaks types or introduces
 * lint errors, Pane catches them here and forces a correction cycle.
 *
 * Architecture:
 *   http-backend.mjs  →  runTurnSentinel(projectId, workingDir, changedFiles)
 *                              ↓
 *                        tsc --noEmit (incremental)
 *                        eslint on changed files
 *                              ↓
 *                        verdict written to ~/.pane/session/{projectId}/arbiter-verdict.json
 *                              ↓
 *   context-orchestrator.mjs reads verdict → injects as CRITICAL turn layer
 */

import { execThroughWorker } from "./tool-executor.mjs";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const SESSION_DIR = path.join(PANE_DIR, "session");

// Timeout for verification commands — incremental tsc is fast, but cold
// builds on large projects can take longer.
const TSC_TIMEOUT_MS = 15_000;
const ESLINT_TIMEOUT_MS = 10_000;

// ============================================================================
// TypeScript check
// ============================================================================

/**
 * Run tsc --noEmit on the project. Returns parsed diagnostics.
 *
 * @param {string} workingDir - Project root
 * @returns {Promise<Array<{file, line, code, message}>>}
 */
async function runTypeCheck(workingDir) {
  // Check if tsconfig exists — no config means no TypeScript project
  const tsconfigPath = path.join(workingDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return [];

  try {
    // Run through cmd-worker utility process so the main event loop isn't
    // blocked for the duration of the tsc build (2-15s on large projects).
    const result = await execThroughWorker(
      "npx tsc --noEmit --incremental --pretty false 2>&1",
      {
        cwd: workingDir,
        timeout: Math.ceil(TSC_TIMEOUT_MS / 1000),
        env: { FORCE_COLOR: "0" },
      },
    );
    // Exit 0 — no errors
    if (result.success) return [];
    // Non-zero exit — tsc found errors. Diagnostics are in stdout.
    const output = result.stdout || "";
    if (!output) return [];

    return parseTscOutput(output, workingDir);
  } catch (err) {
    // Network error or worker crash (not a tsc diagnostic)
    console.warn(`[arbiter] Type check worker error: ${err.message}`);
    return [];
  }
}

/**
 * Parse tsc --pretty false output into structured diagnostics.
 * Format: path(line,col): error TSxxxx: message
 */
function parseTscOutput(output) {
  const diagnostics = [];
  const lines = output.split("\n");
  // Match: src/foo.ts(42,5): error TS2345: Argument of type...
  const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;

  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;

    const [, filePath, lineNum, , severity, code, message] = m;
    diagnostics.push({
      file: filePath,
      line: parseInt(lineNum, 10),
      code,
      severity,
      message: message.trim(),
    });
  }

  return diagnostics;
}

// ============================================================================
// ESLint check
// ============================================================================

/**
 * Run eslint on specific files. Returns parsed diagnostics.
 *
 * @param {string} workingDir - Project root
 * @param {string[]} files - Relative file paths to lint
 * @returns {Promise<Array<{file, line, code, message, severity}>>}
 */
async function runEslint(workingDir, files) {
  if (files.length === 0) return [];

  // Check if eslint config exists
  const hasEslint = [
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
    ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", ".eslintrc",
  ].some(f => fs.existsSync(path.join(workingDir, f)));

  if (!hasEslint) return [];

  // Only lint files that exist and are JS/TS
  const lintable = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  });
  if (lintable.length === 0) return [];

  // Cap at 20 files to avoid long runtimes
  const filesToLint = lintable.slice(0, 20);

  try {
    const fileArgs = filesToLint.map(f => `"${f}"`).join(" ");
    const result = await execThroughWorker(
      `npx eslint --format json --no-warn-ignored ${fileArgs} 2>/dev/null`,
      {
        cwd: workingDir,
        timeout: Math.ceil(ESLINT_TIMEOUT_MS / 1000),
        env: { FORCE_COLOR: "0" },
      },
    );
    // Exit 0 — no errors
    if (result.success) return [];
    // Non-zero exit — eslint found errors. JSON output is in stdout.
    const output = result.stdout || "";
    if (!output) return [];

    return parseEslintJson(output, workingDir);
  } catch (err) {
    // Network error or worker crash (not eslint diagnostics)
    console.warn(`[arbiter] ESLint worker error: ${err.message}`);
    return [];
  }
}

/**
 * Parse eslint --format json output.
 */
function parseEslintJson(output, workingDir) {
  const diagnostics = [];

  try {
    const results = JSON.parse(output);
    for (const result of results) {
      const relPath = path.relative(workingDir, result.filePath);
      for (const msg of result.messages) {
        // severity: 1 = warning, 2 = error
        diagnostics.push({
          file: relPath,
          line: msg.line || 0,
          code: msg.ruleId || "unknown",
          severity: msg.severity === 2 ? "error" : "warning",
          message: msg.message,
        });
      }
    }
  } catch {
    // JSON parse failed — eslint output was not valid JSON (maybe a crash message)
  }

  return diagnostics;
}

// ============================================================================
// Plain-language translator
// ============================================================================

/**
 * Translate a technical diagnostic into plain language.
 * Non-coders should understand what's wrong without knowing TypeScript.
 */
function translateDiagnostic(d) {
  // Common TypeScript errors with human-readable translations
  const tsTranslations = {
    TS2345: `The function "${extractFunctionContext(d.message)}" is receiving the wrong type of data. ${d.message}`,
    TS2304: `The code references "${extractName(d.message)}" but it doesn't exist. It may be misspelled or not imported.`,
    TS2305: `The code tries to import "${extractName(d.message)}" but it's not exported from that file.`,
    TS2307: `The code imports from a file or package that can't be found: ${extractName(d.message)}.`,
    TS2322: `A value is being assigned to something that expects a different type. ${d.message}`,
    TS2339: `The code tries to use a property or method that doesn't exist on this object.`,
    TS2349: `The code tries to call something that isn't a function.`,
    TS2551: `"${extractName(d.message)}" doesn't exist — did you mean a similar name? ${d.message}`,
    TS2554: `A function is being called with the wrong number of arguments.`,
    TS2555: `A function is being called with the wrong number of arguments.`,
    TS2741: `A required property is missing from an object.`,
    TS7006: `A function parameter has no type annotation. TypeScript doesn't know what type of data it will receive.`,
    TS18046: `A value might be undefined (null) and the code doesn't handle that case. This could crash at runtime.`,
    TS18047: `A value might be null and the code doesn't handle that case. This could crash at runtime.`,
    TS18048: `A value might be undefined and the code doesn't handle that case. This could crash at runtime.`,
  };

  if (d.code && tsTranslations[d.code]) {
    return tsTranslations[d.code];
  }

  // For ESLint rules, provide context
  if (d.code && !d.code.startsWith("TS")) {
    return `Lint rule "${d.code}": ${d.message}`;
  }

  // Fallback: use the raw message
  return d.message;
}

function extractFunctionContext(msg) {
  const m = msg.match(/parameter '(\w+)'/);
  return m ? m[1] : "this function";
}

function extractName(msg) {
  const m = msg.match(/'([^']+)'/);
  return m ? m[1] : "unknown";
}

// ============================================================================
// Verdict generation
// ============================================================================

/**
 * @typedef {Object} ArbiterVerdict
 * @property {boolean} pass - Overall pass/fail
 * @property {number} score - 0-100 quality score
 * @property {Array} typeErrors - TypeScript diagnostics
 * @property {Array} lintErrors - ESLint diagnostics
 * @property {Array} findings - All findings with plain-language translations
 * @property {string[]} changedFiles - Files that were modified
 * @property {number} timestamp
 */

/**
 * Normalize a file path to project-relative form regardless of input format.
 */
function toProjectRelative(filePath, workingDir) {
  if (!filePath) return filePath;
  if (!path.isAbsolute(filePath)) return filePath.replace(/^\.?\//, "");
  if (workingDir && filePath.startsWith(workingDir)) {
    return filePath.slice(workingDir.length).replace(/^\//, "");
  }
  return filePath;
}

/**
 * Build a verdict from raw diagnostics, filtered to only show issues
 * in files that were changed this turn.
 *
 * @param {Array} tscDiags - Raw tsc diagnostics
 * @param {Array} eslintDiags - Raw eslint diagnostics
 * @param {string[]} changedFiles - Files modified this turn
 * @param {string} workingDir - Project root
 * @returns {ArbiterVerdict}
 */
function buildVerdict(tscDiags, eslintDiags, changedFiles, workingDir) {
  const changedSet = new Set(changedFiles.map(f => toProjectRelative(f, workingDir)));

  // Filter diagnostics to only changed files — the LLM is not responsible
  // for pre-existing errors in files it didn't touch.
  const relevantTsc = tscDiags.filter(d => changedSet.has(d.file));
  const relevantLint = eslintDiags.filter(d => changedSet.has(d.file));

  const tscErrors = relevantTsc.filter(d => d.severity === "error");
  const lintErrors = relevantLint.filter(d => d.severity === "error");
  const lintWarnings = relevantLint.filter(d => d.severity === "warning");

  // Build findings with translations
  const findings = [];

  for (const d of tscErrors) {
    findings.push({
      source: "typescript",
      severity: "error",
      file: d.file,
      line: d.line,
      code: d.code,
      raw: d.message,
      plain: translateDiagnostic(d),
    });
  }

  for (const d of lintErrors) {
    findings.push({
      source: "eslint",
      severity: "error",
      file: d.file,
      line: d.line,
      code: d.code,
      raw: d.message,
      plain: translateDiagnostic(d),
    });
  }

  // Include lint warnings but cap at 5 to avoid noise
  for (const d of lintWarnings.slice(0, 5)) {
    findings.push({
      source: "eslint",
      severity: "warning",
      file: d.file,
      line: d.line,
      code: d.code,
      raw: d.message,
      plain: translateDiagnostic(d),
    });
  }

  // Score: start at 100, deduct for issues
  let score = 100;
  score -= tscErrors.length * 15;       // Type errors are serious
  score -= lintErrors.length * 10;      // Lint errors are moderate
  score -= lintWarnings.length * 3;     // Lint warnings are minor
  score = Math.max(0, Math.min(100, score));

  const pass = tscErrors.length === 0 && lintErrors.length === 0;

  return {
    pass,
    score,
    typeErrors: relevantTsc,
    lintErrors: relevantLint,
    findings,
    changedFiles,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Architecture Sentinel — structural integrity via symbol index
// ============================================================================
// Uses the file_relationships table (import edges) from symbol-index to detect:
//   1. Broken imports: a file imports from another, but the exported symbol no longer exists
//   2. New circular dependencies: A→B→C→A introduced by this change
//   3. Orphaned exports: exports removed that other files depend on

/**
 * Detect circular dependencies in the import graph.
 * Only reports cycles that involve at least one changed file.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string[]} changedFiles
 * @returns {Array<{cycle: string[], plain: string}>}
 */
function detectCircularDeps(db, projectId, changedFiles) {
  const changedSet = new Set(changedFiles);

  // Build adjacency list from file_relationships
  const edges = new Map(); // source → Set<target>
  try {
    const rows = db.prepare(
      `SELECT source_file, target_file FROM file_relationships WHERE project_id = ? AND type = 'import'`
    ).all(projectId);

    for (const { source_file, target_file } of rows) {
      if (!edges.has(source_file)) edges.set(source_file, new Set());
      edges.get(source_file).add(target_file);
    }
  } catch {
    return [];
  }

  // DFS cycle detection — only start from changed files
  const cycles = [];
  const globalVisited = new Set();

  for (const startFile of changedFiles) {
    if (!edges.has(startFile)) continue;

    const stack = [startFile];
    const path = [];
    const inPath = new Set();

    while (stack.length > 0) {
      const node = stack[stack.length - 1];

      if (!inPath.has(node)) {
        inPath.add(node);
        path.push(node);

        const neighbors = edges.get(node);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (inPath.has(neighbor)) {
              // Found a cycle — extract it
              const cycleStart = path.indexOf(neighbor);
              const cycle = path.slice(cycleStart);
              cycle.push(neighbor); // close the loop

              // Only report if involves a changed file and not already reported
              const key = [...cycle].sort().join("→");
              if (!globalVisited.has(key) && cycle.some(f => changedSet.has(f))) {
                globalVisited.add(key);
                const shortCycle = cycle.map(f => f.split("/").slice(-2).join("/"));
                cycles.push({
                  cycle,
                  plain: `Circular dependency: ${shortCycle.join(" → ")}. These files import each other in a loop, which can cause initialization errors and makes the code harder to maintain.`,
                });
              }
            } else if (!globalVisited.has(node + "→" + neighbor)) {
              stack.push(neighbor);
            }
          }
        }
      }

      if (stack[stack.length - 1] === node) {
        stack.pop();
        inPath.delete(node);
        path.pop();
      }
    }
  }

  return cycles.slice(0, 3); // Cap at 3 to avoid noise
}

/**
 * Check for broken imports — files that import symbols no longer exported
 * by the changed files.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} projectId
 * @param {string[]} changedFiles
 * @param {string} workingDir
 * @returns {Array<{file: string, importedFrom: string, plain: string}>}
 */
function detectBrokenImports(db, projectId, changedFiles, workingDir) {
  const broken = [];

  for (const changedFile of changedFiles) {
    // Find all files that import from this changed file
    let dependents;
    try {
      dependents = db.prepare(
        `SELECT source_file FROM file_relationships WHERE project_id = ? AND target_file = ? AND type = 'import'`
      ).all(projectId, changedFile);
    } catch {
      continue;
    }

    if (dependents.length === 0) continue;

    // Get current exports of the changed file
    let currentExports;
    try {
      currentExports = db.prepare(
        `SELECT name FROM symbols WHERE project_id = ? AND file_path = ?`
      ).all(projectId, changedFile);
    } catch {
      continue;
    }

    const exportedNames = new Set(currentExports.map(s => s.name));

    // For each dependent file, check if its imports still resolve
    for (const { source_file } of dependents) {
      try {
        const sourceContent = fs.readFileSync(path.join(workingDir, source_file), "utf-8");
        // Extract named imports from the changed file
        // Match: import { foo, bar } from './changedFile'
        const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm;
        for (const match of sourceContent.matchAll(importRe)) {
          const importPath = match[2]; // the resolved import path
          // Check if this import references the changed file
          const changedBasename = path.basename(changedFile).replace(/\.[^.]+$/, "");
          if (!importPath.includes(changedBasename)) continue;

          const names = match[1].split(",").map(n => {
            const parts = n.trim().split(/\s+as\s+/);
            return parts[0].trim();
          }).filter(Boolean);

          for (const name of names) {
            if (name && !exportedNames.has(name)) {
              broken.push({
                file: source_file,
                importedFrom: changedFile,
                symbol: name,
                plain: `"${source_file}" imports "${name}" from "${changedFile}", but "${name}" is no longer exported. This will cause a build error.`,
              });
            }
          }
        }
      } catch {
        // File read failed — skip
      }
    }
  }

  return broken.slice(0, 5);
}

/**
 * Run architecture checks using the symbol index database.
 *
 * @param {string} projectId
 * @param {string} workingDir
 * @param {string[]} changedFiles
 * @returns {Array<{id: string, severity: string, plain: string, file?: string, line?: number}>}
 */
/**
 * @param {string} projectId
 * @param {string} workingDir
 * @param {string[]} changedFiles
 * @param {import('better-sqlite3').Database} [db] - Optional pane DB instance
 */
export function runArchitectureSentinel(projectId, workingDir, changedFiles, db) {
  if (!changedFiles || changedFiles.length < 2) return [];
  if (!db) return [];

  const findings = [];

  // 1. Circular dependency detection
  const cycles = detectCircularDeps(db, projectId, changedFiles);
  for (const c of cycles) {
    findings.push({
      id: "circular-dep",
      severity: "warning",
      file: c.cycle[0],
      plain: c.plain,
    });
  }

  // 2. Broken import detection
  const broken = detectBrokenImports(db, projectId, changedFiles, workingDir);
  for (const b of broken) {
    findings.push({
      id: "broken-import",
      severity: "error",
      file: b.file,
      plain: b.plain,
    });
  }

  return findings;
}

// ============================================================================
// Turn Sentinel — the main entry point
// ============================================================================

/**
 * Run the Turn Sentinel after an LLM turn completes.
 *
 * @param {string} projectId
 * @param {string} workingDir - Project root
 * @param {string[]} changedFiles - Relative paths of files modified this turn
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db] - Pane DB for architecture checks
 * @returns {Promise<ArbiterVerdict>}
 */
export async function runTurnSentinel(projectId, workingDir, changedFiles, options = {}) {
  if (!changedFiles || changedFiles.length === 0) {
    return { pass: true, score: 100, typeErrors: [], lintErrors: [], findings: [], changedFiles: [], timestamp: Date.now() };
  }

  // Load baseline (captured on first sentinel run of this session)
  const baselinePath = path.join(SESSION_DIR, projectId, "arbiter-baseline.json");
  let baseline = [];
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
  } catch {}

  // Run tsc and eslint in parallel
  const [tscDiags, eslintDiags] = await Promise.all([
    runTypeCheck(workingDir).catch(err => {
      console.warn(`[arbiter] tsc failed: ${err.message}`);
      return [];
    }),
    runEslint(workingDir, changedFiles).catch(err => {
      console.warn(`[arbiter] eslint failed: ${err.message}`);
      return [];
    }),
  ]);

  // Filter out pre-existing errors from baseline
  const baselineKeys = new Set(baseline.map(d => `${d.file}:${d.line}:${d.code}`));
  const newTscDiags = tscDiags.filter(d => !baselineKeys.has(`${d.file}:${d.line}:${d.code}`));

  // If no baseline yet, write one now and use all diags (first run)
  if (baseline.length === 0 && tscDiags.length > 0) {
    await fsPromises.writeFile(baselinePath, JSON.stringify(tscDiags), "utf-8");
  }

  // Architecture sentinel: circular deps + broken imports (sync, <50ms)
  let archFindings = [];
  try {
    // Wait briefly for the async symbol indexer to process the new files
    await new Promise(r => setTimeout(r, 500));
    archFindings = runArchitectureSentinel(projectId, workingDir, changedFiles, options.db);
  } catch (err) {
    console.warn(`[arbiter] Architecture sentinel failed: ${err.message}`);
  }

  // Proactive guidance: senior-dev suggestions (sync, <100ms)
  let guidance = [];
  try {
    guidance = runProactiveGuidance(workingDir, changedFiles);
  } catch (err) {
    console.warn(`[arbiter] Proactive guidance failed: ${err.message}`);
  }

  const verdict = buildVerdict(newTscDiags, eslintDiags, changedFiles, workingDir);

  // Merge architecture findings into verdict
  for (const af of archFindings) {
    verdict.findings.push({
      source: "architecture",
      severity: af.severity,
      file: af.file || "",
      line: 0,
      code: af.id,
      raw: af.plain,
      plain: af.plain,
    });
    if (af.severity === "error") verdict.pass = false;
    verdict.score = Math.max(0, verdict.score - (af.severity === "error" ? 15 : 5));
  }

  // Attach guidance as suggestions (don't affect pass/fail or score)
  if (guidance.length > 0) {
    verdict.guidance = guidance;
  }

  // Persist verdict for context-orchestrator to read on next turn
  try {
    const sessionDir = path.join(SESSION_DIR, projectId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "arbiter-verdict.json"),
      JSON.stringify(verdict, null, 2),
      "utf-8",
    );
    if (verdict.pass) {
      // Explicitly clear so stale failing verdicts don't re-inject on read-only turns
      try { await fsPromises.unlink(path.join(sessionDir, "arbiter-verdict.json")); } catch {}
    }
  } catch (err) {
    console.warn(`[arbiter] Failed to persist verdict: ${err.message}`);
  }

  return verdict;
}

/**
 * Clear the arbiter verdict (called when findings are resolved).
 */
export async function clearVerdict(projectId) {
  try {
    await fsPromises.unlink(path.join(SESSION_DIR, projectId, "arbiter-verdict.json"));
  } catch {}
}

/**
 * Read the current verdict (used by context-orchestrator).
 *
 * @param {string} projectId
 * @returns {ArbiterVerdict|null}
 */
export function readVerdict(projectId) {
  try {
    const raw = fs.readFileSync(
      path.join(SESSION_DIR, projectId, "arbiter-verdict.json"),
      "utf-8",
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Format the verdict as a context layer string for injection into the
 * LLM's system prompt. Only includes actionable findings.
 *
 * @param {ArbiterVerdict} verdict
 * @returns {string|null} - Formatted string, or null if no findings
 */
export function formatVerdictForContext(verdict) {
  if (!verdict || verdict.pass || verdict.findings.length === 0) return null;
  // Don't inject a verdict older than 10 minutes — it's stale.
  // Errors that old have either been fixed or are pre-existing noise.
  const ageMs = Date.now() - (verdict.timestamp || 0);
  if (ageMs > 10 * 60 * 1000) return null;

  const lines = [
    "⚠ ARBITER — Pane independently verified your last changes and found problems:",
    "",
  ];

  const errors = verdict.findings.filter(f => f.severity === "error");
  const warnings = verdict.findings.filter(f => f.severity === "warning");

  if (errors.length > 0) {
    lines.push("ERRORS (must fix before proceeding):");
    for (const f of errors) {
      lines.push(`  ${f.file}:${f.line} [${f.code}] — ${f.raw}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("WARNINGS:");
    for (const f of warnings.slice(0, 5)) {
      lines.push(`  ${f.file}:${f.line} [${f.code}] — ${f.raw}`);
    }
    lines.push("");
  }

  lines.push("Fix these issues before taking on new work. Do NOT suppress errors with @ts-ignore or eslint-disable.");

  return lines.join("\n");
}

// ============================================================================
// Behavioral Fingerprinting — track quality metrics per model/project
// ============================================================================
// Records per-turn quality data to SQLite. Aggregate stats surface in the
// system prompt when concerning, and feed into the routing oracle to penalize
// models with high failure rates.

/**
 * Record a quality metric for this turn.
 *
 * @param {object} db - Pane SQLite database (from getPaneDb())
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} [params.model]
 * @param {string} [params.provider]
 * @param {ArbiterVerdict} params.verdict
 * @param {boolean} [params.selfCorrected] - Did the LLM fix issues when told? (null = no previous issues)
 */
export function recordQualityMetric(db, { projectId, model, provider, verdict, selfCorrected }) {
  if (!db?.stmts?.insertQualityMetric) return;

  const id = `qm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const suppressions = verdict.findings.filter(f =>
    f.code === "ts-nocheck" || f.code === "ts-ignore" || f.code === "eslint-disable-file" || f.code === "eslint-disable-line"
  ).length;
  const archIssues = verdict.findings.filter(f => f.source === "architecture").length;

  try {
    db.stmts.insertQualityMetric.run(
      id,
      projectId,
      model || null,
      provider || null,
      verdict.pass ? 1 : 0,
      verdict.score,
      verdict.typeErrors?.length || 0,
      verdict.lintErrors?.length || 0,
      suppressions,
      selfCorrected === undefined ? null : selfCorrected ? 1 : 0,
      verdict.changedFiles?.length || 0,
      archIssues,
      Date.now(),
    );
  } catch (err) {
    console.warn(`[arbiter] Failed to record quality metric: ${err.message}`);
  }
}

/**
 * Get aggregate quality stats for a project over a time window.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {number} [windowMs=86400000] - Time window (default 24 hours)
 * @returns {{ totalTurns, failedTurns, avgScore, suppressionRate, correctionRate, totalTypeErrors } | null}
 */
export function getQualityStats(db, projectId, windowMs = 24 * 60 * 60 * 1000) {
  if (!db?.stmts?.getQualityStats) return null;

  try {
    const since = Date.now() - windowMs;
    const row = db.stmts.getQualityStats.get(projectId, since);
    if (!row || row.total_turns === 0) return null;

    return {
      totalTurns: row.total_turns,
      failedTurns: row.failed_turns,
      avgScore: Math.round(row.avg_score),
      totalTypeErrors: row.total_type_errors,
      totalLintErrors: row.total_lint_errors,
      totalSuppressions: row.total_suppressions,
      correctionRate: (row.corrections + row.uncorrected) > 0
        ? Math.round((row.corrections / (row.corrections + row.uncorrected)) * 100)
        : null,
      totalArchIssues: row.total_arch_issues,
    };
  } catch {
    return null;
  }
}

/**
 * Get per-model quality breakdown for routing decisions.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {number} [windowMs=604800000] - Time window (default 7 days)
 * @returns {Array<{ model, totalTurns, avgScore, totalSuppressions, correctionRate }>}
 */
export function getModelQualityStats(db, projectId, windowMs = 7 * 24 * 60 * 60 * 1000) {
  if (!db?.stmts?.getModelQualityStats) return [];

  try {
    const since = Date.now() - windowMs;
    return db.stmts.getModelQualityStats.all(projectId, since).map(row => ({
      model: row.model,
      totalTurns: row.total_turns,
      avgScore: Math.round(row.avg_score),
      totalSuppressions: row.total_suppressions,
      correctionRate: (row.corrections + row.uncorrected) > 0
        ? Math.round((row.corrections / (row.corrections + row.uncorrected)) * 100)
        : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Format quality stats as a system prompt injection.
 * Only fires when metrics are concerning — otherwise returns null.
 *
 * @param {object} db
 * @param {string} projectId
 * @returns {string|null}
 */
export function formatQualityStatsForContext(db, projectId) {
  const stats = getQualityStats(db, projectId);
  if (!stats || stats.totalTurns < 5) return null; // Not enough data

  const lines = [];

  // Only inject when quality is concerning
  if (stats.avgScore >= 85 && stats.totalSuppressions === 0) return null;

  lines.push("⚠ QUALITY TREND — Pane is tracking your code quality:");

  if (stats.avgScore < 70) {
    lines.push(`  Quality score has averaged ${stats.avgScore}/100 over the last ${stats.totalTurns} turns. This is below acceptable.`);
  }

  if (stats.totalSuppressions > 0) {
    lines.push(`  ${stats.totalSuppressions} error suppression(s) detected across ${stats.totalTurns} turns. Fix root causes instead of suppressing.`);
  }

  if (stats.failedTurns > stats.totalTurns * 0.4) {
    lines.push(`  ${stats.failedTurns}/${stats.totalTurns} turns had verification failures. Slow down and verify your work.`);
  }

  if (stats.correctionRate !== null && stats.correctionRate < 60) {
    lines.push(`  Self-correction rate is ${stats.correctionRate}%. When Pane flags issues, fix them properly.`);
  }

  if (lines.length === 1) return null; // Only the header, no actual warnings
  return lines.join("\n");
}

// ============================================================================
// Deep Review — LLM-powered second opinion on accumulated changes
// ============================================================================
// Uses a separate LLM call with a review-specific prompt. NOT the same context
// that wrote the code — fresh eyes. Triggered on milestones or repeated failures.

const DEEP_REVIEW_SYSTEM = `You are a senior code reviewer performing an independent quality assessment.

Your job is to find issues the original developer missed. Be specific and actionable.

Focus on:
1. Logic errors and edge cases that will cause bugs
2. Security vulnerabilities (injection, auth bypass, data exposure)
3. Missing error handling on system boundaries (network, filesystem, user input)
4. Architectural problems (wrong abstraction level, tight coupling, layer violations)
5. Whether the changes actually fulfill the stated intent

Do NOT flag:
- Style preferences or formatting
- Minor naming choices
- Missing comments or documentation
- Things that are clearly intentional design decisions

Format your response as:
CRITICAL: [issues that will cause failures or security problems]
CONCERNS: [issues that should be addressed but aren't urgent]
SUGGESTIONS: [improvements worth considering]
ASSESSMENT: [1-2 sentence overall verdict]

If the code is solid, say so briefly. Don't manufacture issues.`;

/**
 * Run a Deep Review on accumulated changes.
 *
 * @param {object} options
 * @param {string} options.diff - The cumulative diff to review
 * @param {string} options.intent - What the user originally asked for
 * @param {string} [options.projectBrief] - Project brief for architectural context
 * @param {string} [options.projectRules] - Project rules/principles
 * @param {(sys: string, usr: string) => Promise<string>} options.callFn - LLM call function
 * @returns {Promise<{ review: string, findings: Array<{severity, text}> } | null>}
 */
export async function runDeepReview({ diff, intent, projectBrief, projectRules, callFn }) {
  if (!diff || !callFn) return null;

  // Cap diff to avoid blowing context
  const maxDiffChars = 12_000;
  const trimmedDiff = diff.length > maxDiffChars
    ? diff.slice(0, maxDiffChars) + `\n\n... [diff truncated, ${diff.length - maxDiffChars} chars omitted]`
    : diff;

  const userParts = [];
  if (intent) userParts.push(`## What was requested\n${intent}`);
  if (projectBrief) userParts.push(`## Project context\n${projectBrief.slice(0, 1000)}`);
  if (projectRules) userParts.push(`## Project rules\n${projectRules.slice(0, 500)}`);
  userParts.push(`## Changes to review\n\`\`\`diff\n${trimmedDiff}\n\`\`\``);

  try {
    const response = await callFn(DEEP_REVIEW_SYSTEM, userParts.join("\n\n"));
    if (!response) return null;

    // Parse structured findings from response
    const findings = [];
    const sections = { CRITICAL: "error", CONCERNS: "warning", SUGGESTIONS: "info" };

    for (const [header, severity] of Object.entries(sections)) {
      const re = new RegExp(`${header}:\\s*(.+?)(?=(?:CRITICAL|CONCERNS|SUGGESTIONS|ASSESSMENT):|$)`, "s");
      const match = response.match(re);
      if (match) {
        const items = match[1].trim().split(/\n[-•*]\s*/);
        for (const item of items) {
          const text = item.trim();
          if (text && text.length > 5 && !text.toLowerCase().includes("none") && !text.toLowerCase().includes("no issues")) {
            findings.push({ severity, text });
          }
        }
      }
    }

    // Extract assessment
    const assessmentMatch = response.match(/ASSESSMENT:\s*(.+?)$/s);
    const assessment = assessmentMatch ? assessmentMatch[1].trim() : "";

    return {
      review: response,
      assessment,
      findings,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.warn(`[arbiter] Deep review failed: ${err.message}`);
    return null;
  }
}

/**
 * Persist a deep review result.
 */
export async function saveDeepReview(projectId, review) {
  try {
    const sessionDir = path.join(SESSION_DIR, projectId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(sessionDir, "deep-review.json"),
      JSON.stringify(review, null, 2),
      "utf-8",
    );
  } catch {}
}

/**
 * Read the last deep review.
 */
export function readDeepReview(projectId) {
  try {
    const raw = fs.readFileSync(path.join(SESSION_DIR, projectId, "deep-review.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================================================
// Proactive Guidance — what a senior developer would notice
// ============================================================================
// Scans changed files and the project structure for patterns that indicate
// missing best practices. These are not errors — the code works fine. But a
// senior developer would flag them: missing tests for critical code, no input
// validation on API handlers, growing file complexity, etc.
//
// Guidance is surfaced as suggestions, not mandates. Non-coders see:
// "Your payment flow has no tests. This is high-risk code — consider adding tests."

/**
 * Patterns that a senior developer would flag on changed files.
 * Each pattern scans the file content and returns a suggestion or null.
 */
const GUIDANCE_PATTERNS = [
  {
    id: "no-tests-for-critical",
    scan(content, filePath, projectRoot) {
      // Files that handle auth, payment, security, or data mutations
      // without corresponding test files
      const criticalPatterns = /\b(password|auth|login|payment|checkout|stripe|credit.?card|encrypt|decrypt|token|session|permission|role|admin)\b/i;
      if (!criticalPatterns.test(content)) return null;
      if (/\.(test|spec)\./i.test(filePath)) return null; // Already a test file

      // Check if a test file exists
      const base = path.basename(filePath).replace(/\.[^.]+$/, "");
      const dir = path.dirname(filePath);
      const testPatterns = [
        path.join(projectRoot, dir, `${base}.test.ts`),
        path.join(projectRoot, dir, `${base}.test.tsx`),
        path.join(projectRoot, dir, `${base}.spec.ts`),
        path.join(projectRoot, dir, `__tests__`, `${base}.test.ts`),
        path.join(projectRoot, "test", dir, `${base}.test.ts`),
        path.join(projectRoot, "tests", dir, `${base}.test.ts`),
      ];

      const hasTest = testPatterns.some(p => fs.existsSync(p));
      if (hasTest) return null;

      return {
        plain: `"${filePath}" handles security-critical logic (auth, payments, or encryption) but has no test file. A senior developer would require tests for this code before shipping.`,
      };
    },
  },
  {
    id: "no-input-validation",
    scan(content, filePath) {
      // API route handlers without input validation
      const isHandler = /\b(app\.(get|post|put|patch|delete)|router\.(get|post|put|patch|delete)|export\s+(default\s+)?async\s+function\s+(GET|POST|PUT|PATCH|DELETE))\b/.test(content);
      if (!isHandler) return null;

      // Check for validation patterns
      const hasValidation = /\b(zod|yup|joi|validate|schema\.parse|safeParse|z\.\w+|Joi\.\w+|body\(\)|param\(\)|query\(\))\b/.test(content);
      if (hasValidation) return null;

      return {
        plain: `"${filePath}" defines API endpoints but doesn't appear to validate user input. Without validation, unexpected data can cause crashes or security vulnerabilities.`,
      };
    },
  },
  {
    id: "large-file",
    scan(content, filePath) {
      const lines = content.split("\n").length;
      if (lines < 400) return null;
      if (/\.(test|spec|config|generated)\./i.test(filePath)) return null;

      return {
        plain: `"${filePath}" is ${lines} lines long. Large files become difficult to maintain and understand. Consider splitting it into focused modules.`,
      };
    },
  },
  {
    id: "no-error-boundary",
    scan(content, filePath) {
      // React components making fetch/API calls without error handling
      if (!/\.(tsx|jsx)$/.test(filePath)) return null;

      const hasFetch = /\b(fetch|axios|useSWR|useQuery|\.get\(|\.post\()\b/.test(content);
      if (!hasFetch) return null;

      const hasErrorHandling = /\b(catch|onError|error\s*[=:]|ErrorBoundary|fallback|isError|error\s*&&)\b/.test(content);
      if (hasErrorHandling) return null;

      return {
        plain: `"${filePath}" makes network requests but doesn't handle errors. If the network fails or the API returns an error, the user will see a broken page instead of a helpful message.`,
      };
    },
  },
  {
    id: "hardcoded-secrets",
    scan(content, filePath) {
      if (/\.(test|spec|example|sample)\./i.test(filePath)) return null;

      // Look for patterns that suggest hardcoded secrets
      const secretPatterns = /\b(api[_-]?key|secret[_-]?key|password|token)\s*[:=]\s*["'][^"']{8,}/i;
      if (!secretPatterns.test(content)) return null;

      // Exclude obvious placeholders
      if (/\b(YOUR_|REPLACE_|xxx|placeholder|example|test|dummy)\b/i.test(content)) return null;

      return {
        plain: `"${filePath}" appears to contain hardcoded credentials or API keys. These should be stored in environment variables, not in source code. If committed, they could be exposed publicly.`,
      };
    },
  },
  {
    id: "no-rate-limiting",
    scan(content, filePath) {
      // Auth-related endpoints without rate limiting
      const isAuth = /\b(login|sign.?in|register|sign.?up|forgot.?password|reset.?password|verify.?email)\b/i.test(content);
      if (!isAuth) return null;

      const isHandler = /\b(app\.(post|put)|router\.(post|put)|export\s+(default\s+)?async\s+function\s+(POST|PUT))\b/.test(content);
      if (!isHandler) return null;

      const hasRateLimit = /\b(rateLimit|rate.?limit|throttle|limiter|express.?rate|slowDown)\b/i.test(content);
      if (hasRateLimit) return null;

      return {
        plain: `"${filePath}" handles authentication but doesn't appear to have rate limiting. Without it, attackers can try thousands of passwords per second through brute-force attacks.`,
      };
    },
  },
];

/**
 * Run proactive guidance scans on changed files.
 *
 * @param {string} workingDir - Project root
 * @param {string[]} changedFiles - Relative paths of modified files
 * @returns {Array<{id: string, file: string, plain: string}>}
 */
export function runProactiveGuidance(workingDir, changedFiles) {
  if (!changedFiles || changedFiles.length === 0) return [];

  const suggestions = [];

  for (const filePath of changedFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) continue;

    let content;
    try {
      const resolved = path.resolve(workingDir, filePath);
      content = fs.readFileSync(resolved, "utf-8");
    } catch {
      continue;
    }

    for (const pattern of GUIDANCE_PATTERNS) {
      const result = pattern.scan(content, filePath, workingDir);
      if (result) {
        suggestions.push({
          id: pattern.id,
          file: filePath,
          plain: result.plain,
        });
      }
    }
  }

  // Deduplicate by id (e.g., multiple files with no tests → one suggestion per pattern)
  const seen = new Set();
  return suggestions.filter(s => {
    const key = `${s.id}:${s.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5); // Cap at 5 suggestions to avoid noise
}

/**
 * Format proactive guidance for the system prompt context.
 * Injected at USEFUL priority — suggestions, not mandates.
 */
export function formatGuidanceForContext(suggestions) {
  if (!suggestions || suggestions.length === 0) return null;

  const lines = [
    "PROACTIVE GUIDANCE — Pane noticed areas where a senior developer would suggest improvements:",
    "",
  ];

  for (const s of suggestions) {
    lines.push(`  - ${s.plain}`);
  }

  lines.push("");
  lines.push("These are suggestions, not errors. Address them when appropriate, or explain why they don't apply.");

  return lines.join("\n");
}

// ============================================================================
// Verdict as follow-up prompt — for CLI backends where Pane can't inject
// into the system prompt mid-session. Instead, sends a follow-up user message.
// ============================================================================

/**
 * Format a verdict as a user-facing prompt for the model to fix issues.
 * Used by CLI backend follow-up mechanism.
 *
 * @param {ArbiterVerdict} verdict
 * @returns {string}
 */
export function formatVerdictAsPrompt(verdict) {
  const errors = (verdict.findings || []).filter(f => f.severity === "error");
  if (errors.length === 0) return "";

  const lines = ["Pane's quality gate found issues in your last changes:"];
  for (const f of errors.slice(0, 5)) {
    lines.push(`- ${f.file}:${f.line} — ${f.raw}`);
  }
  lines.push("");
  lines.push("Fix these issues. Do not suppress errors with @ts-ignore or eslint-disable — fix the root cause.");
  return lines.join("\n");
}

// ============================================================================
// Correction Tracking — count events, don't interpret them
// ============================================================================
// Records individual correction events from three sources:
//   1. Arbiter findings (code quality violations detected at write time)
//   2. User reverts (checkpoint restores, explicit "undo")
//   3. User negation (message starts with "no", "don't", "wrong", "revert", etc.)
//
// When the same correction_type hits 3+ times in a week, it's a pattern.
// Patterns are surfaced to the user as candidate rules for the DNA.
// No LLM extraction. Just counting.

// Negation signals that suggest the user is correcting the model
const NEGATION_PATTERNS = [
  /^no[,.\s!]/i,
  /^don'?t\s/i,
  /^stop\s/i,
  /^wrong/i,
  /^that'?s not/i,
  /^revert/i,
  /^undo/i,
  /^not what I/i,
  /^I said\s/i,
  /^I told you/i,
  /^why did you/i,
  /^you (broke|ruined|messed)/i,
];

/**
 * Record a correction event from the arbiter.
 * Called automatically when the Turn Sentinel finds violations.
 *
 * @param {object} db - Pane SQLite database
 * @param {string} projectId
 * @param {ArbiterVerdict} verdict
 */
export function recordArbiterCorrections(db, projectId, verdict, model) {
  if (!db?.stmts?.insertCorrection || !verdict?.findings) return;

  const now = Date.now();
  for (const f of verdict.findings) {
    if (f.severity !== "error") continue; // Only track errors, not warnings
    const id = `corr-${now}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      db.stmts.insertCorrection.run(
        id,
        projectId,
        f.code || f.id || "unknown",         // correction_type: "ts-ignore", "unclosed-brace", etc.
        model || verdict.model || "",
        "arbiter",                             // source
        `${f.file}:${f.line} — ${(f.raw || f.plain || "").slice(0, 200)}`,
        now,                                   // first_seen (ignored on conflict)
        now,                                   // last_seen
      );
    } catch {}
  }
}

/**
 * Record a correction event from user action (revert/negation).
 *
 * @param {object} db
 * @param {string} projectId
 * @param {string} correctionType - "user-revert" | "user-negation"
 * @param {string} [detail] - Brief context
 * @param {string} [model]
 */
export function recordUserCorrection(db, projectId, correctionType, detail, model) {
  if (!db?.stmts?.insertCorrection) return;

  const now = Date.now();
  const id = `corr-${now}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    db.stmts.insertCorrection.run(
      id,
      projectId,
      correctionType,
      model || "",
      "user",
      (detail || "").slice(0, 200),
      now,   // first_seen (ignored on conflict)
      now,   // last_seen
    );
  } catch {}
}

/**
 * Detect if a user message is a correction (negation pattern).
 * Returns true if the message starts with a negation signal.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isUserCorrection(message) {
  if (!message || message.length < 2) return false;
  const firstLine = message.split("\n")[0].trim();
  return NEGATION_PATTERNS.some(re => re.test(firstLine));
}

/**
 * Get repeated corrections that should graduate to rules.
 * Returns correction types that occurred 3+ times in the last 7 days.
 *
 * @param {object} db
 * @param {number} [threshold=3] - Minimum occurrences to qualify
 * @param {number} [windowMs=604800000] - Time window (default 7 days)
 * @returns {Array<{type: string, count: number, detail: string}>}
 */
export function getRepeatedCorrections(db, threshold = 3, windowMs = 7 * 24 * 60 * 60 * 1000) {
  if (!db?.stmts?.getRepeatedCorrections) return [];

  try {
    const since = Date.now() - windowMs;
    const rows = db.stmts.getRepeatedCorrections.all(since, threshold);
    return rows.map(r => ({
      type: r.correction_type,
      count: r.count,
      detail: r.last_detail || "",
      lastSeen: r.last_seen,
    }));
  } catch {
    return [];
  }
}

/**
 * Get repeated corrections for a specific project.
 *
 * @param {object} db
 * @param {string} projectId
 * @param {number} [windowMs=604800000]
 * @returns {Array<{type: string, count: number, detail: string}>}
 */
export function getProjectCorrections(db, projectId, windowMs = 7 * 24 * 60 * 60 * 1000) {
  if (!db?.stmts?.getCorrectionsByProject) return [];

  try {
    const since = Date.now() - windowMs;
    return db.stmts.getCorrectionsByProject.all(projectId, since).map(r => ({
      type: r.correction_type,
      count: r.count,
      detail: r.last_detail || "",
    }));
  } catch {
    return [];
  }
}
