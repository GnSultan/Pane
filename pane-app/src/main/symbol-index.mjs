/**
 * Pane Symbol Index — zero-cost structural awareness.
 *
 * Regex parse of exports → SQLite.
 * No LLM. No embeddings. Fast lookup, always current.
 *
 * Tables owned:
 *   symbols            — one row per exported symbol (name, kind, file, line, signature, doc)
 *   file_relationships — import/export/reference edges between files
 */

import fs from "node:fs";
import path from "node:path";
import { resolveProjectScope } from "./root-scope.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARSER_VERSION = 2; // Increment when parseTS/parsePY logic changes.
                          // v1: module-level exports only
                          // v2: added class method detection (line 71)

const PARSEABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py",
]);

// Words that look like symbols but aren't — skip them in extractSymbolNames()
const SYMBOL_STOPWORDS = new Set([
  "I", "You", "The", "This", "That", "With", "From", "When", "Where",
  "What", "How", "Why", "Which", "And", "For", "But", "Not", "Can",
  "Should", "Will", "Would", "Could", "Have", "Has", "Had", "Was",
  "Are", "Were", "Been", "Being", "Into", "Over", "Under", "Then",
  "Than", "Its", "Our", "Your", "Their", "Also", "Only", "Just",
]);

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

// TypeScript / JavaScript export patterns (checked in order)
const TS_PATTERNS = [
  { kind: "function",   re: /^export\s+(?:async\s+)?function\s*\*?\s*(\w+)/ },
  { kind: "class",      re: /^export\s+(?:abstract\s+)?class\s+(\w+)/ },
  { kind: "interface",  re: /^export\s+(?:default\s+)?interface\s+(\w+)/ },
  { kind: "type",       re: /^export\s+type\s+(\w+)(?:\s*[=<{])/ },
  { kind: "enum",       re: /^export\s+(?:const\s+)?enum\s+(\w+)/ },
  { kind: "namespace",  re: /^export\s+namespace\s+(\w+)/ },
  { kind: "const",      re: /^export\s+const\s+(\w+)/ },
  { kind: "let",        re: /^export\s+let\s+(\w+)/ },
  { kind: "var",        re: /^export\s+var\s+(\w+)/ },
];

const TS_DEFAULT_RE   = /^export\s+default\s+(?:(?:async\s+)?function\s+(\w+)|class\s+(\w+))/;
const TS_REEXPORT_RE  = /^export\s+\{([^}]+)\}(?:\s+from)?/;

// Python: top-level only (indented = skip)
const PY_PATTERNS = [
  { kind: "async_fn",  re: /^async\s+def\s+(\w+)/ },
  { kind: "function",  re: /^def\s+(\w+)/ },
  { kind: "class",     re: /^class\s+(\w+)/ },
];

/**
 * Parse TypeScript / JavaScript → symbol records.
 *
 * Captures:
 *   - Module-level exports (existing logic)
 *   - Class methods (new): tracks class body brace-depth to find method
 *     declarations inside exported and non-exported classes alike.
 */
