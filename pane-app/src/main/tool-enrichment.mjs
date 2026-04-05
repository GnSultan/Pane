/**
 * Tool Result Enrichment — inject project intelligence into exploration results.
 *
 * When the model calls read_file, grep_search, or glob, the raw result is
 * enriched with project-specific context: design constraints for UI files,
 * architecture briefs for engine files, relevant brain memories, symbol
 * information, and import relationships.
 *
 * The model doesn't need to call special tools. It uses what it knows
 * (read_file, grep) and Pane makes every result smarter.
 *
 * Also used by the `explore` tool for per-file enrichment.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");

// ── File type detection ─────────────────────────────────────────────────

export function isUIFile(filePath) {
  if (!filePath) return false;
  // Only actual component files — not hooks, lib, stores, types, utils.
  // Design constraints are irrelevant for useScrollPosition.ts or punk-types.ts.
  if (!/\.(tsx|jsx)$/.test(filePath)) return false;
  if (filePath.includes("/components/")) return true;
  // Catch top-level pages/screens that render UI
  if (filePath.includes("/pages/") || filePath.includes("/screens/")) return true;
  return false;
}

export function isArchFile(filePath) {
  if (!filePath) return false;
  return /\.(mjs|ts)$/.test(filePath) &&
    (filePath.includes("/main/") || filePath.includes("engine") ||
     filePath.includes("backend") || filePath.includes("orchestrat") ||
     filePath.includes("router") || filePath.includes("store"));
}

// ── Enrichment sources ──────────────────────────────────────────────────

/**
 * Get UI design constraints for a project.
 * @param {string} projectId
 * @returns {string | null}
 */
export function getUIConstraints(projectId) {
  try {
    const raw = fs.readFileSync(
      path.join(PANE_DIR, "memory", projectId, "ui-constraints.json"), "utf-8"
    );
    const rules = JSON.parse(raw);
    if (!Array.isArray(rules) || rules.length === 0) return null;
    const lines = ["[Pane Design Context — rules for this component]"];
    for (const r of rules) lines.push(`- ${typeof r === "string" ? r : r.rule || r.content || JSON.stringify(r)}`);
    lines.push("[End Design Context]");
    return lines.join("\n");
  } catch { return null; }
}

/**
 * Get architecture brief for a file's subsystem.
 * @param {string} projectId
 * @param {string} filePath
 * @returns {string | null}
 */
export function getArchBrief(projectId, filePath) {
  try {
    const raw = fs.readFileSync(
      path.join(PANE_DIR, "memory", projectId, "subsystems.json"), "utf-8"
    );
    const raw_parsed = JSON.parse(raw);
    // Support both formats: object { name: {...} } and array [{ id, name, ... }]
    // Also support { subsystems: [...] } wrapper
    let entries;
    if (Array.isArray(raw_parsed)) {
      entries = raw_parsed.map(sub => [sub.id || sub.name || "", sub]);
    } else if (raw_parsed.subsystems && Array.isArray(raw_parsed.subsystems)) {
      entries = raw_parsed.subsystems.map(sub => [sub.id || sub.name || "", sub]);
    } else {
      entries = Object.entries(raw_parsed);
    }
    // Match file to subsystem by name or file list
    const baseName = path.basename(filePath).replace(/\.\w+$/, "");
    for (const [name, sub] of entries) {
      if (!sub || typeof sub !== "object") continue;
      const files = sub.files || sub.scopeFiles || sub.filePatterns || [];
      const matches = files.some(f => filePath.includes(f)) ||
        filePath.includes(name) || baseName.includes(name);
      if (matches) {
        const parts = [`[Pane Architecture Context — ${sub.name || name}]`];
        const decisions = sub.decisions || sub.lockedDecisions || [];
        const patterns = sub.patterns || sub.patternInEffect ? [sub.patternInEffect] : [];
        const gotchas = sub.gotchas || sub.knownGotchas || [];
        for (const d of decisions) { const t = typeof d === "string" ? d : d.decision || d.content || ""; if (t) parts.push(`- LOCKED: ${t}`); }
        for (const p of (Array.isArray(patterns) ? patterns : [])) { if (p) parts.push(`- PATTERN: ${typeof p === "string" ? p : p.pattern || p}`); }
        for (const g of gotchas) { if (g) parts.push(`- GOTCHA: ${typeof g === "string" ? g : g.description || g}`); }
        parts.push("[End Architecture Context]");
        return parts.length > 2 ? parts.join("\n") : null;
      }
    }
    return null;
  } catch { return null; }
}

/**
 * Get relevant brain memories for a file or query.
 * @param {string} projectId
 * @param {string} query - File path or search query
 * @param {Function} brainRequest
 * @returns {Promise<string | null>}
 */
