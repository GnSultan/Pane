/**
 * Semantic Exploration Tool — one call, full picture.
 *
 * The model asks a natural language question about the codebase.
 * Pane orchestrates: brain semantic search → symbol index → code extraction
 * → import relationships → architecture constraints → brain memories.
 *
 * Returns a structured result the model can plan from immediately.
 * Replaces 7-9 turns of grep→read→grep→read with 1-2 turns.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isUIFile,
  isArchFile,
  getUIConstraints,
  getArchBrief,
  getRelevantMemories,
} from "./tool-enrichment.mjs";

const PANE_DIR = path.join(os.homedir(), ".pane");

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/**
 * Score symbols against a natural language query.
 */
function scoreSymbols(symbols, query) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  return symbols
    .map(s => {
      if (!s.name) return null;
      const name = s.name.toLowerCase();
      const doc = (s.doc || "").toLowerCase();
      const file = (s.file || "").toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name === w) score += 1.0;
        else if (name.includes(w)) score += 0.6;
        if (doc.includes(w)) score += 0.3;
        if (file.includes(w)) score += 0.15;
      }
      return score > 0 ? { ...s, _score: score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b._score - a._score);
}

/**
 * Detect function/class boundaries in a file.
 * Returns array of { startLine, endLine, name, kind } for each top-level
 * function, class, or export in the file.
 */
function detectFunctionBoundaries(lines) {
  const boundaries = [];
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[^=])\s*=>/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^(?:export\s+default\s+)?function\s+(\w+)/,
    /^(?:export\s+default\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:memo|forwardRef|React\.memo)\(/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of patterns) {
      const match = pat.exec(line);
      if (match) {
        const name = match[1] || "anonymous";
        // Find the end: track BRACE depth only (not parens — function args
        // and call sites use parens that would confuse the counter).
        let depth = 0;
        let endLine = i;
        let foundBrace = false;
        for (let j = i; j < lines.length && j < i + 300; j++) {
          for (const ch of lines[j]) {
            if (ch === "{") { depth++; foundBrace = true; }
            if (ch === "}") depth--;
          }
          if (foundBrace && depth <= 0) { endLine = j; break; }
          endLine = j;
        }
        const kind = line.includes("class ") ? "class" : "function";
        boundaries.push({ startLine: i, endLine, name, kind });
        i = endLine; // skip past this function
        break;
      }
    }
  }
  return boundaries;
}

/**
 * Extract the most relevant section of a file for a given query.
 * Uses function-boundary detection to return complete functions, not arbitrary windows.
 */
function extractRelevantSection(lines, query, maxLines = 50) {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);

  // First: try to find a complete function that matches the query
  const boundaries = detectFunctionBoundaries(lines);
  if (boundaries.length > 0) {
    // Score each function by keyword relevance
    const scored = boundaries.map(b => {
      const funcLines = lines.slice(b.startLine, b.endLine + 1).join(" ").toLowerCase();
      const nameScore = words.some(w => b.name.toLowerCase().includes(w)) ? 2 : 0;
      const bodyScore = words.filter(w => funcLines.includes(w)).length;
      return { ...b, score: nameScore + bodyScore };
    }).filter(b => b.score > 0).sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      const funcLength = best.endLine - best.startLine + 1;
      // If function fits in maxLines, return the whole thing
      if (funcLength <= maxLines) {
        return {
          startLine: best.startLine + 1,
          code: lines.slice(best.startLine, best.endLine + 1).join("\n"),
        };
      }
      // Too long — return the first maxLines with a truncation note
      return {
        startLine: best.startLine + 1,
        code: lines.slice(best.startLine, best.startLine + maxLines).join("\n") +
          `\n// ... ${funcLength - maxLines} more lines in ${best.name}()`,
      };
    }
  }

  // Fallback: sliding window for files without clear function boundaries (CSS, JSON, config)
  let bestStart = 0;
  let bestScore = 0;
  const windowSize = 20;
  for (let i = 0; i <= Math.max(0, lines.length - windowSize); i++) {
    const window = lines.slice(i, i + windowSize).join(" ").toLowerCase();
    const score = words.filter(w => window.includes(w)).length;
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }

  if (bestScore > 0) {
    return { startLine: bestStart + 1, code: lines.slice(bestStart, bestStart + maxLines).join("\n") };
  }

  // Last resort: skip imports, return first meaningful section
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("import ") && !lines[i].startsWith("//") && lines[i].trim()) {
      start = Math.max(0, i - 2);
      break;
    }
  }
  return { startLine: start + 1, code: lines.slice(start, start + maxLines).join("\n") };
}

/**
 * Explore the codebase semantically.
 *
 * @param {string} query - Natural language question
 * @param {string} projectId
 * @param {string} projectRoot
 * @param {object} options - { brainRequest?, maxFiles?, maxCodeLines? }
 * @returns {Promise<string>} - Structured exploration result
 */