function parseTS(content) {
  const lines = content.split("\n");
  const symbols = [];

  // ── Pre-scan: find class body ranges via brace-depth tracking ──────
  // Each range runs from the class declaration line up to (inclusive)
  // the line containing the matching closing brace.
  const classRanges = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:export\s+)?(?:abstract\s+)?class\s+\w+/.test(lines[i])) {
      let depth = 0;
      let opened = false;
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        for (const ch of l) {
          if (ch === '{') { depth++; opened = true; }
          else if (ch === '}') { depth--; }
        }
        if (opened && depth === 0) break;
        j++;
      }
      classRanges.push({ start: i, end: j });
    }
  }

  /** True when lineIdx is inside any class body (not on the class declaration itself). */
  function insideClassBody(lineIdx) {
    return classRanges.some(r => lineIdx > r.start && lineIdx <= r.end);
  }

  // Method-like signature patterns checked against lines inside a class body.
  // Captures regular methods, async, get/set, static, constructor, arrow properties.
  const METHOD_RE = /^(?:(?:public|protected|private|static|readonly|abstract|async|get|set|#)\s+)*(?:constructor|\w+)\s*\(/;

  // Keywords that can appear before `(` but are NOT method declarations.
  const EXPRESSION_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
    'delete', 'typeof', 'instanceof', 'new', 'import', 'export', 'super',
  ]);

  /** Extract the method/function name from a line containing `name(`. */
  function extractMethodName(trimmedLine) {
    const m = trimmedLine.match(/(\w+)\s*\(/);
    return m ? m[1] : null;
  }

  // ── Main loop ───────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // ── Non-export lines: check for class methods ─────────────────────
    if (!line.startsWith("export")) {
      if (insideClassBody(i) && METHOD_RE.test(line)) {
        const name = extractMethodName(line);
        if (name && !EXPRESSION_KEYWORDS.has(name) && !line.startsWith('}') && !line.startsWith('this.')) {
          const signature = lines.slice(i, Math.min(i + 3, lines.length))
            .join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
          symbols.push({ name, kind: "method", signature, line: i + 1, doc: null });
        }
      }
      continue;
    }

    // ── Export lines (existing logic) ─────────────────────────────────
    // Multi-line signature: join up to 3 lines
    const signature = lines.slice(i, Math.min(i + 3, lines.length))
      .join(" ").replace(/\s+/g, " ").trim().slice(0, 200);

    // Collect JSDoc above (scan backwards, up to 8 lines)
    let doc = null;
    const docLines = [];
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const prev = lines[j].trim();
      if (prev === "") break;
      if (/^\/?\*/.test(prev) || prev.startsWith("/*") || prev.startsWith("/**")) {
        const cleaned = prev.replace(/^\/?\*+\/?/, "").trim();
        if (cleaned) docLines.unshift(cleaned);
      } else {
        break;
      }
    }
    if (docLines.length > 0) doc = docLines.join(" ").slice(0, 200);

    // Named export patterns
    let hit = false;
    for (const { kind, re } of TS_PATTERNS) {
      const m = line.match(re);
      if (m) {
        symbols.push({ name: m[1], kind, signature, line: i + 1, doc });
        hit = true;
        break;
      }
    }
    if (hit) continue;

    // Default export: `export default function Foo` / `export default class Foo`
    const dm = line.match(TS_DEFAULT_RE);
    if (dm) {
      symbols.push({ name: dm[1] || dm[2] || "default", kind: "default", signature, line: i + 1, doc });
      continue;
    }

    // Re-exports: `export { foo, bar as baz }`
    const rm = line.match(TS_REEXPORT_RE);
    if (rm) {
      const names = rm[1].split(",").map(s => {
        const parts = s.trim().split(/\s+as\s+/);
        return (parts[parts.length - 1] || "").trim();
      }).filter(n => /^\w+$/.test(n));
      for (const name of names) {
        symbols.push({ name, kind: "reexport", signature: line.slice(0, 120), line: i + 1, doc: null });
      }
    }
  }

  return symbols;
}

/**
 * Parse Python → top-level symbol records only.
 */
function parsePY(content) {
  const lines = content.split("\n");
  const symbols = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line)) continue; // indented = not top-level

    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const { kind, re } of PY_PATTERNS) {
      const m = trimmed.match(re);
      if (m) {
        const name = m[1];
        if (name.startsWith("_") && !name.startsWith("__")) continue; // skip private
        const signature = lines.slice(i, Math.min(i + 2, lines.length))
          .join(" ").trim().slice(0, 200);
        symbols.push({ name, kind, signature, line: i + 1, doc: null });
        break;
      }
    }
  }

  return symbols;
}

function parseFile(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"].includes(ext)) return parseTS(content);
  if (ext === ".py") return parsePY(content);
  return [];
}

/**
 * Extract file relationships (imports / dependencies) from a file.
 * Returns { target: string, type: string }[] where target is a relative path.
 */
