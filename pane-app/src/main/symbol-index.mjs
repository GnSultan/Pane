/**
 * Pane Symbol Index — zero-cost structural awareness.
 *
 * Regex parse of exports → SQLite.
 * No LLM. No embeddings. Fast lookup, always current.
 *
 * Layer 1 of the intelligence stack:
 *   "Where is the function that handles IPC routing?" → answered in <1ms.
 *
 * Layer 3 (Synthesis) is also here:
 *   synthesizeProjectDNA() → compact narrative from decisions/lessons/patterns.
 *   No LLM. Pure DB extraction. Called by brain-engine after indexing.
 *
 * Tables owned:
 *   symbols   — one row per exported symbol (name, kind, file, line, signature, doc)
 *   syntheses — cached project DNA narratives keyed by (projectId, kind)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isSignalNoise } from "./signal-filters.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
 */
function parseTS(content) {
  const lines = content.split("\n");
  const symbols = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("export")) continue;

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

    CREATE TABLE IF NOT EXISTS syntheses (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      content      TEXT NOT NULL,
      source_hash  TEXT NOT NULL,
      generated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, kind)
    );
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

  console.log(`[symbol-index] ${projectId}: ${added} symbols across ${files_changed} changed files (${skipped} unchanged)`);
  return { added, skipped, files_changed };
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
  let sql = `SELECT * FROM symbols WHERE project_id = ?`;
  const params = [projectId];

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
  const ph = names.map(() => "?").join(",");
  return db.prepare(
    `SELECT name, kind, file_path, line, doc FROM symbols
     WHERE project_id = ? AND name IN (${ph})
     ORDER BY name COLLATE NOCASE`
  ).all(projectId, ...names);
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

// ---------------------------------------------------------------------------
// Synthesis — Layer 3: Causal Memory
// ---------------------------------------------------------------------------

/**
 * Synthesize project DNA from brain nodes.
 *
 * Pure DB extraction — no LLM, no embeddings.
 * Pulls high-confidence decisions, lessons, patterns, error_fixes and
 * formats them into a compact narrative (<400 tokens).
 *
 * This is the "prefrontal cortex" layer:
 *   "We rejected Redux because Zustand Map references cause enough pain already."
 *   "Design rules forbid borders on inputs — decided after 3 iterations."
 *
 * @returns Synthesis text, or null if nothing to synthesize.
 */
export function synthesizeProjectDNA(db, projectId) {
  if (!db) return null;

  const extract = row => {
    try { return JSON.parse(row.content)?.text || row.content; }
    catch { return row.content; }
  };

  const decisions = db.prepare(`
    SELECT content, confidence FROM nodes
    WHERE project_id = ? AND entity_type = 'decision' AND confidence >= 0.70
    ORDER BY confidence DESC, access_count DESC LIMIT 12
  `).all(projectId);

  const patterns = db.prepare(`
    SELECT content, confidence FROM nodes
    WHERE project_id = ? AND entity_type = 'pattern' AND confidence >= 0.70
    ORDER BY confidence DESC LIMIT 8
  `).all(projectId);

  const lessons = db.prepare(`
    SELECT content, confidence FROM nodes
    WHERE project_id = ? AND entity_type = 'lesson' AND confidence >= 0.72
    ORDER BY confidence DESC LIMIT 8
  `).all(projectId);

  const fixes = db.prepare(`
    SELECT content, confidence FROM nodes
    WHERE project_id = ? AND entity_type = 'error_fix' AND confidence >= 0.70
    ORDER BY confidence DESC LIMIT 6
  `).all(projectId);

  const total = decisions.length + patterns.length + lessons.length + fixes.length;
  if (total === 0) return null;

  const parts = [];

  if (decisions.length > 0) {
    parts.push("Architectural decisions:");
    for (const d of decisions) {
      const text = extract(d);
      if (text && !isSignalNoise(text)) parts.push(`- ${text}`);
    }
  }

  if (patterns.length > 0) {
    parts.push("\nEstablished patterns:");
    for (const p of patterns) {
      const text = extract(p);
      if (text && !isSignalNoise(text)) parts.push(`- ${text}`);
    }
  }

  if (lessons.length > 0) {
    parts.push("\nLessons learned:");
    for (const l of lessons) {
      const text = extract(l);
      if (text && !isSignalNoise(text)) parts.push(`- ${text}`);
    }
  }

  if (fixes.length > 0) {
    // Only emit the anti-patterns section if the majority of fix nodes contain
    // genuine behavioral signal — not transient tool errors.
    const fixTexts = fixes.map(f => extract(f)).filter(Boolean);
    const noiseCount = fixTexts.filter(isSignalNoise).length;
    const signalRatio = fixTexts.length > 0 ? (fixTexts.length - noiseCount) / fixTexts.length : 0;
    if (signalRatio > 0.5) {
      parts.push("\nKnown anti-patterns (do not repeat):");
      for (const text of fixTexts) {
        if (!isSignalNoise(text)) parts.push(`- ${text}`);
      }
    }
  }

  const joined = parts.join("\n");
  // If the entire synthesis is predominantly noise (>50% of non-header lines match
  // error/fix patterns), suppress it entirely rather than injecting it.
  const contentLines = joined.split("\n").filter(l => l.startsWith("- "));
  if (contentLines.length === 0) return null;
  const noisy = contentLines.filter(l => isSignalNoise(l.slice(2)));
  if (noisy.length / contentLines.length > 0.5) return null;

  return joined;
}

/**
 * Regenerate and store synthesis if source nodes have changed.
 * Idempotent — only writes if content hash changes.
 *
 * @returns Synthesis text, or null.
 */
export function updateSynthesis(db, projectId) {
  const text = synthesizeProjectDNA(db, projectId);
  if (!text) return null;

  const hash = crypto.createHash("md5").update(text).digest("hex").slice(0, 16);

  // Check if unchanged
  const existing = db.prepare(
    `SELECT source_hash FROM syntheses WHERE project_id = ? AND kind = 'dna'`
  ).get(projectId);

  if (existing?.source_hash === hash) return text; // no change

  db.prepare(`
    INSERT OR REPLACE INTO syntheses (id, project_id, kind, content, source_hash, generated_at)
    VALUES (?, ?, 'dna', ?, ?, unixepoch())
  `).run(`syn-${projectId}-dna`, projectId, text, hash);

  return text;
}

/**
 * Read cached synthesis. Returns null if not available.
 */
export function readSynthesis(db, projectId) {
  if (!db) return null;
  try {
    const row = db.prepare(
      `SELECT content FROM syntheses WHERE project_id = ? AND kind = 'dna'`
    ).get(projectId);
    return row?.content || null;
  } catch {
    return null;
  }
}