export async function explore(query, projectId, projectRoot, options = {}) {
  const { brainRequest, maxFiles = 5, maxCodeLines = 50 } = options;
  const result = [];

  // ── 1. Semantic file discovery ────────────────────────────────────
  let relevantFiles = [];
  if (brainRequest) {
    try {
      const compassResult = await withTimeout(
        brainRequest("codebase_compass", { query, projectId, projectRoot, limit: maxFiles + 3 }),
        3000,
      );
      relevantFiles = (compassResult?.result || []).slice(0, maxFiles);
    } catch {}
  }

  if (relevantFiles.length > 0) {
    result.push("## Key Files");
    for (const f of relevantFiles) {
      result.push(`- ${f.path} — ${f.description || ""}`);
    }
    result.push("");
  }

  // ── 2. Symbol resolution ──────────────────────────────────────────
  let allSymbols = [];
  try {
    const symbolsPath = path.join(PANE_DIR, "brain", "symbols", `${projectId}.json`);
    const exported = JSON.parse(fs.readFileSync(symbolsPath, "utf-8"));
    if (exported?.symbols) {
      allSymbols = scoreSymbols(exported.symbols, query).slice(0, 15);
    }
  } catch {}

  if (allSymbols.length > 0) {
    result.push("## Key Functions");
    for (const s of allSymbols) {
      if (!s.name || !s.file) continue;
      const doc = s.doc ? ` — ${s.doc}` : "";
      result.push(`- ${s.name} (${s.kind || "?"}) → ${s.file}:${s.line || 0}${doc}`);
    }
    result.push("");
  }

  // ── 3. Code extraction — relevant sections, not full files ────────
  const codeExcerpts = [];
  for (const file of relevantFiles) {
    const filePath = path.isAbsolute(file.path)
      ? file.path
      : path.join(projectRoot, file.path);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      // Find symbols in this file
      const fileSymbols = allSymbols.filter(s =>
        s.file === file.path || filePath.endsWith(s.file)
      );

      if (fileSymbols.length > 0) {
        // Extract code around matching symbols
        for (const sym of fileSymbols.slice(0, 2)) {
          const start = Math.max(0, sym.line - 3);
          const end = Math.min(lines.length, sym.line + maxCodeLines);
          codeExcerpts.push({
            file: file.path,
            label: `${sym.name} (${sym.kind})`,
            startLine: start + 1,
            code: lines.slice(start, end).join("\n"),
          });
        }
      } else {
        // No specific symbols — extract most relevant section
        const section = extractRelevantSection(lines, query, maxCodeLines);
        codeExcerpts.push({
          file: file.path,
          label: "relevant section",
          startLine: section.startLine,
          code: section.code,
        });
      }
    } catch {}
  }

  if (codeExcerpts.length > 0) {
    result.push("## Relevant Code");
    for (const ex of codeExcerpts) {
      result.push(`### ${ex.label} — ${ex.file}:${ex.startLine}`);
      result.push("```");
      result.push(ex.code);
      result.push("```");
      result.push("");
    }
  }

  // ── 4. Relationships ──────────────────────────────────────────────
  const relationships = [];
  for (const file of relevantFiles.slice(0, 3)) {
    const filePath = path.isAbsolute(file.path)
      ? file.path
      : path.join(projectRoot, file.path);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = [...content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
      // Filter to imports that reference other relevant files
      const relImports = imports.filter(imp => {
        const impBase = imp.replace(/^\.\//, "").replace(/\.\w+$/, "");
        return relevantFiles.some(rf => rf.path.includes(impBase));
      });
      if (relImports.length > 0) {
        relationships.push(`${path.basename(file.path)} imports: ${relImports.join(", ")}`);
      }
    } catch {}
  }

  if (relationships.length > 0) {
    result.push("## How They Connect");
    for (const r of relationships) result.push(`- ${r}`);
    result.push("");
  }

  // ── 5. Constraints — architecture + memories ──────────────────────
  const constraintParts = [];

  // Architecture briefs for relevant files
  for (const file of relevantFiles.slice(0, 2)) {
    if (isArchFile(file.path)) {
      const brief = getArchBrief(projectId, file.path);
      if (brief) { constraintParts.push(brief); break; } // one brief is enough
    }
  }

  // UI constraints if relevant
  if (relevantFiles.some(f => isUIFile(f.path))) {
    const ui = getUIConstraints(projectId);
    if (ui) constraintParts.push(ui);
  }

  // Brain memories
  const memories = await getRelevantMemories(projectId, query, brainRequest);
  if (memories) constraintParts.push(memories);

  if (constraintParts.length > 0) {
    result.push("## Constraints");
    result.push(constraintParts.join("\n"));
    result.push("");
  }

  if (result.length === 0) {
    // Give specific guidance based on what's available
    const hasBrain = !!brainRequest;
    const hasSymbols = allSymbols.length > 0;
    if (!hasBrain && !hasSymbols) {
      return "No results — project index is still building. Pane indexes files automatically as you work. " +
        "For now, use grep_search or read_file to explore manually.";
    }
    return "No relevant results found for this query. Try:\n" +
      "- Rephrasing with specific function or file names\n" +
      "- Using grep_search for exact text patterns\n" +
      "- Using pane_find_symbol if you know the symbol name";
  }

  return result.join("\n");
}