export async function getRelevantMemories(projectId, query, brainRequest) {
  if (!brainRequest) return null;
  try {
    const result = await Promise.race([
      brainRequest("search", { query, projectId, limit: 3 }),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 1000)),
    ]);
    const memories = (result?.results || []).filter(r => r.score > 0.6);
    if (memories.length === 0) return null;
    const lines = ["[Pane Memory — relevant context]"];
    for (const m of memories) lines.push(`- ${m.content}`);
    lines.push("[End Memory]");
    return lines.join("\n");
  } catch { return null; }
}

/**
 * Get key symbols in a file from the symbol index.
 * @param {string} projectId
 * @param {string} filePath
 * @returns {string | null}
 */
export function getFileSymbols(projectId, filePath) {
  try {
    const symbolsPath = path.join(PANE_DIR, "brain", "symbols", `${projectId}.json`);
    const exported = JSON.parse(fs.readFileSync(symbolsPath, "utf-8"));
    if (!exported?.symbols) return null;
    // Normalize paths for matching — symbol index may store relative or absolute.
    // Compare by basename + parent dir to avoid false matches.
    const baseName = path.basename(filePath);
    const parentDir = path.basename(path.dirname(filePath));
    const relPath = filePath.replace(/^.*?src\//, "src/");
    const fileSymbols = exported.symbols.filter(s => {
      if (!s.file) return false;
      // Exact match (both absolute or both relative)
      if (s.file === filePath || s.file === relPath) return true;
      // Basename + parent dir match (avoids false positives from common names)
      const sBase = path.basename(s.file);
      const sParent = path.basename(path.dirname(s.file));
      if (sBase === baseName && sParent === parentDir) return true;
      // Last resort: one path ends with the other
      if (filePath.endsWith(s.file) || s.file.endsWith(relPath)) return true;
      return false;
    }).slice(0, 10);
    if (fileSymbols.length === 0) return null;
    const lines = ["[Key symbols in this file]"];
    for (const s of fileSymbols) {
      const doc = s.doc ? ` — ${s.doc}` : "";
      lines.push(`- ${s.name} (${s.kind}) line ${s.line}${doc}`);
    }
    lines.push("[End symbols]");
    return lines.join("\n");
  } catch { return null; }
}

/**
 * Get structural context when grep/glob hits multiple files.
 * @param {string} projectId
 * @param {string} query
 * @param {Function} brainRequest
 * @returns {Promise<string | null>}
 */
export async function getStructuralContext(projectId, query, brainRequest) {
  if (!brainRequest) return null;
  try {
    const result = await Promise.race([
      brainRequest("codebase_compass", { query, projectId, limit: 5 }),
      new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 2000)),
    ]);
    const files = result?.result || [];
    if (files.length === 0) return null;
    const lines = ["[Pane Structural Context]"];
    for (const f of files) {
      lines.push(`- ${f.path} — ${f.description || ""}`);
    }
    lines.push("[End Structural Context]");
    return lines.join("\n");
  } catch { return null; }
}

// ── Main enrichment function ────────────────────────────────────────────

/**
 * Enrich a tool result with project intelligence.
 *
 * @param {string} toolName - The tool that was called
 * @param {object} toolInput - The tool's input parameters
 * @param {string} toolOutput - The raw tool result
 * @param {string} projectId - Current project
 * @param {object} options - { brainRequest?, projectRoot? }
 * @returns {Promise<string>} - Enriched output (original + appended context)
 */
export async function enrichToolResult(toolName, toolInput, toolOutput, projectId, options = {}) {
  const { brainRequest, projectRoot } = options;
  const enrichments = [];

  const filePath = toolInput?.file_path || toolInput?.path || "";

  if (toolName === "read_file" || toolName === "pane_read_files") {
    // UI file: design constraints
    if (isUIFile(filePath)) {
      const constraints = getUIConstraints(projectId);
      if (constraints) enrichments.push(constraints);
    }

    // Architecture file: subsystem brief
    if (isArchFile(filePath)) {
      const brief = getArchBrief(projectId, filePath);
      if (brief) enrichments.push(brief);
    }

    // Key symbols in this file
    const symbols = getFileSymbols(projectId, filePath);
    if (symbols) enrichments.push(symbols);

    // Relevant memories
    const memories = await getRelevantMemories(projectId, filePath, brainRequest);
    if (memories) enrichments.push(memories);
  }

  if (toolName === "grep_search" || toolName === "glob") {
    // Multi-file results: structural context
    const query = toolInput?.pattern || toolInput?.query || "";
    const structural = await getStructuralContext(projectId, query, brainRequest);
    if (structural) enrichments.push(structural);
  }

  if (enrichments.length === 0) return toolOutput;
  return toolOutput + "\n\n" + enrichments.join("\n\n");
}
