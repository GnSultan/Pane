// Pane Find References — search every usage of a symbol across the project.
// Covers imports, call sites, JSX usage, and type references.
// Returns structured data; formatting is handled by formatReferencesOutput.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// --- Constants (verbatim from brain-engine.mjs) ---
// Exported so other modules can import instead of duplicating.

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", "release",
  ".cache", ".parcel-cache", ".next", ".nuxt", "coverage",
  "__pycache__", ".venv", "venv", ".tox",
]);

export const MEANINGFUL_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".rb", ".php", ".cs", ".cpp", ".c", ".h",
  ".vue", ".svelte",
  ".sh", ".bash",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".txt",
  ".sql",
]);

// --- Caps ---

const MAX_FILES_CAP = 500;
const MAX_MATCHES_TOTAL = 200;
const MAX_MATCHES_PER_FILE = 50;
const MAX_FILES_IN_OUTPUT = 30;
const MAX_LINE_LENGTH = 2000;

// --- File walker ---

export async function walkFiles(rootDir) {
  const results = [];

  async function recurse(dir) {
    if (results.length >= MAX_FILES_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES_CAP) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          await recurse(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEANINGFUL_EXTENSIONS.has(ext)) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  }

  await recurse(rootDir);
  return results;
}

// --- Symbol name escaping for regex ---

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Build per-symbol regexes ---

function buildPatterns(symbol) {
  const esc = escapeForRegex(symbol);
  return [
    { type: "import",    regex: new RegExp(`\\bimport\\b[^;\\n]*\\b${esc}\\b`) },
    { type: "jsx",       regex: new RegExp(`<${esc}[\\s\\/>]|<\\/${esc}>`) },
    { type: "type_ref",  regex: new RegExp(`[:<]\\s*${esc}\\b`) },
    { type: "call_site", regex: new RegExp(`${esc}\\s*\\(`) },
    { type: "use",       regex: new RegExp(`\\b${esc}\\b`) },
  ];
}

// --- Per-file search ---
// Reads the file once; binary check runs on the head of the already-read string.

async function searchFile(filePath, patterns) {
  let content;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  // Binary detection: null bytes in the first 512 chars
  if (content.slice(0, 512).includes("\0")) return [];

  const lines = content.split("\n");
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= MAX_MATCHES_PER_FILE) break;
    const line = lines[i];
    if (line.length > MAX_LINE_LENGTH) continue;

    // First-match-wins pattern classification
    let usageType = null;
    for (const { type, regex } of patterns) {
      if (regex.test(line)) {
        usageType = type;
        break;
      }
    }
    if (!usageType) continue;

    const contextAfter = i < lines.length - 1 ? lines[i + 1].trim() || null : null;

    matches.push({
      line: i + 1, // 1-based
      lineText: line.trim(),
      usageType,
      contextAfter,
    });
  }

  return matches;
}

// --- Declaration enrichment ---

async function loadDeclarations(projectId) {
  if (!projectId) return new Map();
  const symbolsPath = path.join(os.homedir(), ".pane", "brain", "symbols", `${projectId}.json`);
  try {
    const raw = await readFile(symbolsPath, "utf-8");
    const exported = JSON.parse(raw);
    const symbols = Array.isArray(exported) ? exported : (exported?.symbols || []);
    const decls = new Map();
    for (const sym of symbols) {
      if (sym.file && sym.line) {
        decls.set(`${sym.file}:${sym.line}`, true);
      }
    }
    return decls;
  } catch {
    return new Map();
  }
}

// --- Main export ---

/**
 * Find every reference to a symbol across the project.
 *
 * @param {string} symbol - Exact symbol name to search for
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} options
 * @param {string} [options.projectId] - Optional project ID for declaration tagging
 * @returns {{ byFile: Map<string, Match[]>, totalMatches: number, filesSearched: number }}
 */