function extractRelationships(content, filePath, projectRoot) {
  const ext = path.extname(filePath).toLowerCase();
  const rels = [];
  const dir = path.dirname(filePath);

  if ([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"].includes(ext)) {
    // import { foo } from "./path"
    const importFromRe = /from\s+["']([^"']+)["']/g;
    // import "./path"
    const importOnlyRe = /import\s+["']([^"']+)["']/g;
    // require("./path")
    const requireRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
    // export * from "./path"
    const exportFromRe = /export\s+.*\s+from\s+["']([^"']+)["']/g;

    const matches = [
      ...content.matchAll(importFromRe),
      ...content.matchAll(importOnlyRe),
      ...content.matchAll(requireRe),
      ...content.matchAll(exportFromRe),
    ];

    for (const m of matches) {
      let target = m[1];
      if (!target.startsWith(".")) continue; // skip node_modules/internal

      // Resolve relative path
      try {
        let abs = path.resolve(dir, target);
        // Try to add extensions if missing
        if (!fs.existsSync(abs)) {
          for (const e of [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]) {
            if (fs.existsSync(abs + e)) { abs += e; break; }
            if (fs.existsSync(path.join(abs, "index" + e))) { abs = path.join(abs, "index" + e); break; }
          }
        }
        
        if (fs.existsSync(abs)) {
          const rel = path.relative(projectRoot, abs);
          rels.push({ target: rel, type: m[0].startsWith("export") ? "export_from" : "import" });
        }
      } catch { /* skip invalid paths */ }
    }
  } else if (ext === ".py") {
    // from .path import foo
    const pyFromRe = /^from\s+\.([\w.]+)\s+import/gm;
    // import .path
    const pyImportRe = /^import\s+\.([\w.]+)/gm;

    for (const m of content.matchAll(pyFromRe)) {
      const target = m[1].replace(/\./g, "/") + ".py";
      rels.push({ target, type: "import" });
    }
    for (const m of content.matchAll(pyImportRe)) {
      const target = m[1].replace(/\./g, "/") + ".py";
      rels.push({ target, type: "import" });
    }
  }

  // Deduplicate by target
  const seen = new Set();
  return rels.filter(r => {
    if (seen.has(r.target)) return false;
    seen.add(r.target);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Hash — fast file-change detection
// ---------------------------------------------------------------------------

function fileHash(content) {
  return crypto.createHash("md5")
    .update(content.slice(0, 8192))
    .update(`\x00parser-v${PARSER_VERSION}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Initialize symbol + synthesis tables.
 * Safe to call on existing DB (IF NOT EXISTS).
 */
export function initSymbolTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbols (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path  TEXT NOT NULL,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      signature  TEXT,
      line       INTEGER NOT NULL,
      doc        TEXT,
      file_hash  TEXT NOT NULL,
      indexed_at INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_sym_proj ON symbols(project_id);
    CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(project_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_sym_kind ON symbols(project_id, kind);

    CREATE TABLE IF NOT EXISTS file_relationships (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      source_file  TEXT NOT NULL,
      target_file  TEXT NOT NULL,
      type         TEXT NOT NULL, -- 'import', 'export_from', 'reference'
      metadata     TEXT DEFAULT '{}',
      UNIQUE(project_id, source_file, target_file, type)
    );

    CREATE INDEX IF NOT EXISTS idx_rel_source ON file_relationships(project_id, source_file);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON file_relationships(project_id, target_file);
  `);
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

const _insertSym = new WeakMap(); // db → prepared statement cache

function getInsert(db) {
  if (!_insertSym.has(db)) {
    _insertSym.set(db, db.prepare(`
      INSERT OR REPLACE INTO symbols
        (id, project_id, file_path, name, kind, signature, line, doc, file_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `));
  }
  return _insertSym.get(db);
}

/**
 * Index a single file's symbols.
 * Skips if file hash is unchanged (idempotent).
 *
 * Returns { added, removed, skipped }.
 */
export function indexFileSymbols(db, projectId, filePath, projectRoot) {
  const ext = path.extname(filePath).toLowerCase();
  if (!PARSEABLE_EXTENSIONS.has(ext)) return { added: 0, removed: 0, skipped: true };

  let content;
  try { content = fs.readFileSync(filePath, "utf-8"); }
  catch { return { added: 0, removed: 0, skipped: true }; }

  const relPath = path.relative(projectRoot, filePath);
  const hash = fileHash(content);

  // Check if any existing symbol for this file has the same hash
  const existing = db.prepare(
    `SELECT file_hash FROM symbols WHERE project_id = ? AND file_path = ? LIMIT 1`
  ).get(projectId, relPath);

  if (existing?.file_hash === hash) return { added: 0, removed: 0, skipped: true };

  // Delete old symbols and relationships for this file
  const removed = db.prepare(
    `DELETE FROM symbols WHERE project_id = ? AND file_path = ?`
  ).run(projectId, relPath).changes;

  db.prepare(
    `DELETE FROM file_relationships WHERE project_id = ? AND source_file = ?`
  ).run(projectId, relPath);

  const parsed = parseFile(content, filePath);
  const rels = extractRelationships(content, filePath, projectRoot);

  const insert = getInsert(db);
  const insertRel = db.prepare(`
    INSERT OR REPLACE INTO file_relationships
      (id, project_id, source_file, target_file, type, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((syms, relationships) => {
    for (const s of syms) {
      const id = `sym-${crypto.createHash("md5")
        .update(`${projectId}:${relPath}:${s.name}:${s.line}`)
        .digest("hex").slice(0, 16)}`;
      insert.run(id, projectId, relPath, s.name, s.kind, s.signature, s.line, s.doc || null, hash);
    }
    for (const r of relationships) {
      const id = `rel-${crypto.createHash("md5")
        .update(`${projectId}:${relPath}:${r.target}:${r.type}`)
        .digest("hex").slice(0, 16)}`;
      insertRel.run(id, projectId, relPath, r.target, r.type, "{}");
    }
  });

  insertMany(parsed, rels);
  return { added: parsed.length, removed, skipped: false };
}

/**
 * Remove all symbols and relationships for a file that has been deleted.
 * Called from the file watcher's unlink path for immediate cleanup.
 *
 * @param {object} db - better-sqlite3 database
 * @param {string} projectId
 * @param {string} filePath - absolute path to the deleted file
 * @param {string} projectRoot
 * @returns {{ removed: number }} count of symbol rows deleted
 */
export function removeFileFromSymbolIndex(db, projectId, filePath, projectRoot) {
  const relPath = path.relative(projectRoot, filePath);
  const removed = db.prepare(
    `DELETE FROM symbols WHERE project_id = ? AND file_path = ?`
  ).run(projectId, relPath).changes;

  db.prepare(
    `DELETE FROM file_relationships WHERE project_id = ? AND (source_file = ? OR target_file = ?)`
  ).run(projectId, relPath, relPath);

  return { removed };
}

/**
 * Walk and index all parseable files in a project.
 * Reuses brain-engine's walkFn to respect the same skip rules.
 *
 * @param {Function} walkFn - walkProjectFiles from brain-engine
 */
export function indexProjectSymbols(db, projectId, projectRoot, walkFn) {
  const files = walkFn(projectRoot).filter(f =>
    PARSEABLE_EXTENSIONS.has(path.extname(f).toLowerCase())
  );

  let added = 0, skipped = 0, files_changed = 0;

  for (const filePath of files) {
    const result = indexFileSymbols(db, projectId, filePath, projectRoot);
    if (result.skipped) {
      skipped++;
    } else {
      added += result.added;
      files_changed++;
    }
  }

  // Reconciliation: delete symbols + relationships for files that no longer exist.
  // Without this, deleted files (schema-init.ts, packages/sync, etc.) leave
  // phantom rows that make explore/compass/find_symbol return ghost results.
  const orphaned = reconcileDeletedFiles(db, projectId, projectRoot, files);
  if (orphaned > 0) {
    console.log(`[symbol-index] ${projectId}: removed ${orphaned} orphaned file(s) from index`);
  }

  console.log(`[symbol-index] ${projectId}: ${added} symbols across ${files_changed} changed files (${skipped} unchanged${orphaned > 0 ? `, ${orphaned} deleted` : ""})`);
  return { added, skipped, files_changed, orphaned };
}

/**
 * Delete symbols and file_relationships entries for files that have been
 * removed from the filesystem. Called after a full project walk.
 *
 * @param {object} db - better-sqlite3 database
 * @param {string} projectId
 * @param {string} projectRoot
 * @param {string[]} currentFiles - absolute paths returned by the walk
 * @returns {number} count of orphaned files cleaned up
 */
function reconcileDeletedFiles(db, projectId, projectRoot, currentFiles) {
  // Build a set of relative paths that currently exist
  const currentRelPaths = new Set(
    currentFiles.map(f => path.relative(projectRoot, f))
  );

  // Find all distinct file_paths in the symbols table for this project
  const knownPaths = db.prepare(
    `SELECT DISTINCT file_path FROM symbols WHERE project_id = ?`
  ).all(projectId).map(r => r.file_path);

  let orphaned = 0;
  const deleteSymbols = db.prepare(
    `DELETE FROM symbols WHERE project_id = ? AND file_path = ?`
  );
  const deleteRelationships = db.prepare(
    `DELETE FROM file_relationships WHERE project_id = ? AND (source_file = ? OR target_file = ?)`
  );

  const purge = db.transaction((orphans) => {
    for (const relPath of orphans) {
      deleteSymbols.run(projectId, relPath);
      deleteRelationships.run(projectId, relPath, relPath);
      orphaned++;
    }
  });

  const orphans = knownPaths.filter(p => !currentRelPaths.has(p));
  if (orphans.length > 0) {
    purge(orphans);
  }

  return orphaned;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find symbols by name query, kind filter, or file filter.
 * Fuzzy name match: exact > prefix > contains > file/doc match.
 *
 * @returns Symbol rows sorted by relevance.
 */
export function findSymbols(db, projectId, query, { kind, file, limit = 20 } = {}) {
  const scopeIds = resolveProjectScope(projectId);
  let sql = `SELECT * FROM symbols WHERE project_id IN (${scopeIds.map(() => "?").join(",")})`;
  const params = [...scopeIds];

  if (kind)  { sql += ` AND kind = ?`;            params.push(kind); }
  if (file)  { sql += ` AND file_path LIKE ?`;    params.push(`%${file}%`); }

  sql += ` ORDER BY name COLLATE NOCASE LIMIT 500`;
  const rows = db.prepare(sql).all(...params);

  if (!query) return rows.slice(0, limit);

  const q = query.toLowerCase();
  const scored = rows.map(r => {
    const n = r.name.toLowerCase();
    let score = 0;
    if (n === q)              score = 1.0;
    else if (n.startsWith(q)) score = 0.8;
    else if (n.includes(q))   score = 0.6;
    else if (r.file_path.toLowerCase().includes(q)) score = 0.3;
    else if (r.doc?.toLowerCase().includes(q))      score = 0.2;
    return score > 0 ? { ...r, score } : null;
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * All symbols in a specific file (by relative path or partial path).
 */
export function getFileSymbols(db, projectId, filePath) {
  return db.prepare(
    `SELECT * FROM symbols WHERE project_id = ? AND file_path = ? ORDER BY line ASC`
  ).all(projectId, filePath);
}

/**
 * Resolve a list of exact symbol names to their locations.
 * Used for the symbol map injected into compileContext.
 */
export function resolveSymbolNames(db, projectId, names) {
  if (!names || names.length === 0) return [];
  const scopeIds = resolveProjectScope(projectId);
  const ph = names.map(() => "?").join(",");
  return db.prepare(
    `SELECT name, kind, file_path, line, doc FROM symbols
     WHERE project_id IN (${scopeIds.map(() => "?").join(",")}) AND name IN (${ph})
     ORDER BY name COLLATE NOCASE`
  ).all(...scopeIds, ...names);
}

/**
 * Extract likely symbol names from a user message.
 *
 * Looks for:
 *   - PascalCase:        MyComponent
 *   - camelCase:         handleSubmit
 *   - SCREAMING_SNAKE:   MAX_RETRIES
 *   - backtick-quoted:   `functionName`
 *
 * Returns up to 12 deduplicated candidates.
 */
export function extractSymbolNames(text) {
  const candidates = new Set();

  // Backtick-quoted identifiers first — highest confidence
  const backtick = text.match(/`(\w+)`/g) || [];
  for (const b of backtick) candidates.add(b.replace(/`/g, ""));

  // PascalCase / camelCase / SCREAMING_SNAKE
  const idents = text.match(/\b[A-Z][a-zA-Z0-9]{2,}|[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]+)+|[A-Z][A-Z0-9_]{2,}\b/g) || [];
  for (const w of idents) {
    if (!SYMBOL_STOPWORDS.has(w)) candidates.add(w);
  }

  return [...candidates].slice(0, 12);
}

/**
 * Find symbols relevant to a query.
 * Combines name extraction + fuzzy DB lookup.
 * Returns up to 8 matches.
 */
export function findRelevantSymbols(db, projectId, query) {
  if (!db || !projectId || !query) return [];

  try {
    const names = extractSymbolNames(query);
    if (names.length === 0) return [];

    // Resolve exact names first
    const exact = resolveSymbolNames(db, projectId, names);

    // For names not found exactly, try fuzzy
    const foundNames = new Set(exact.map(r => r.name));
    const fuzzyResults = [];
    for (const name of names) {
      if (!foundNames.has(name)) {
        const hits = findSymbols(db, projectId, name, { limit: 2 });
        fuzzyResults.push(...hits);
      }
    }

    // Merge, deduplicate by name
    const seen = new Set();
    const all = [...exact, ...fuzzyResults].filter(r => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    });

    return all.slice(0, 8);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Export (filesystem, for MCP server)
// ---------------------------------------------------------------------------

/**
 * Write compact symbol list to ~/.pane/brain/symbols/{projectId}.json
 * MCP server reads this for pane_find_symbol.
 */
export function writeSymbolExport(db, projectId, exportDir) {
  try {
    const rows = db.prepare(
      `SELECT name, kind, file_path AS file, line, doc FROM symbols
       WHERE project_id = ?
       ORDER BY name COLLATE NOCASE`
    ).all(projectId);

    const outPath = path.join(exportDir, "symbols", `${projectId}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ symbols: rows, written: Date.now() }));
  } catch (err) {
    console.error(`[symbol-index] export error for ${projectId}:`, err.message);
  }
}