export async function findReferences(symbol, projectRoot, options = {}) {
  const patterns = buildPatterns(symbol);
  const declarations = await loadDeclarations(options.projectId || "");

  const allFiles = await walkFiles(projectRoot);
  const filesSearched = allFiles.length;

  const byFile = new Map(); // relPath → Match[]
  let totalMatches = 0;
  let filesInOutput = 0;

  for (const absPath of allFiles) {
    if (totalMatches >= MAX_MATCHES_TOTAL) break;

    const matches = await searchFile(absPath, patterns);
    if (matches.length === 0) continue;

    // Skip files beyond the output cap — don't count their matches either,
    // so totalMatches accurately reflects what byFile contains.
    if (filesInOutput >= MAX_FILES_IN_OUTPUT) continue;

    const relPath = path.relative(projectRoot, absPath);

    // Declaration enrichment: tag matches that coincide with known symbol declarations
    for (const m of matches) {
      if (declarations.has(`${relPath}:${m.line}`)) {
        m.isDeclaration = true;
      }
    }

    byFile.set(relPath, matches);
    filesInOutput++;
    totalMatches += matches.length;
  }

  return { byFile, totalMatches, filesSearched };
}

// --- Formatter ---

/**
 * Format findReferences output as a human-readable string.
 *
 * @param {string} symbol
 * @param {Map<string, Match[]>} byFile
 * @param {number} totalMatches
 * @param {number} filesSearched
 * @returns {string}
 */
export function formatReferencesOutput(symbol, byFile, totalMatches, filesSearched) {
  if (totalMatches === 0 || byFile.size === 0) {
    return `No references to "${symbol}" found. (searched ${filesSearched} files)`;
  }

  const fileCount = byFile.size;
  let out = `${totalMatches} reference${totalMatches !== 1 ? "s" : ""} to "${symbol}" across ${fileCount} file${fileCount !== 1 ? "s" : ""}  (searched ${filesSearched} files)`;

  if (totalMatches >= MAX_MATCHES_TOTAL) {
    out += `\nNote: results capped at ${MAX_MATCHES_TOTAL} total / ${MAX_MATCHES_PER_FILE} per file.`;
  }

  // Sort: declaration file first, then alphabetical
  const entries = [...byFile.entries()];
  entries.sort(([pathA, matchesA], [pathB, matchesB]) => {
    const aHasDecl = matchesA.some(m => m.isDeclaration);
    const bHasDecl = matchesB.some(m => m.isDeclaration);
    if (aHasDecl && !bHasDecl) return -1;
    if (!aHasDecl && bHasDecl) return 1;
    return pathA.localeCompare(pathB);
  });

  for (const [relPath, matches] of entries) {
    const hasDeclaration = matches.some(m => m.isDeclaration);
    const declNote = hasDeclaration ? " (declaration)" : "";
    out += `\n\n${relPath} — ${matches.length} reference${matches.length !== 1 ? "s" : ""}${declNote}`;

    // Determine if we need type sub-headers (>1 distinct type in this file)
    const types = new Set(matches.map(m => m.usageType));
    const showTypeHeaders = types.size > 1;

    if (showTypeHeaders) {
      // Group by usageType, preserving order of first occurrence.
      // Within each group, matches remain in ascending line-number order.
      const groups = new Map();
      for (const m of matches) {
        if (!groups.has(m.usageType)) groups.set(m.usageType, []);
        groups.get(m.usageType).push(m);
      }
      for (const [usageType, groupMatches] of groups) {
        out += `\n  ${usageType}`;
        for (const m of groupMatches) {
          const lineNum = String(m.line).padEnd(4);
          out += `\n  ${lineNum} → ${m.lineText}`;
          if (m.contextAfter) out += `\n       ${m.contextAfter}`;
        }
      }
    } else {
      for (const m of matches) {
        const lineNum = String(m.line).padEnd(4);
        out += `\n  ${lineNum} → ${m.lineText}`;
        if (m.contextAfter) out += `\n       ${m.contextAfter}`;
      }
    }
  }

  return out;
}
