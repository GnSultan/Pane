// Pane Brain Engine — UtilityProcess that owns the knowledge graph, embeddings, and semantic search.
// Isolated V8 — if the brain crashes, Pane and Claude keep working.
// Same pattern as claude-worker.mjs and pty-worker.mjs.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { runMemoryLifecycle, touchMemory, reinforceMemory } from "./memory-lifecycle.mjs";
import { isSignalNoise } from "./signal-filters.mjs";

import {
  initSymbolTables,
  indexFileSymbols,
  indexProjectSymbols,
  findSymbols,
  findRelevantSymbols,
  getFileSymbols,
  writeSymbolExport,
} from "./symbol-index.mjs";
import { FACET_WEIGHTS } from "./system-atoms.mjs";

// Local embedding model via @huggingface/transformers + onnxruntime-node.
// onnxruntime-node is auto-detected by transformers.js when both are installed.
import { pipeline } from "@huggingface/transformers";

const BRAIN_DIR = path.join(os.homedir(), ".pane", "brain");
const MEMORY_DIR = path.join(os.homedir(), ".pane", "memory");
const PROFILE_DIR = path.join(os.homedir(), ".pane", "profile");
const IDENTITY_CACHE_PATH = path.join(PROFILE_DIR, "compiled-identity.txt");
const EXPORTS_DIR = path.join(BRAIN_DIR, "exports");

const SESSION_DIR = path.join(os.homedir(), ".pane", "session");
/** Read session state for working set access. Returns null on any failure. */
function _readSessionState(projectId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, projectId, "state.json"), "utf-8"));
  } catch {
    return null;
  }
}

// --- State ---
let db = null;
let embedderLoading = false;
let embedderReady = false;
let _embedPipeline = null; // pipeline('feature-extraction') instance
let _embedderLoadPromise = null; // Lazy init: shared promise so concurrent callers await the same load

// Local embedding model: bge-base-en-v1.5 via ONNX Runtime
// 768-dim, ~63 MTEB, ~30ms on Apple Silicon, ~80ms on Intel Mac.
// Model auto-downloads from HuggingFace on first pipeline() call.
const EMBEDDING_DIM = 768; // bge-base-en-v1.5 output dimension
const EMBED_MODEL = "Xenova/bge-base-en-v1.5";
const EMBED_CACHE_DIR = path.join(BRAIN_DIR, "models");


// Tracks which projects have completed a full initial index this session.
const indexedProjects = new Set();

// Tracks files that failed summarization during this session.
// Maps projectId -> Set of absolute file paths to retry on next call.
const failedFiles = new Map();

// --- File Summarization via LLM ---

// Skip files that are noise — not meaningful architectural signal.
const SKIP_EXTENSIONS = new Set([
  ".lock", ".log", ".map", ".min.js", ".min.css",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".dmg", ".exe",
  ".db", ".sqlite", ".sqlite3",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", "release",
  ".cache", ".parcel-cache", ".next", ".nuxt", "coverage",
  "__pycache__", ".venv", "venv", ".tox",
]);

const MEANINGFUL_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".rb", ".php", ".cs", ".cpp", ".c", ".h",
  ".vue", ".svelte",
  ".sh", ".bash",
  ".json", ".yaml", ".yml", ".toml",
  ".md", ".txt",
  ".sql",
]);

function shouldIndexFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return false;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  if (base === "package-lock.json" || base === "yarn.lock" || base === "pnpm-lock.yaml") return false;
  if (!MEANINGFUL_EXTENSIONS.has(ext)) return false;
  return true;
}

function walkProjectFiles(rootDir, maxFiles = 200) {
  const results = [];
  const queue = [rootDir];

  while (queue.length > 0 && results.length < maxFiles) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith(".")) continue; // skip hidden
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(fullPath);
      } else if (entry.isFile()) {
        if (shouldIndexFile(fullPath)) results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Codebase Compass — the structural and semantic guide for Pane.
 * 
 * Combines Layer 1 (symbols), Layer 2 (embeddings), and Layer 1.5 (file relationships)
 * to return a "neighborhood" of code relevant to the user's intent.
 */
async function findCodebaseCompass(query, projectId, projectRoot, limit = 8) {
  if (!db) return [];

  // 1. Semantic Hits (Layer 2)
  const semanticHits = await findRelevantFiles(query, projectId, 10);
  
  // 2. Structural Hits (Layer 1)
  const symbolHits = findRelevantSymbols(db, projectId, query);
  
  // 3. Spatial Expansion (Layer 1.5)
  // Find files that are direct neighbors of our semantic/structural hits
  const coreFiles = new Set([
    ...semanticHits.map(h => h.path),
    ...symbolHits.map(s => s.file_path || s.file)
  ]);

  const neighborhood = new Map(); // path -> { score, reasons }
  
  // Initialize neighborhood with core hits
  for (const h of semanticHits) {
    neighborhood.set(h.path, { score: h.score * 0.8, reasons: ["semantic match"] });
  }
  for (const s of symbolHits) {
    const p = s.file_path || s.file;
    const existing = neighborhood.get(p) || { score: 0, reasons: [] };
    existing.score += 0.4;
    existing.reasons.push(`contains symbol "${s.name}"`);
    neighborhood.set(p, existing);
  }

  // Expand to neighbors (1 level deep)
  const allCore = Array.from(coreFiles);
  for (const file of allCore) {
    const rels = db.prepare(`
      SELECT target_file, type FROM file_relationships 
      WHERE project_id = ? AND source_file = ?
      UNION
      SELECT source_file, type FROM file_relationships
      WHERE project_id = ? AND target_file = ?
    `).all(projectId, file, projectId, file);

    for (const rel of rels) {
      const neighbor = rel.target_file || rel.source_file;
      if (neighborhood.has(neighbor)) {
        neighborhood.get(neighbor).score += 0.15;
        neighborhood.get(neighbor).reasons.push(`connected to core hit "${file}"`);
      } else {
        neighborhood.set(neighbor, { 
          score: 0.25, 
          reasons: [`neighbor of core hit "${file}"`] 
        });
      }
    }
  }

  // Final ranking
  const results = Array.from(neighborhood.entries())
    .map(([path, data]) => ({
      path,
      score: data.score,
      reasons: Array.from(new Set(data.reasons)).slice(0, 3)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Add descriptions from DB
  for (const res of results) {
    const node = db.prepare(`SELECT content FROM nodes WHERE entity_type = 'file' AND name = ? AND project_id = ?`).get(res.path, projectId);
    if (node) {
      try {
        const content = JSON.parse(node.content);
        res.description = content.text?.split(".")[0] || "";
      } catch {}
    }
  }

  return results;
}

// --- LLM Summarization via main process relay ---
//
// The brain is a UtilityProcess — it can't call the backend directly.
// Instead it sends a "llm_call" message to main, which routes it through
// punkEngine.quickCall() — the same path used for commit drafts, summaries,
// and every other Pane-internal generation. Whatever backend + model the
// user has selected, that's what gets used. No hardcoded providers, no
// separate HTTP clients, no provider chains.

let _llmCallId = 0;
const _llmPending = new Map(); // callId → { resolve, reject }

/**
 * Ask the user's current backend to generate text. Returns the response
 * string, or null on any failure. Timeout: 60s (CLI cold starts are slow).
 */
function llmCall(systemPrompt, userPrompt) {
  return new Promise((resolve) => {
    const callId = `llm-${++_llmCallId}`;
    const timeout = setTimeout(() => {
      _llmPending.delete(callId);
      console.warn(`[brain] LLM call timed out (${callId})`);
      resolve(null);
    }, 60000);

    _llmPending.set(callId, { resolve, timeout });
    sendToMain({ type: "llm_call", callId, systemPrompt, userPrompt });
  });
}

/** Called by the message handler when main sends back an llm_call_result. */
function _handleLlmCallResult(callId, result) {
  const pending = _llmPending.get(callId);
  if (!pending) return;
  _llmPending.delete(callId);
  clearTimeout(pending.timeout);
  pending.resolve(result || null);
}

/**
 * Ask the LLM to describe a file in 2-3 sentences.
 * Routes through main → quickCall → user's active backend + model.
 * Returns the description string, or null on failure.
 */
async function summarizeFile(filePath, projectRoot) {
  let fileContent;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    fileContent = raw.split("\n").slice(0, 400).join("\n");
  } catch {
    return null;
  }

  if (fileContent.trim().length < 20) return null;

  const relativePath = path.relative(projectRoot, filePath);
  const systemPrompt = "You summarize code files. Provide clear, concise descriptions of the file's role and responsibilities. No preamble, just the description.";
  const userPrompt = [
    `File: ${relativePath}`,
    ``,
    `\`\`\``,
    fileContent.slice(0, 8000),
    `\`\`\``,
    ``,
    `Describe what this file does in 2-3 sentences. Be specific about its role in the codebase — mention key responsibilities, what it owns, and how it relates to other parts of the system.`,
  ].join("\n");

  try {
    const result = await llmCall(systemPrompt, userPrompt);
    if (result && result.trim().length > 10) return result.trim();
    console.warn(`[brain] LLM returned empty for ${relativePath}`);
    return null;
  } catch (err) {
    console.warn(`[brain] LLM call failed for ${relativePath}: ${err.message}`);
    return null;
  }
}

/**
 * Walk the project, summarize each unindexed file, store as 'file' nodes.
 * Runs in the background — safe to call fire-and-forget.
 */
async function indexProjectFiles(projectId, projectRoot) {
  if (!db) return;

  // Determine which files to attempt this run:
  // - First call for this project this session: full walk minus already-indexed
  // - Subsequent calls: only files that failed last time (mid-session retry)
  let toIndex;
  const pending = failedFiles.get(projectId);

  if (!indexedProjects.has(projectId)) {
    // Initial pass — walk the project tree
    indexedProjects.add(projectId);

    const files = walkProjectFiles(projectRoot);
    if (files.length === 0) return;

    // Compare each file's mtime against what's stored in the DB.
    // Re-index if: (a) never indexed, or (b) file modified since last index.
    const existingNodes = db.prepare(
      `SELECT name, content FROM nodes WHERE entity_type = 'file' AND project_id = ?`
    ).all(projectId);

    // Build map: relativePath -> stored mtime
    const storedMtimes = new Map();
    for (const node of existingNodes) {
      try {
        const c = JSON.parse(node.content || "{}");
        if (c.mtime) storedMtimes.set(node.name, c.mtime);
      } catch {}
    }

    toIndex = files.filter(f => {
      const rel = path.relative(projectRoot, f);
      const stored = storedMtimes.get(rel);
      if (!stored) return true; // Never indexed
      try {
        const mtime = fs.statSync(f).mtimeMs;
        return mtime > stored; // Modified since last index
      } catch {
        return false; // Can't stat — skip
      }
    });

    const changedCount = toIndex.filter(f => storedMtimes.has(path.relative(projectRoot, f))).length;
    const newCount = toIndex.length - changedCount;

    if (toIndex.length === 0) {
      console.log(`[brain] All ${files.length} files up to date for ${projectId}`);
      return;
    }
    console.log(`[brain] Indexing ${toIndex.length} files for ${projectId} (${newCount} new, ${changedCount} changed) via quickCall relay`);
  } else if (pending && pending.size > 0) {
    // Retry pass — only files that failed last time
    toIndex = Array.from(pending);
    console.log(`[brain] Retrying ${toIndex.length} previously failed files for ${projectId}`);
    pending.clear(); // Clear before re-attempt so new failures repopulate cleanly
  } else {
    return; // Already indexed, nothing failed — nothing to do
  }

  let indexed = 0;
  let consecutiveFailures = 0;
  const nowFailed = failedFiles.get(projectId) || new Set();
  failedFiles.set(projectId, nowFailed);

  for (const filePath of toIndex) {
    const relativePath = path.relative(projectRoot, filePath);
    const description = await summarizeFile(filePath, projectRoot);

    if (!description) {
      nowFailed.add(filePath); // Remember for mid-session retry
      consecutiveFailures++;
      // If 5+ files fail in a row, the provider is likely down or rate-limited.
      // Bail out early — remaining files will be retried on next request.
      if (consecutiveFailures >= 5) {
        console.warn(`[brain] ${consecutiveFailures} consecutive failures — aborting batch. ${toIndex.length - indexed - consecutiveFailures} files deferred.`);
        for (const remaining of toIndex.slice(toIndex.indexOf(filePath) + 1)) {
          nowFailed.add(remaining);
        }
        break;
      }
      continue;
    }

    consecutiveFailures = 0; // Reset on success

    const id = nodeId("file", relativePath);
    const embedding = await embed(description);
    const embeddingBuffer = embedding ? Buffer.from(embedding.buffer) : null;

    // Store mtime so we can detect changes on future startups
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch {}

    try {
      db.prepare(`
        INSERT INTO nodes (id, name, entity_type, project_id, content, embedding, confidence, version)
        VALUES (?, ?, 'file', ?, ?, ?, 1.0, 1)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          embedding = excluded.embedding,
          updated_at = datetime('now')
      `).run(id, relativePath, projectId, JSON.stringify({ text: description, path: filePath, mtime }), embeddingBuffer);
      indexed++;
      nowFailed.delete(filePath); // Successfully indexed — remove from failed set
    } catch (err) {
      console.error(`[brain] Failed to store file node for ${relativePath}:`, err.message);
      nowFailed.add(filePath);
    }

    // Small delay between requests to avoid rate-limiting
    await new Promise(r => setTimeout(r, 150));
  }

  const stillFailing = nowFailed.size;
  console.log(`[brain] Indexed ${indexed}/${toIndex.length} files for ${projectId}${
    stillFailing > 0 ? ` (${stillFailing} failed, will retry on next request)` : ""
  }`);
}

/**
 * Semantic search over indexed file nodes for a project.
 * Returns files most relevant to the query, sorted by similarity.
 */
async function findRelevantFiles(query, projectId, limit = 5) {
  if (!db) return [];

  const fileNodes = db.prepare(
    `SELECT * FROM nodes WHERE entity_type = 'file' AND project_id = ? AND embedding IS NOT NULL`
  ).all(projectId);

  if (fileNodes.length === 0) return [];

  // If embedder ready: semantic search. Otherwise: keyword fallback.
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  const queryEmbedding = embedderReady ? await embed(query) : null;
  const results = [];

  for (const node of fileNodes) {
    const content = JSON.parse(node.content || "{}");
    const description = content.text || "";
    const filePath = node.name; // relative path

    let score = 0;

    if (queryEmbedding && node.embedding) {
      const nodeEmb = new Float32Array(node.embedding.buffer, node.embedding.byteOffset, node.embedding.byteLength / 4);
      score = cosineSimilarity(queryEmbedding, nodeEmb);
    } else {
      // Keyword fallback: score by path + description word match
      const text = (filePath + " " + description).toLowerCase();
      score = queryWords.length > 0
        ? queryWords.filter(w => text.includes(w)).length / queryWords.length
        : 0;
    }

    if (score > 0.3) {
      results.push({
        path: filePath,
        description,
        score,
        confidence: node.confidence,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --- Communication with main process ---
function sendToMain(message) {
  process.parentPort.postMessage(message);
}

// --- SQLite Setup ---

function initDatabase() {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  db = new Database(path.join(BRAIN_DIR, "brain.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      project_id TEXT,
      content TEXT DEFAULT '{}',
      embedding BLOB,
      confidence REAL DEFAULT 0.5,
      version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      priority REAL DEFAULT 0.5,
      sort_order INTEGER DEFAULT 0,
      facet TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES nodes(id),
      target_id TEXT NOT NULL REFERENCES nodes(id),
      type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      evidence TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, type)
    );

    CREATE TABLE IF NOT EXISTS node_versions (
      node_id TEXT NOT NULL REFERENCES nodes(id),
      version INTEGER NOT NULL,
      content TEXT,
      confidence REAL,
      change_reason TEXT,
      diff TEXT,
      changed_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (node_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(entity_type);
    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_confidence ON nodes(confidence);
    CREATE INDEX IF NOT EXISTS idx_nodes_facet ON nodes(facet);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
  `);

  // Symbol index + synthesis tables (Layer 1 + Layer 3)
  initSymbolTables(db);

  // Mind entries — separate exec so it runs cleanly as a migration on existing DBs
  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_entries (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      embedding BLOB,
      project_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mind_created ON mind_entries(created_at);
    CREATE INDEX IF NOT EXISTS idx_mind_project ON mind_entries(project_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_threads (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mind_threads_entry ON mind_threads(entry_id);
    CREATE TABLE IF NOT EXISTS mind_turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mind_turns_thread ON mind_turns(thread_id);
  `);

  // Lens posts — chronological feed for user + worker observations
  db.exec(`
    CREATE TABLE IF NOT EXISTS lens_posts (
      id TEXT PRIMARY KEY,
      contributor TEXT NOT NULL,
      content TEXT NOT NULL,
      project_id TEXT,
      entry_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lens_project ON lens_posts(project_id);
  `);

  // Lens comments — threaded replies per post
  db.exec(`
    CREATE TABLE IF NOT EXISTS lens_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lens_comments_post ON lens_comments(post_id);
  `);

  // Review sessions — on-demand punk analysis sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_sessions (
      id           TEXT    PRIMARY KEY,
      project_id   TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'running',
      diff_summary TEXT,
      base_ref     TEXT,
      punk_count   INTEGER NOT NULL DEFAULT 0,
      finding_count INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_review_sessions_project
      ON review_sessions(project_id, created_at);
  `);

  // Punk findings — structured results from each punk per review session
  db.exec(`
    CREATE TABLE IF NOT EXISTS punk_findings (
      id         TEXT    PRIMARY KEY,
      session_id TEXT    NOT NULL,
      project_id TEXT    NOT NULL,
      punk       TEXT    NOT NULL,
      severity   TEXT    NOT NULL,
      finding    TEXT    NOT NULL,
      structured TEXT    NOT NULL,
      location   TEXT,
      dismissed  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_findings_session ON punk_findings(session_id);
    CREATE INDEX IF NOT EXISTS idx_findings_project ON punk_findings(project_id, created_at);
  `);

  // Safe migration: add dismissed column if missing (v1.2)
  // ALTER TABLE ADD COLUMN fails with SQLITE_ERROR on fresh DBs where the column
  // already exists as part of CREATE TABLE. That's expected — no migration needed.
  try { db.exec(`ALTER TABLE punk_findings ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_undismissed ON punk_findings(project_id, dismissed, created_at)`); } catch {}

  // Prepare statements for hot paths
  db._stmts = {
    insertNode: db.prepare(`
      INSERT INTO nodes (id, name, entity_type, project_id, content, embedding, confidence, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO NOTHING
    `),
    getNode: db.prepare(`SELECT * FROM nodes WHERE id = ?`),
    getNodeByContent: db.prepare(`
      SELECT * FROM nodes WHERE entity_type = ? AND project_id = ? AND name = ?
    `),
    updateNodeVersion: db.prepare(`
      UPDATE nodes SET version = version + 1, confidence = ?, updated_at = datetime('now'), content = ?
      WHERE id = ?
    `),
    bumpAccess: db.prepare(`
      UPDATE nodes SET access_count = access_count + 1, updated_at = datetime('now') WHERE id = ?
    `),
    insertEdge: db.prepare(`
      INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, evidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertVersion: db.prepare(`
      INSERT INTO node_versions (node_id, version, content, confidence, change_reason, diff)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getNodesByProject: db.prepare(`SELECT * FROM nodes WHERE project_id = ?`),
    getNodesByType: db.prepare(`SELECT * FROM nodes WHERE entity_type = ? AND project_id = ?`),
    getAllProjectNodes: db.prepare(`SELECT * FROM nodes WHERE project_id = ?`),
    getEdgesFor: db.prepare(`
      SELECT e.*, n1.name as source_name, n2.name as target_name
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.source_id = ? OR e.target_id = ?
    `),
    getStats: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) as node_count,
        (SELECT COUNT(*) FROM edges) as edge_count,
        (SELECT COUNT(*) FROM node_versions) as version_count
    `),
    // Phase 5: cross-project and outcome tracking
    getHighConfidenceNodes: db.prepare(`
      SELECT * FROM nodes
      WHERE project_id != ? AND confidence > 0.7 AND embedding IS NOT NULL
      AND entity_type IN ('decision', 'lesson', 'pattern', 'error_fix')
    `),
    getAllProjects: db.prepare(`SELECT DISTINCT project_id FROM nodes WHERE project_id IS NOT NULL AND entity_type = 'project'`),
    getRecentDecisions: db.prepare(`
      SELECT * FROM nodes
      WHERE project_id = ? AND entity_type = 'decision' AND embedding IS NOT NULL
      ORDER BY created_at DESC LIMIT 20
    `),
    lowerConfidence: db.prepare(`
      UPDATE nodes SET confidence = MAX(0.1, confidence - ?), updated_at = datetime('now') WHERE id = ?
    `),
    boostConfidence: db.prepare(`
      UPDATE nodes SET confidence = MIN(0.95, confidence + ?), updated_at = datetime('now') WHERE id = ?
    `),
    getStaleNodes: db.prepare(`
      SELECT id, confidence, updated_at FROM nodes
      WHERE project_id = ? AND confidence > 0.2
      AND updated_at < datetime('now', ?)
    `),
    pruneLowConfidence: db.prepare(`
      DELETE FROM nodes WHERE project_id = ? AND confidence < ? AND entity_type NOT IN ('project', 'file')
    `),
    pruneOldVersions: db.prepare(`
      DELETE FROM node_versions WHERE node_id NOT IN (SELECT id FROM nodes)
    `),
    countNodesByProject: db.prepare(`SELECT COUNT(*) AS cnt FROM nodes WHERE project_id = ?`),
  };
}

// --- Embedder (Local ONNX via @huggingface/transformers) ---
//
// Uses bge-base-en-v1.5 via @huggingface/transformers + onnxruntime-node.
// First call downloads the model (~40MB) from HuggingFace to ~/.pane/brain/models/.
// Subsequent calls load from disk in ~50ms. Inference: ~30ms on Apple Silicon, ~80ms on Intel.
// No API keys, no network, no rate limits.

async function loadEmbedder() {
  if (embedderReady || embedderLoading) return;
  embedderLoading = true;

  try {
    // Ensure model cache directory exists
    fs.mkdirSync(EMBED_CACHE_DIR, { recursive: true });

    console.log(`[brain] Loading embedding model (${EMBED_MODEL})...`);

    // Create feature-extraction pipeline.
    // First call downloads model files from HuggingFace (~40MB).
    // Subsequent calls load from EMIT_CACHE_DIR.
    // onnxruntime-node is auto-detected and used for native inference.
    _embedPipeline = await pipeline("feature-extraction", EMBED_MODEL, {
      quantized: false, // Full precision for best quality
      cache_dir: EMBED_CACHE_DIR,
    });

    // Verify with a test embed (direct pipeline call, not embed(), to avoid circular lazy-init)
    const testResult = await _embedPipeline("test", {
      pooling: "mean",
      normalize: true,
    });
    const testArr = new Float32Array(testResult.data);
    if (!testArr || testArr.length !== EMBEDDING_DIM) {
      throw new Error(`Expected ${EMBEDDING_DIM}-dim embedding, got ${testArr?.length ?? 0}`);
    }

    console.log(`[brain] Local embedding model ready (${EMBED_MODEL}, ${EMBEDDING_DIM} dim)`);
    embedderReady = true;
    sendToMain({ type: "embedder_ready" });

    // Index atoms + migrate old embeddings + fill null embeddings in background
    Promise.all([
      indexProfileAtoms().catch(err => console.error("[brain] Profile atom indexing failed:", err.message)),
      migrateEmbeddings().catch(err => console.error("[brain] Embedding migration failed:", err.message)),
      fillNullEmbeddings().catch(err => console.error("[brain] Null embedding fill failed:", err.message)),
    ]);
  } catch (err) {
    console.error("[brain] Local embedding model failed to load:", err.message);
    console.warn("[brain] Brain still works — semantic search will use keyword fallback");
    embedderLoading = false;
    _embedderLoadPromise = null; // Allow retry on next embed() call
  }
}

// --- WASM heap hygiene ---
let _embedCallCount = 0;
const EMBED_RECYCLE_INTERVAL = 500; // Recreate pipeline every N calls to reset WASM heap
const BATCH_SIZE = 32; // Texts per batch embed call

/**
 * Embed a single text string using the local ONNX model.
 * Returns a Float32Array of EMBEDDING_DIM dimensions, or null on failure.
 * Uses mean pooling + L2 normalization for cosine-similarity-ready vectors.
 */
async function embed(text) {
  // Lazy init: load embedder on first call instead of at startup
  if (!embedderReady || !_embedPipeline) {
    if (!_embedderLoadPromise) {
      _embedderLoadPromise = loadEmbedder().catch(err => {
        console.error(`[brain] Lazy embedder load failed: ${err.message}`);
        _embedderLoadPromise = null; // Reset so next call retries
      });
    }
    await _embedderLoadPromise;
    if (!embedderReady || !_embedPipeline) return null;
  }
  try {
    _embedCallCount++;
    if (_embedCallCount >= EMBED_RECYCLE_INTERVAL) {
      _embedCallCount = 0;
      await _recyclePipeline();
    }
    const result = await _embedPipeline(text, {
      pooling: "mean",
      normalize: true,
    });
    // result is a Tensor with shape [1, EMBEDDING_DIM]
    // Access the underlying Float32Array data
    return new Float32Array(result.data);
  } catch (err) {
    console.warn(`[brain] Embedding failed: ${err.message}`);
    return null;
  }
}

/**
 * Batch-embed many texts. Same model & params as embed(), but:
 *  - Processes texts in batches of BATCH_SIZE for WASM efficiency
 *  - Recycles the pipeline every EMBED_RECYCLE_INTERVAL calls to prevent heap growth
 *  - Returns a Map<string, Float32Array | null> keyed by text
 */
async function embedBatch(texts) {
  // Lazy init: load embedder on first call instead of at startup
  if (!embedderReady || !_embedPipeline) {
    if (!_embedderLoadPromise) {
      _embedderLoadPromise = loadEmbedder().catch(err => {
        console.error(`[brain] Lazy embedder load failed: ${err.message}`);
        _embedderLoadPromise = null;
      });
    }
    await _embedderLoadPromise;
    if (!embedderReady || !_embedPipeline || !texts.length) return new Map();
  }
  const results = new Map();
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    _embedCallCount += batch.length;
    if (_embedCallCount >= EMBED_RECYCLE_INTERVAL) {
      _embedCallCount = 0;
      await _recyclePipeline();
    }
    try {
      // Pipeline accepts an array for batched inference — returns Tensor with shape [N, DIM]
      const result = await _embedPipeline(batch, {
        pooling: "mean",
        normalize: true,
      });
      // result.data is a flat Float32Array of shape [batch.length, EMBEDDING_DIM]
      const flat = result.data;
      for (let j = 0; j < batch.length; j++) {
        const offset = j * EMBEDDING_DIM;
        if (offset + EMBEDDING_DIM <= flat.length) {
          results.set(batch[j], new Float32Array(flat.slice(offset, offset + EMBEDDING_DIM)));
        } else {
          results.set(batch[j], null);
        }
      }
    } catch (err) {
      console.warn(`[brain] Batch embed failed (${batch.length} texts): ${err.message}`);
      for (const t of batch) results.set(t, null);
    }
  }
  return results;
}

/**
 * Recreate the ONNX pipeline to release WASM heap memory.
 * onnxruntime-node's WASM allocator (emmalloc) never returns memory to the OS,
 * so intermediate tensor allocations accumulate and cannot be freed.
 * Recreating the pipeline resets the WASM heap to a clean state.
 */
async function _recyclePipeline() {
  if (!_embedPipeline) return;
  try {
    // Dispose old pipeline
    if (typeof _embedPipeline.dispose === "function") {
      await _embedPipeline.dispose();
    }
    // Remove references to allow GC
    _embedPipeline = null;
    // Recreate
    _embedPipeline = await pipeline("feature-extraction", EMBED_MODEL, {
      quantized: false,
      cache_dir: EMBED_CACHE_DIR,
    });
  } catch (err) {
    console.warn(`[brain] Pipeline recycle failed: ${err.message}`);
    // If recycle fails, mark embedder as not ready — next call will recreate
    embedderReady = false;
    _embedPipeline = null;
    _embedderLoadPromise = null; // Reset so embed() triggers a fresh lazy load
    // Try to reload after a delay
    setTimeout(() => {
      if (!embedderReady && !embedderLoading) {
        embedderLoading = false;
        loadEmbedder().catch(e => console.error("[brain] Recovery load failed:", e.message));
      }
    }, 5000);
  }
}

/** Force SQLite WAL checkpoint to release accumulated WAL pages. Call after batch DB writes. */
function _walCheckpoint() {
  if (!db) return;
  try {
    const info = db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Non-critical — best-effort
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Vectors are already normalized, so dot product = cosine similarity
}

/**
 * Migrate old-dimension embeddings to current EMBEDDING_DIM.
 * Handles 384-dim (all-MiniLM-L6-v2, 1536 bytes) and 1024-dim (Jina v3, 4096 bytes).
 * Also handles any other non-matching dimension as a catch-all.
 * Runs once on startup after embedder is ready.
 */
async function migrateEmbeddings() {
  if (!db || !embedderReady) return;

  const currentBytes = EMBEDDING_DIM * 4; // 3072 bytes for 768-dim

  const oldNodes = db.prepare(`
    SELECT id, content, name FROM nodes
    WHERE embedding IS NOT NULL AND LENGTH(embedding) != ?
    ORDER BY updated_at DESC
  `).all(currentBytes);

  if (oldNodes.length === 0) {
    console.log("[brain] All embeddings match current dimension");
    return;
  }

  console.log(`[brain] Migrating ${oldNodes.length} embeddings to ${EMBEDDING_DIM} dim (${currentBytes} bytes)...`);

  // Batch-embed all texts at once to minimize WASM allocator pressure
  const texts = oldNodes.map(node => {
    try {
      const content = JSON.parse(node.content || "{}");
      return content.text || node.name;
    } catch {
      return node.name;
    }
  });

  const embeddings = await embedBatch(texts);

  let migrated = 0;
  let failed = 0;

  for (let i = 0; i < oldNodes.length; i++) {
    const embedding = embeddings.get(texts[i]);
    if (embedding) {
      const embeddingBuffer = Buffer.from(embedding.buffer);
      try {
        db.prepare(`UPDATE nodes SET embedding = ?, updated_at = datetime('now') WHERE id = ?`).run(embeddingBuffer, oldNodes[i].id);
        migrated++;
      } catch (err) {
        console.warn(`[brain] Migration DB update failed for ${oldNodes[i].id}: ${err.message}`);
        failed++;
      }
    } else {
      failed++;
    }
  }

  console.log(`[brain] Migration complete: ${migrated} re-embedded, ${failed} failed`);

  // Force WAL checkpoint after batch writes — prevents WAL bloat on large migrations
  _walCheckpoint();

  if (migrated > 0) {
    // Update project exports that had migrated nodes
    const projects = db.prepare(`SELECT DISTINCT project_id FROM nodes WHERE project_id IS NOT NULL`).all();
    for (const p of projects) {
      if (p.project_id) writeSearchExport(p.project_id);
    }
  }
}

/**
 * Retroactively create embeddings for nodes indexed before the embedder was ready.
 * These nodes have NULL embeddings and are invisible to semantic search. After the
 * embedder loads, this function finds all such nodes and generates embeddings for them.
 * IDEMPOTENT: skips nodes that already have embeddings.
 */
async function fillNullEmbeddings() {
  if (!db || !embedderReady) return;

  const nullNodes = db.prepare(`
    SELECT id, content, name FROM nodes
    WHERE embedding IS NULL
      AND entity_type NOT IN ('project', 'version')
    ORDER BY updated_at DESC
    LIMIT 500
  `).all();

  if (nullNodes.length === 0) {
    console.log("[brain] No null-embedding nodes to fill");
    return;
  }

  console.log(`[brain] Filling ${nullNodes.length} null-embedding nodes...`);

  // Batch-embed all texts at once to minimize WASM allocator pressure
  const texts = nullNodes.map(node => {
    try {
      const content = JSON.parse(node.content || "{}");
      return (content.text || node.name).slice(0, 500);
    } catch {
      return node.name.slice(0, 500);
    }
  });

  const embeddings = await embedBatch(texts);

  let filled = 0;
  let failed = 0;

  for (let i = 0; i < nullNodes.length; i++) {
    const embedding = embeddings.get(texts[i]);
    if (embedding) {
      const embeddingBuffer = Buffer.from(embedding.buffer);
      try {
        db.prepare(`UPDATE nodes SET embedding = ?, updated_at = datetime('now') WHERE id = ?`).run(embeddingBuffer, nullNodes[i].id);
        filled++;
      } catch (err) {
        console.warn(`[brain] Null-fill DB update failed for ${nullNodes[i].id}: ${err.message}`);
        failed++;
      }
    } else {
      failed++;
    }
  }

  console.log(`[brain] Null-embedding fill complete: ${filled} embedded, ${failed} failed`);

  // Force WAL checkpoint after batch writes
  _walCheckpoint();
}

function nodeId(type, content) {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${type}-${hash}`;
}

// --- Auto-Population: Events → Graph Nodes ---

const DEDUP_THRESHOLD = 0.9; // Cosine similarity above this = same concept

async function indexEvents(projectId, events) {
  if (!db) return { indexed: 0, deduplicated: 0 };

  let indexed = 0;
  let deduplicated = 0;

  // Ensure project node exists
  const projectNodeId = `project-${projectId}`;
  db._stmts.insertNode.run(projectNodeId, projectId, "project", null, "{}", null, 0.9);

  for (const event of events) {
    // Skip summaries — used for brief only
    if (event.type === "summary") continue;

    const content = event.content || "";
    if (content.length < 5) continue;

    const id = nodeId(event.type, content);
    const name = content.slice(0, 80);

    // Check if this exact node already exists
    const existing = db._stmts.getNode.get(id);
    if (existing) {
      // Bump version and confidence — same content seen again
      const newConfidence = Math.min(0.95, existing.confidence + Math.log10(existing.version + 1) * 0.1);
      db._stmts.insertVersion.run(id, existing.version, existing.content, existing.confidence, "re-encountered", `confidence: ${existing.confidence.toFixed(2)} -> ${newConfidence.toFixed(2)}`);
      db._stmts.updateNodeVersion.run(newConfidence, existing.content, id);
      deduplicated++;
      continue;
    }

    // Check for semantic duplicates (similar content, different wording)
    if (embedderReady) {
      const embedding = await embed(content);
      if (embedding) {
        const existingNodes = db._stmts.getNodesByType.all(event.type, projectId);
        let isDuplicate = false;

        for (const node of existingNodes) {
          if (node.embedding) {
            const existingEmbedding = new Float32Array(node.embedding.buffer, node.embedding.byteOffset, node.embedding.byteLength / 4);
            const similarity = cosineSimilarity(embedding, existingEmbedding);
            if (similarity > DEDUP_THRESHOLD) {
              // Semantic duplicate — boost the existing node
              const newConfidence = Math.min(0.95, node.confidence + Math.log10(node.version + 1) * 0.1);
              db._stmts.insertVersion.run(node.id, node.version, node.content, node.confidence, "semantic duplicate re-encountered", `confidence: ${node.confidence.toFixed(2)} -> ${newConfidence.toFixed(2)}`);
              db._stmts.updateNodeVersion.run(newConfidence, JSON.stringify({ text: content, original: JSON.parse(node.content || "{}").text }), node.id);
              deduplicated++;
              isDuplicate = true;
              break;
            }
          }
        }

        if (isDuplicate) continue;

        // New node with embedding
        const seedConfidence = (event.type === "decision" || event.type === "lesson" || event.type === "principle") ? 0.65 : 0.5;
        const embeddingBuffer = Buffer.from(embedding.buffer);
        db._stmts.insertNode.run(id, name, event.type, projectId, JSON.stringify({ text: content, metadata: event.metadata || {} }), embeddingBuffer, seedConfidence);
      } else {
        // Embedding failed — insert without
        const seedConfidence = (event.type === "decision" || event.type === "lesson" || event.type === "principle") ? 0.65 : 0.5;
        db._stmts.insertNode.run(id, name, event.type, projectId, JSON.stringify({ text: content, metadata: event.metadata || {} }), null, seedConfidence);
      }
    } else {
      // Embedder not ready — insert without embedding
      const seedConfidence = (event.type === "decision" || event.type === "lesson" || event.type === "principle") ? 0.65 : 0.5;
      db._stmts.insertNode.run(id, name, event.type, projectId, JSON.stringify({ text: content, metadata: event.metadata || {} }), null, seedConfidence);
    }

    // Create applies-to edge to project
    const edgeId = `${id}-applies-to-${projectNodeId}`;
    db._stmts.insertEdge.run(edgeId, id, projectNodeId, "applies-to", 1.0, "{}");

    // Error→fix edges
    if (event.type === "error_fix" && event.metadata?.original_error) {
      const errorId = nodeId("error", event.metadata.original_error);
      const fixEdgeId = `${errorId}-resolved-by-${id}`;
      db._stmts.insertEdge.run(fixEdgeId, errorId, id, "resolved-by", 1.0, "{}");
    }

    // Fix→decision causal edges ("this fix led to this architectural decision")
    if (event.type === "decision" && event.metadata?.preceded_by_fix) {
      const fixId = nodeId("error_fix", event.metadata.preceded_by_fix);
      const fixNode = db._stmts.getNode.get(fixId);
      if (fixNode) {
        const causalEdgeId = `${fixId}-led-to-${id}`;
        db._stmts.insertEdge.run(causalEdgeId, fixId, id, "led-to", 1.0, "{}");
      }
    }

    indexed++;
  }

  // Write search export after indexing
  writeSearchExport(projectId);

  // Update session pins if anything meaningful was indexed
  const hasSignificantEvents = events.some(e => ["decision", "lesson", "error_fix"].includes(e.type));
  if (hasSignificantEvents) updateSessionPins(projectId);

  return { indexed, deduplicated };
}

// --- Session Pins: live high-confidence commitments that survive context window resets ---

function sessionPinsPath(projectId) {
  return path.join(MEMORY_DIR, projectId, "session-pins.json");
}

/**
 * Rebuild session pins from the knowledge graph.
 * Queries top-confidence decisions/lessons for this project.
 * Called after every indexEvents that touches significant event types.
 */
function updateSessionPins(projectId) {
  if (!db) return;
  try {
    // Pass 1: top decisions and lessons (confidence >= 0.65, up to 6)
    // Recency bias: updated_at DESC breaks ties so old nodes fall out via LIMIT.
    const decisionRows = db.prepare(`
      SELECT id, name, entity_type, content, confidence, access_count
      FROM nodes
      WHERE project_id = ? AND entity_type IN ('decision', 'lesson')
        AND confidence >= 0.65
      ORDER BY confidence DESC, updated_at DESC, access_count DESC
      LIMIT 6
    `).all(projectId);

    // Pass 2: fill remaining slots with high-confidence error fixes (confidence >= 0.78)
    const remaining = 12 - decisionRows.length;
    const fixRows = remaining > 0
      ? db.prepare(`
          SELECT id, name, entity_type, content, confidence, access_count
          FROM nodes
          WHERE project_id = ? AND entity_type = 'error_fix'
            AND confidence >= 0.78
          ORDER BY confidence DESC, updated_at DESC, access_count DESC
          LIMIT ?
        `).all(projectId, remaining)
      : [];

    // Combine and deduplicate by id
    const seenIds = new Set();
    const rows = [];
    for (const r of [...decisionRows, ...fixRows]) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        rows.push(r);
      }
    }

    if (rows.length === 0) return;

    const pins = rows.map(r => {
      let text = r.name;
      try {
        const parsed = JSON.parse(r.content);
        if (parsed.text && parsed.text.length > text.length) text = parsed.text;
      } catch {}
      return { type: r.entity_type, content: text, confidence: r.confidence };
    });

    fs.mkdirSync(path.join(MEMORY_DIR, projectId), { recursive: true });
    fs.writeFileSync(sessionPinsPath(projectId), JSON.stringify(pins, null, 2), "utf-8");
  } catch (err) {
    console.error("[brain] updateSessionPins failed:", err.message);
  }
}

function readSessionPins(projectId) {
  try {
    return JSON.parse(fs.readFileSync(sessionPinsPath(projectId), "utf-8"));
  } catch {
    return [];
  }
}

function clearSessionPins(projectId) {
  try { fs.unlinkSync(sessionPinsPath(projectId)); } catch {}
}

// --- Backfill: Index existing events.jsonl files ---

async function backfillProject(projectId) {
  const eventsPath = path.join(MEMORY_DIR, projectId, "events.jsonl");
  let content;
  try { content = await fs.promises.readFile(eventsPath, "utf-8"); }
  catch { return { indexed: 0, deduplicated: 0 }; }

  const events = content.trim().split("\n").map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  if (events.length === 0) return { indexed: 0, deduplicated: 0 };
  return indexEvents(projectId, events);
}

async function backfillAll() {
  let dirs;
  try { dirs = await fs.promises.readdir(MEMORY_DIR); }
  catch { return; }

  let total = 0;
  for (const dir of dirs) {
    const stat = await fs.promises.stat(path.join(MEMORY_DIR, dir)).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const result = await backfillProject(dir);
    total += result.indexed;
  }

  if (total > 0) {
    sendToMain({ type: "backfill_complete", count: total });
    console.log(`[brain] Backfilled ${total} events from existing memory`);
  }
}

// --- Semantic Search ---

async function search(query, projectId, limit = 10) {
  if (!db) return [];

  const results = [];
  const nodes = projectId
    ? db._stmts.getAllProjectNodes.all(projectId)
    : db.prepare("SELECT * FROM nodes WHERE embedding IS NOT NULL").all();

  if (embedderReady) {
    const queryEmbedding = await embed(query);
    if (queryEmbedding) {
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      for (const node of nodes) {
        const content = JSON.parse(node.content || "{}").text || node.name;
        const contentLower = content.toLowerCase();
        const keywordScore = queryWords.length > 0
          ? queryWords.filter(w => contentLower.includes(w)).length / queryWords.length
          : 0;

        let score;
        if (node.embedding) {
          const nodeEmbedding = new Float32Array(node.embedding.buffer, node.embedding.byteOffset, node.embedding.byteLength / 4);
          const similarity = cosineSimilarity(queryEmbedding, nodeEmbedding);
          // Hybrid score: 60% semantic + 40% keyword
          score = 0.6 * similarity + 0.4 * keywordScore;
        } else {
          // No embedding (backfilled before embedder was ready): keyword-only
          score = keywordScore * 0.8; // Discount slightly compared to hybrid
        }

        if (score > 0.25) {
          results.push({
            id: node.id,
            name: node.name,
            type: node.entity_type,
            content: content.slice(0, 300),
            confidence: node.confidence,
            score,
            age: node.created_at,
          });
        }
      }
    }
  } else {
    // Fallback: keyword-only search
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (const node of nodes) {
      const content = JSON.parse(node.content || "{}").text || node.name;
      const contentLower = content.toLowerCase();
      const score = queryWords.length > 0
        ? queryWords.filter(w => contentLower.includes(w)).length / queryWords.length
        : 0;
      if (score > 0) {
        results.push({
          id: node.id,
          name: node.name,
          type: node.entity_type,
          content: content.slice(0, 300),
          confidence: node.confidence,
          score,
          age: node.created_at,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --- Tension Detection ---

async function detectTensions(projectId, newDecisions) {
  if (!db || !embedderReady || newDecisions.length === 0) return [];

  const tensions = [];

  // Get existing high-confidence decisions for this project
  const existingDecisions = db._stmts.getNodesByType.all("decision", projectId)
    .filter(n => n.confidence > 0.5 && n.embedding);

  for (const newDec of newDecisions) {
    const newContent = newDec.content || "";
    const newEmbedding = await embed(newContent);
    if (!newEmbedding) continue;

    for (const existing of existingDecisions) {
      const existingEmbedding = new Float32Array(existing.embedding.buffer, existing.embedding.byteOffset, existing.embedding.byteLength / 4);
      const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

      // Sweet spot: related but potentially contradictory (0.3-0.7)
      if (similarity >= 0.3 && similarity <= 0.7) {
        const existingContent = JSON.parse(existing.content || "{}").text || existing.name;
        tensions.push({
          newDecision: newContent.slice(0, 200),
          pastDecision: existingContent.slice(0, 200),
          pastConfidence: existing.confidence,
          similarity,
          severity: 1.0 - similarity,
        });
      }
    }
  }

  // Sort by severity (highest first) and take top 3
  tensions.sort((a, b) => b.severity - a.severity);
  return tensions.slice(0, 3);
}

// --- Cross-Project Pattern Transfer ---

const CROSS_PROJECT_THRESHOLD = 0.6; // Cosine similarity for cross-project relevance

async function crossProjectTransfer(projectId, newNodes) {
  if (!db || !embedderReady || newNodes.length === 0) return 0;

  let edgesCreated = 0;

  // Get high-confidence nodes from OTHER projects
  const otherNodes = db._stmts.getHighConfidenceNodes.all(projectId);
  if (otherNodes.length === 0) return 0;

  for (const newNode of newNodes) {
    const newEmbedding = await embed(newNode.content || "");
    if (!newEmbedding) continue;

    for (const other of otherNodes) {
      if (!other.embedding) continue;
      const otherEmbedding = new Float32Array(other.embedding.buffer, other.embedding.byteOffset, other.embedding.byteLength / 4);
      const similarity = cosineSimilarity(newEmbedding, otherEmbedding);

      if (similarity > CROSS_PROJECT_THRESHOLD) {
        const edgeId = `${newNode.id}-shares-pattern-${other.id}`;
        try {
          db._stmts.insertEdge.run(
            edgeId, newNode.id, other.id, "shares-pattern-with",
            similarity, JSON.stringify({ similarity: similarity.toFixed(3) }),
          );
          edgesCreated++;
        } catch {} // UNIQUE constraint — edge already exists
      }
    }
  }

  return edgesCreated;
}

// --- Outcome Tracking: decision→result feedback loops ---

function trackOutcomes(projectId, events) {
  if (!db) return;

  // Look for sequences: decisions followed by errors (bad outcome) or
  // task completions / successful edits (good outcome)
  const decisions = [];
  const errors = [];
  const successes = [];

  for (const event of events) {
    if (event.type === "decision") decisions.push(event);
    else if (event.type === "error") errors.push(event);
    else if (event.type === "error_fix") successes.push(event);
    else if (event.type === "file_edit") successes.push(event);
  }

  // If the batch has decisions AND errors but no fixes → decisions led to problems
  if (decisions.length > 0 && errors.length > 0 && successes.length === 0) {
    for (const dec of decisions) {
      const id = nodeId(dec.type, dec.content || "");
      const node = db._stmts.getNode.get(id);
      if (node && node.confidence > 0.15) {
        // Lower confidence by 0.05 — one bad outcome shouldn't tank a pattern
        db._stmts.lowerConfidence.run(0.05, id);
        db._stmts.insertVersion.run(
          id, node.version, node.content, node.confidence,
          "negative outcome — errors followed this decision",
          `confidence: ${node.confidence.toFixed(2)} -> ${Math.max(0.1, node.confidence - 0.05).toFixed(2)}`,
        );
        // Create led-to edge: decision → error
        for (const err of errors) {
          const errId = nodeId(err.type, err.content || "");
          const edgeId = `${id}-led-to-${errId}`;
          try { db._stmts.insertEdge.run(edgeId, id, errId, "led-to", 1.0, "{}"); }
          catch {} // UNIQUE constraint
        }
      }
    }
  }

  // If the batch has decisions AND successful outcomes → decisions worked
  if (decisions.length > 0 && successes.length > errors.length) {
    for (const dec of decisions) {
      const id = nodeId(dec.type, dec.content || "");
      const node = db._stmts.getNode.get(id);
      if (node && node.confidence < 0.95) {
        // Boost confidence by 0.03 — small positive reinforcement
        db._stmts.boostConfidence.run(0.03, id);
        db._stmts.insertVersion.run(
          id, node.version, node.content, node.confidence,
          "positive outcome — successful work followed this decision",
          `confidence: ${node.confidence.toFixed(2)} -> ${Math.min(0.95, node.confidence + 0.03).toFixed(2)}`,
        );
      }
    }
  }
}

// --- Confidence Decay: stale knowledge loses trust ---

function decayStaleNodes(projectId) {
  if (!db) return 0;

  // Nodes not updated in 30+ days lose a tiny bit of confidence
  const staleNodes = db._stmts.getStaleNodes.all(projectId, "-30 days");
  let decayed = 0;

  for (const node of staleNodes) {
    // Decay by 0.02 — very gentle, takes ~15 months to go from 0.5 to 0.2
    db._stmts.lowerConfidence.run(0.02, node.id);
    decayed++;
  }

  return decayed;
}

// --- Explicit Pruning: remove low-confidence and orphaned nodes ---

function pruneOldNodes(projectId) {
  if (!db) return { pruned: 0, deletedEdges: 0 };

  let pruned = 0;

  // Remove nodes below 0.15 confidence (noise, contradictions, abandoned paths)
  const result = db._stmts.pruneLowConfidence.run(projectId, 0.15);
  pruned += result.changes;

  // Remove orphan edge records (edges whose source or target no longer exists)
  const orphanEdges = db.prepare(`
    DELETE FROM edges WHERE id NOT IN (
      SELECT e.id FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
    )
  `).run();

  // Prune orphaned version history
  db._stmts.pruneOldVersions.run();

  console.log(`[brain] Pruned ${pruned} low-confidence nodes, ${orphanEdges.changes} orphan edges for ${projectId}`);
  return { pruned, deletedEdges: orphanEdges.changes };
}

// --- Contextual Search (for proactive injection) ---

async function contextualSearch(query, fileContext, projectId, intent, projectRoot, taskType = null, atomHints = [], projectWhy = "") {
  if (!db) return { memories: [], tensions: [], atoms: [], profileAtoms: [], relevantFiles: [], principles: [] };

  // Embed a why-augmented query — biases retrieval toward the project's purpose.
  // The "why" is typically 2-4 sentences. Prepending it shifts the embedding vector
  // so that memories/files relevant to the project's core purpose rank higher.
  const embeddingQuery = projectWhy ? `${projectWhy}\n\n${query}` : query;
  const queryEmbedding = embedderReady ? await embed(embeddingQuery) : null;

  // Unified atom pool search: system atoms + profile atoms + learned atoms,
  // scored by cosine × facetWeight × priority + hintBoost.
  // Falls back to legacy profileAtoms when atom pool is empty.
  const atoms = queryEmbedding ? searchAtomPool(queryEmbedding, taskType, atomHints, 16) : [];
  // Legacy compat: also populate profileAtoms from the unified results
  const profileAtoms = atoms.filter(a => a.entityType === "profile_atom").slice(0, 4);

  // Relevant files: always retrieve if we have indexed files for this project
  const relevantFiles = projectRoot ? await findRelevantFiles(query, projectId, 5) : [];

  // Short imperative prompts skip project memory (lessons/decisions/tensions)
  // but ALWAYS include scored atoms — they drive system prompt assembly.
  // Without atoms, session-context falls back to injecting ALL atoms unfiltered.
  const trimmed = query.trim();
  const isDirective = trimmed.length < 65 && /^(add|remove|fix|update|change|delete|create|make|move|rename|refactor|run|install|build|deploy|write|edit|show|get|find|check|use|switch|enable|disable|set|reset|clear|open|close)/i.test(trimmed);

  if (isDirective) return { memories: [], tensions: [], atoms, profileAtoms, relevantFiles, principles: [] };

  // Combine query + active file + project why for richer semantic + keyword search
  const searchText = [projectWhy, fileContext, query].filter(Boolean).join(" ");
  const candidates = await search(searchText, projectId, 8);

  // Intent-aware type and confidence filters
  // execute: only rock-solid lessons/patterns, no tensions, no old decisions
  // explain: only patterns and lessons that clarify, no tensions
  // plan: broader, tensions allowed but only very high confidence
  // other: same as execute
  let allowedTypes, confidenceFloor, allowTensions, maxAge;
  if (intent === "plan") {
    allowedTypes = ["decision", "lesson", "pattern", "error_fix"];
    confidenceFloor = 0.80;
    allowTensions = true;
    maxAge = 60; // days
  } else if (intent === "explain") {
    allowedTypes = ["pattern", "lesson"];
    confidenceFloor = 0.75;
    allowTensions = false;
    maxAge = 90;
  } else {
    // execute / other — follow the user's lead, stay out of the way
    allowedTypes = ["lesson", "pattern", "error_fix"];
    confidenceFloor = 0.80;
    allowTensions = false;
    maxAge = 30; // only recent, resolved issues are likely still relevant
  }

  const cutoff = new Date(Date.now() - maxAge * 86400000).toISOString();
  const recentCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 minutes

  const valuable = candidates.filter(m => {
    if (!allowedTypes.includes(m.type)) return false;
    if (m.score <= 0.40) return false;

    // Recency bypass: nodes from the last 60 minutes are immediately available
    // regardless of confidence — within-session learning should be usable now
    const createdAt = m.age || m.created_at || "";
    if (createdAt >= recentCutoff && m.score > 0.40) return true;

    // Standard path: confidence + age filter
    return (m.confidence || 0) >= confidenceFloor &&
      (m.updated_at || createdAt || "9999") >= cutoff;
  }).slice(0, 5);

  // Tensions only for plan intent, and only very high confidence past decisions
  let tensions = [];
  if (allowTensions && embedderReady && query.length > 10) {
    const raw = await detectTensions(projectId, [{ type: "decision", content: query }]);
    tensions = (raw || []).filter(t => (t.pastConfidence || 0) >= 0.85).slice(0, 1);
  }

  // Active Mind entries: human-authored thoughts, high signal
  let mindEntries = [];
  try {
    const activeMinds = db.prepare(
      `SELECT id, content, embedding FROM mind_entries WHERE completed = 0 ORDER BY updated_at DESC LIMIT 10`
    ).all();

    if (queryEmbedding && activeMinds.length > 0) {
      // Semantic filter: only include mind entries relevant to this query
      const scored = [];
      for (const m of activeMinds) {
        if (m.embedding) {
          const mEmb = new Float32Array(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength / 4);
          const sim = cosineSimilarity(queryEmbedding, mEmb);
          if (sim > 0.35) scored.push({ content: m.content, score: sim });
        } else {
          // No embedding — keyword fallback
          const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const text = m.content.toLowerCase();
          const hit = words.length > 0 ? words.filter(w => text.includes(w)).length / words.length : 0;
          if (hit > 0.3) scored.push({ content: m.content, score: hit });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      mindEntries = scored.slice(0, 3);
    } else if (activeMinds.length <= 3) {
      // Few entries — include all (user clearly wants them active)
      mindEntries = activeMinds.map(m => ({ content: m.content, score: 0.9 }));
    }
  } catch (err) {
    console.error("[brain] Mind entry query failed:", err.message);
  }

  // ── Principles: standing project standards, surfaced separately ──────────
  // Principles are intentionally excluded from `allowedTypes` above so they
  // don't compete with general memories. They get their own retrieval path
  // and their own section in the system prompt.
  let principles = [];
  try {
    const principleNodes = db._stmts.getNodesByType.all("principle", projectId);
    if (principleNodes.length > 0 && queryEmbedding) {
      const scored = [];
      for (const n of principleNodes) {
        const content = JSON.parse(n.content || "{}").text || n.name;
        if (isSignalNoise(content)) continue;
        if (n.embedding) {
          const nEmb = new Float32Array(n.embedding.buffer, n.embedding.byteOffset, n.embedding.byteLength / 4);
          const sim = cosineSimilarity(queryEmbedding, nEmb);
          // Lower threshold than general memories — principles are standing criteria
          if (sim > 0.30 || (n.confidence || 0) >= 0.80) {
            scored.push({ content, score: sim, confidence: n.confidence || 0 });
          }
        } else {
          // No embedding — include high-confidence principles unconditionally
          if ((n.confidence || 0) >= 0.80) {
            scored.push({ content, score: 0.5, confidence: n.confidence || 0 });
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
      principles = scored.slice(0, 6);
    } else if (principleNodes.length > 0) {
      // No embedder — include all high-confidence principles
      principles = principleNodes
        .filter(n => (n.confidence || 0) >= 0.80)
        .slice(0, 6)
        .map(n => ({
          content: JSON.parse(n.content || "{}").text || n.name,
          score: 0.5,
          confidence: n.confidence || 0,
        }))
        .filter(p => !isSignalNoise(p.content));
    }
  } catch (err) {
    console.error("[brain] Principle query failed:", err.message);
  }

  return { memories: valuable, tensions, atoms, profileAtoms, relevantFiles, mindEntries, principles };
}

// --- Search Export (for MCP server) ---

function writeSearchExport(projectId) {
  if (!db) return;
  try {
    // Only export meaningful knowledge types — not transient noise like commands
    const nodes = db.prepare(`
      SELECT id, name, entity_type, content, confidence
      FROM nodes
      WHERE project_id = ?
        AND entity_type IN ('decision','lesson','pattern','error','error_fix','file','profile_atom','system_atom','project')
    `).all(projectId);
    const mindEntries = db.prepare(`SELECT id, content, completed FROM mind_entries`).all();

    const exported = nodes.map(n => {
      const content = JSON.parse(n.content || "{}").text || n.name;
      return {
        id: n.id,
        type: n.entity_type,
        content: content.slice(0, 500),
        confidence: n.confidence,
      };
    });

    // Add global mind entries (no embeddings — they're searched via keyword)
    for (const m of mindEntries) {
      exported.push({
        id: m.id,
        type: "mind",
        content: m.content,
        confidence: 0.9,
        completed: !!m.completed,
      });
    }

    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXPORTS_DIR, `${projectId}.json`), JSON.stringify(exported));
  } catch (err) {
    console.error("[brain] Export write error:", err.message);
  }
}

// --- Contextual Export (for claude-worker brief injection) ---

async function writeContextualExport(projectId, query, fileContext, intent, projectRoot, taskType = null, atomHints = [], projectWhy = "") {
  const result = await contextualSearch(query || "", fileContext || "", projectId, intent || "other", projectRoot || null, taskType, atomHints, projectWhy);

  // Layer 1: Symbol map — resolve symbols mentioned in the query + working set exports.
  // The model sees key symbols pre-resolved so it doesn't grep for them.
  result.relevantSymbols = [];
  if (db) {
    try {
      // From query text: extract symbol names and resolve them
      if (query) {
        result.relevantSymbols = findRelevantSymbols(db, projectId, query);
      }

      // From working set: pull top exports from active files so the model
      // knows the interfaces in play without searching for them.
      const state = _readSessionState(projectId);
      const wsFiles = (state?.workingSet || []).slice(0, 6);
      if (wsFiles.length > 0) {
        const queryNames = new Set(result.relevantSymbols.map(s => s.name));
        for (const wsFile of wsFiles) {
          const filePath = wsFile.path || wsFile;
          const fileSyms = getFileSymbols(db, projectId, filePath);
          // Add up to 3 key exports per file (functions, classes, types — not consts)
          const meaningful = fileSyms
            .filter(s => !queryNames.has(s.name) && ["function", "class", "interface", "type"].includes(s.kind))
            .slice(0, 3);
          for (const s of meaningful) {
            queryNames.add(s.name);
            result.relevantSymbols.push(s);
          }
        }
      }
    } catch (err) {
      console.warn("[brain] symbol resolution error (non-fatal):", err.message);
    }
  }


  // ── Authoritative decisions: high-confidence, outcome-proven constraints ──
  // These are decisions the brain has accumulated enough evidence for (confidence >= 0.80)
  // to treat as binding constraints. The orchestrator places them at CRITICAL priority
  // with frozen tier so the model sees them every turn and cannot contradict them.
  if (db) {
    try {
      const authNodes = db.prepare(`
        SELECT id, name, content, confidence, created_at
        FROM nodes
        WHERE project_id = ? AND entity_type = 'decision' AND confidence >= 0.80
        ORDER BY confidence DESC, access_count DESC
        LIMIT 10
      `).all(projectId);
      result.authoritativeDecisions = authNodes.map(n => {
        const parsed = JSON.parse(n.content || '{}');
        return {
          id: n.id,
          content: parsed.text || n.name,
          confidence: n.confidence,
          age: n.created_at,
        };
      });
    } catch {
      result.authoritativeDecisions = [];
    }
  } else {
    result.authoritativeDecisions = [];
  }

  // Full codebase map — every indexed file with a one-line description.
  // The model sees the entire project structure, not just 5 "relevant" files.
  // ~2-4k tokens for a 100-file project. Injected into the stable prompt.
  if (db) {
    try {
      const fileNodes = db.prepare(
        `SELECT name, content FROM nodes WHERE entity_type = 'file' AND project_id = ? ORDER BY name`
      ).all(projectId);
      result.codebaseMap = fileNodes.map(n => {
        const text = JSON.parse(n.content || "{}").text || "";
        // First sentence only — keep it compact
        const firstSentence = text.split(/\.\s/)[0] || text;
        return {
          path: n.name,
          desc: firstSentence.length > 120 ? firstSentence.slice(0, 117) + "..." : firstSentence + (firstSentence.endsWith(".") ? "" : "."),
        };
      });
    } catch {
      result.codebaseMap = [];
    }
  } else {
    result.codebaseMap = [];
  }

  // Touch all memories that made it into the context — prevents decay,
  // records that these memories are actively used. Over time, frequently
  // accessed memories get reinforced while unused ones fade.
  if (db && result.memories?.length > 0) {
    for (const mem of result.memories) {
      if (mem.id) {
        try { touchMemory(db, mem.id); } catch {}
      }
    }
  }

  try {
    fs.mkdirSync(path.join(BRAIN_DIR, "context"), { recursive: true });
    fs.writeFileSync(
      path.join(BRAIN_DIR, "context", `${projectId}.json`),
      JSON.stringify(result),
    );
  } catch {}

  return result;
}

// --- Graph Health: get intelligence stats ---

function getIntelligenceStats(projectId) {
  if (!db) return null;

  const allNodes = db._stmts.getNodesByProject.all(projectId);
  const highConfidence = allNodes.filter(n => n.confidence > 0.7);
  const lowConfidence = allNodes.filter(n => n.confidence < 0.3);
  const withEdges = new Set();

  const edges = db.prepare(`
    SELECT source_id, target_id, type FROM edges
    WHERE source_id IN (SELECT id FROM nodes WHERE project_id = ?)
    OR target_id IN (SELECT id FROM nodes WHERE project_id = ?)
  `).all(projectId, projectId);

  for (const e of edges) { withEdges.add(e.source_id); withEdges.add(e.target_id); }

  const crossProjectEdges = edges.filter(e => e.type === "shares-pattern-with").length;

  return {
    totalNodes: allNodes.length,
    highConfidence: highConfidence.length,
    lowConfidence: lowConfidence.length,
    totalEdges: edges.length,
    crossProjectEdges,
    connectedNodes: withEdges.size,
    byType: allNodes.reduce((acc, n) => { acc[n.entity_type] = (acc[n.entity_type] || 0) + 1; return acc; }, {}),
  };
}

// --- Profile Atomization: index identity/philosophy/rules/anti-patterns as retrievable nodes ---

const PROFILE_ATOM_TYPE = "profile_atom";

/**
 * Parse all profile files into individual atomic nodes and embed them.
 * Each principle, rule, anti-pattern becomes its own searchable node.
 * Deletes old atoms first — profile changes are infrequent, rebuild is safe.
 */
async function indexProfileAtoms() {
  if (!db || !embedderReady) return;

  try {
    db.prepare(`DELETE FROM nodes WHERE entity_type = ?`).run(PROFILE_ATOM_TYPE);

    const identity = readProfileJson("identity.json");
    const philosophy = readProfileMd("philosophy.md");
    const rules = readProfileMd("rules.md");
    const antiPatterns = readProfileJson("anti-patterns.json");

    const atoms = [];

    // Identity bio as an atom — gives context on who this person is
    if (identity?.bio && identity.bio.length > 10) {
      atoms.push({ text: identity.bio, facet: "identity" });
    }

    // Philosophy: each double-newline-separated paragraph = one principle atom
    if (philosophy) {
      const paragraphs = philosophy.split(/\n\n+/).filter(p => p.trim().length > 20);
      for (const p of paragraphs) {
        atoms.push({ text: p.trim(), facet: "philosophy" });
      }
    }

    // Rules: each non-empty line = one rule atom
    if (rules) {
      const lines = rules.split(/\n/).filter(l => l.trim().length > 10);
      for (const l of lines) {
        const text = l.trim().replace(/^[-*•]\s*/, "");
        if (text.length > 10) atoms.push({ text, facet: "rule" });
      }
    }

    // Anti-patterns: error + fix combined into one atom for semantic coherence
    if (antiPatterns?.patterns) {
      for (const ap of antiPatterns.patterns) {
        if (ap.error && ap.fix) {
          atoms.push({ text: `Avoid: ${ap.error} — Instead: ${ap.fix}`, facet: "anti_pattern", priority: 0.75 });
        }
      }
    }

    // Preferences: coding patterns as atoms
    const preferences = readProfileJson("preferences.json");
    if (preferences?.coding) {
      for (const [, info] of Object.entries(preferences.coding)) {
        if (info.content && info.content.length > 10) {
          atoms.push({ text: info.content, facet: "preference", priority: 0.6 });
        }
      }
    }

    // Preferences: tool preferences as atoms
    if (preferences?.tools) {
      for (const [tool, info] of Object.entries(preferences.tools)) {
        const label = info.prefers === false ? `Avoid ${info.avoids || tool}` : `Prefers ${tool}`;
        const text = `${label}: ${info.content || ""}`.trim();
        if (text.length > 10) {
          atoms.push({ text, facet: "preference", priority: 0.55 });
        }
      }
    }

    // Style: verbosity and work style as atoms
    const style = readProfileJson("style.json");
    if (style) {
      if (style.verbosity && style.verbosity !== "adaptive") {
        atoms.push({ text: `Communication style: ${style.verbosity} verbosity.`, facet: "style", priority: 0.5 });
      }
      if (style.planFirst === true) {
        atoms.push({ text: "Work style: plan before executing — think through the approach first.", facet: "style", priority: 0.5 });
      } else if (style.planFirst === false) {
        atoms.push({ text: "Work style: execute directly — skip planning for straightforward tasks.", facet: "style", priority: 0.5 });
      }
    }

    // Batch-embed all atoms at once to minimize WASM allocator pressure
    const validAtoms = atoms.filter(a => a.text.length >= 10);
    const atomTexts = validAtoms.map(a => a.text);
    const embeddings = await embedBatch(atomTexts);

    const updateAtom = db.prepare(`
      INSERT INTO nodes (id, name, entity_type, project_id, content, embedding, confidence, version, priority, facet)
      VALUES (?, ?, ?, NULL, ?, ?, 1.0, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);

    let indexed = 0;
    for (const atom of validAtoms) {
      const id = nodeId(PROFILE_ATOM_TYPE, atom.text);
      const embedding = embeddings.get(atom.text);
      const embeddingBuffer = embedding ? Buffer.from(embedding.buffer) : null;

      updateAtom.run(
        id, atom.text.slice(0, 80), PROFILE_ATOM_TYPE,
        JSON.stringify({ text: atom.text, facet: atom.facet }),
        embeddingBuffer, atom.priority || 0.7, atom.facet,
      );
      indexed++;
    }

    // Force WAL checkpoint after batch writes
    _walCheckpoint();

    console.log(`[brain] Indexed ${indexed} profile atoms`);
  } catch (err) {
    console.error("[brain] indexProfileAtoms error:", err.message);
  }
}

/**
 * Index all system atoms — retired.
 * ALL_SYSTEM_ATOMS is now an empty array. Lifecycle handled by profile atoms only.
 */

/**
 * Unified atom pool search — replaces searchProfileAtoms().
 *
 * Queries ALL atom types (system_atom, profile_atom, learned nodes above threshold),
 * applies facet-weighted scoring based on task type, and returns a single ranked list.
 *
 * Scoring: finalScore = (cosineSimilarity × facetWeight × priority) + hintBoost
 *
 * @param {Float32Array} queryEmbedding — embedded query vector
 * @param {string|null} taskType — from local-intel classification
 * @param {string[]} atomHints — keyword hints from local-intel
 * @param {number} limit — max atoms to return
 * @returns {Array<{id, facet, content, score, priority, sortOrder}>}
 */
function searchAtomPool(queryEmbedding, taskType = null, atomHints = [], limit = 12) {
  if (!db || !queryEmbedding) return [];

  // Get facet weights for this task type
  const weights = taskType ? (FACET_WEIGHTS[taskType] || FACET_WEIGHTS._default) : FACET_WEIGHTS._default;

  // Build hint pattern for keyword boost
  const hintPattern = atomHints.length > 0
    ? new RegExp(atomHints.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : null;

  // Query all atom-type nodes with embeddings
  const atoms = db.prepare(`
    SELECT * FROM nodes
    WHERE entity_type IN ('system_atom', 'profile_atom')
      AND embedding IS NOT NULL
  `).all();

  // Also pull in high-confidence learned nodes (lessons, patterns, error_fix)
  // that have crossed the promotion threshold — these become "learned atoms"
  const learnedAtoms = db.prepare(`
    SELECT * FROM nodes
    WHERE entity_type IN ('lesson', 'pattern', 'error_fix')
      AND confidence >= 0.78
      AND embedding IS NOT NULL
    ORDER BY confidence DESC
    LIMIT 20
  `).all();

  const results = [];

  for (const node of [...atoms, ...learnedAtoms]) {
    const nodeEmbedding = new Float32Array(
      node.embedding.buffer, node.embedding.byteOffset, node.embedding.byteLength / 4,
    );
    const cosine = cosineSimilarity(queryEmbedding, nodeEmbedding);
    if (cosine < 0.20) continue; // below noise floor

    const content = JSON.parse(node.content || "{}");
    const text = content.text || node.name;
    const facet = node.facet || content.facet || _inferFacet(node.entity_type);
    const priority = node.priority || 0.5;
    const sortOrder = node.sort_order || 0;

    // Unified scoring: cosine × facetWeight × priority + hintBoost
    const facetMul = weights[facet] || 1.0;
    const hintBoost = hintPattern && hintPattern.test(text) ? 0.15 : 0;
    const finalScore = (cosine * facetMul * priority) + hintBoost;

    results.push({
      id: node.id,
      facet,
      content: text,
      score: finalScore,
      cosine,
      priority,
      sortOrder,
      entityType: node.entity_type,
    });
  }

  // Sort: sequenced atoms (sortOrder > 0) by sortOrder, then by score descending
  results.sort((a, b) => {
    // Sequenced atoms (method steps) maintain their order when both are present
    if (a.sortOrder > 0 && b.sortOrder > 0) return a.sortOrder - b.sortOrder;
    // Sequenced atoms rank above unordered at equal score
    if (a.sortOrder > 0 && b.sortOrder === 0 && a.score >= b.score * 0.8) return -1;
    if (b.sortOrder > 0 && a.sortOrder === 0 && b.score >= a.score * 0.8) return 1;
    // Default: score descending
    return b.score - a.score;
  });

  return results.slice(0, limit);
}

/**
 * Infer facet from entity_type for learned nodes that don't have an explicit facet.
 */
function _inferFacet(entityType) {
  switch (entityType) {
    case "lesson": return "learned";
    case "pattern": return "learned";
    case "error_fix": return "anti_pattern";
    case "decision": return "learned";
    default: return "learned";
  }
}

/**
 * @deprecated Use searchAtomPool() instead. Kept for backward compatibility.
 * Semantic search over profile atoms only.
 * Returns atoms sorted by cosine similarity to the query embedding.
 */
function searchProfileAtoms(queryEmbedding, limit = 5) {
  if (!db || !queryEmbedding) return [];

  const atoms = db.prepare(
    `SELECT * FROM nodes WHERE entity_type = ? AND embedding IS NOT NULL`
  ).all(PROFILE_ATOM_TYPE);

  const results = [];
  for (const atom of atoms) {
    const atomEmbedding = new Float32Array(
      atom.embedding.buffer, atom.embedding.byteOffset, atom.embedding.byteLength / 4
    );
    const similarity = cosineSimilarity(queryEmbedding, atomEmbedding);
    if (similarity > 0.28) {
      const content = JSON.parse(atom.content || "{}");
      results.push({
        id: atom.id,
        facet: content.facet || "unknown",
        content: content.text || atom.name,
        score: similarity,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --- Profile System: learned + explicit preferences ---

const PROFILE_PROMOTION_THRESHOLD = 0.8; // Confidence needed to become a profile preference
const PROFILE_MIN_PROJECTS = 1;          // Minimum projects a pattern must appear in (1 = project-specific OK, 2+ = cross-project)

function initProfile() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Initialize files if they don't exist
  const defaults = {
    "identity.json": { name: "", bio: "", role: "", avatar: null },
    "preferences.json": { coding: {}, communication: {}, tools: {}, _meta: { lastUpdated: null, version: 1 } },
    "anti-patterns.json": { patterns: [], _meta: { lastUpdated: null, version: 1 } },
    "style.json": { verbosity: "adaptive", planFirst: true, _meta: { lastUpdated: null, version: 1 } },
    "rules.md": "",
    "philosophy.md": "",
  };

  for (const [file, content] of Object.entries(defaults)) {
    const fp = path.join(PROFILE_DIR, file);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
  }
}

function readProfileJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, filename), "utf-8"));
  } catch {
    return null;
  }
}

function writeProfileJson(filename, data) {
  data._meta = { ...data._meta, lastUpdated: new Date().toISOString(), version: (data._meta?.version || 0) + 1 };
  fs.writeFileSync(path.join(PROFILE_DIR, filename), JSON.stringify(data, null, 2));
}

function readProfileMd(filename) {
  try {
    return fs.readFileSync(path.join(PROFILE_DIR, filename), "utf-8").trim();
  } catch {
    return "";
  }
}

// Extract preferences from high-confidence nodes across all projects
function extractPreferences() {
  if (!db) return;

  const prefs = readProfileJson("preferences.json") || { coding: {}, communication: {}, tools: {}, _meta: {} };
  const antiPatterns = readProfileJson("anti-patterns.json") || { patterns: [], _meta: {} };

  // Find high-confidence decisions and lessons across ALL projects
  const highConfNodes = db.prepare(`
    SELECT * FROM nodes
    WHERE confidence >= ? AND entity_type IN ('decision', 'lesson', 'error_fix')
    ORDER BY confidence DESC
  `).all(PROFILE_PROMOTION_THRESHOLD);

  if (highConfNodes.length === 0) return;

  // Categorize by content analysis
  const newCoding = {};
  const newTools = {};
  const newAntiPatterns = [];

  for (const node of highConfNodes) {
    const content = JSON.parse(node.content || "{}").text || node.name;
    const lower = content.toLowerCase();

    // Skip error_fix nodes for tool/coding extraction — they only feed anti-patterns.
    // Without this gate, tool error messages leak into coding patterns.
    if (node.entity_type === "error_fix") {
      // Fall through to anti-pattern extraction below
    } else {
      // ── Tool preferences ─────────────────────────────────────────────────
      // Positive: explicit and implicit tool choices
      const positiveToolRe = /(?:use|using|prefer(?:ring)?|chose|choosing|switch(?:ed|ing)? to|install(?:ed|ing)|opted? for|going with|went with|stick(?:ing)? with|decided on|picked|selected|settled on|works? (?:well |better )?with|built? with|rely(?:ing)? on|depend(?:ing)? on)\s+([\w@/.-]{2,40})/gi;
      for (const m of content.matchAll(positiveToolRe)) {
        const tool = m[1].replace(/[.,;:!?]+$/, ""); // strip trailing punctuation
        if (tool.length > 1 && !/^(the|a|an|it|to|on|in|for|of|be|is|was|are|this|that)$/i.test(tool)) {
          if (!newTools[tool]) {
            newTools[tool] = { confidence: node.confidence, source: node.project_id, content: content.slice(0, 150), prefers: true };
          }
        }
      }

      // Negative: things being avoided or replaced
      const negativeToolRe = /(?:avoid(?:ing)?|not? (?:use|using)|stop(?:p(?:ed|ing))? using|drop(?:p(?:ed|ing))?|replac(?:ed|ing)|mov(?:ed|ing) away from|get rid of|removing|ditching)\s+([\w@/.-]{2,40})/gi;
      for (const m of content.matchAll(negativeToolRe)) {
        const tool = m[1].replace(/[.,;:!?]+$/, "");
        if (tool.length > 1 && !/^(the|a|an|it|to|on|in|for|of|be|is|was|are|this|that)$/i.test(tool)) {
          const key = `avoid:${tool}`;
          if (!newTools[key]) {
            newTools[key] = { confidence: node.confidence, source: node.project_id, content: content.slice(0, 150), prefers: false, avoids: tool };
          }
        }
      }

      // ── Coding patterns ───────────────────────────────────────────────────
      // Broader keyword set — captures style, approach, and implicit preferences
      const codingKeywords = [
        "naming", "convention", "style", "pattern", "structure", "architecture",
        "approach", "practice", "instead of", "rather than", "always ", "never ",
        "consistent", "standard", "rule", "guideline", "principle", "prefer",
        "should ", "must ", "avoid ", "don't ", "do not ", "keep ", "make sure",
        "important", "critical", "key insight", "the reason", "because ",
      ];
      if (codingKeywords.some(kw => lower.includes(kw))) {
        const key = content.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
        if (key.length > 5 && !newCoding[key]) {
          newCoding[key] = { confidence: node.confidence, source: node.project_id, content: content.slice(0, 200) };
        }
      }

      // ── Implicit corrections ──────────────────────────────────────────────
      // "X, not Y" / "use X instead of Y" — strongest signal of preference
      const correctionRe = /(?:use|with|prefer)\s+([\w@/.-]{2,30})\s+(?:instead of|not|over|rather than)\s+([\w@/.-]{2,30})/gi;
      for (const m of content.matchAll(correctionRe)) {
        const toward = m[1].replace(/[.,;:!?]+$/, "");
        const away = m[2].replace(/[.,;:!?]+$/, "");
        const key = `correction:${toward}-over-${away}`;
        if (!newCoding[key]) {
          newCoding[key] = { confidence: node.confidence, source: node.project_id, content: `Prefer ${toward} over ${away}: ${content.slice(0, 120)}` };
        }
      }
    }

    // Anti-patterns: things from error_fix — but only genuine behavioral patterns,
    // NOT tool operational errors (file not found, string not matched, validation failures).
    // Those are transient tool issues, not user anti-patterns worth remembering.
    if (node.entity_type === "error_fix") {
      const parsed = JSON.parse(node.content || "{}");
      const original = parsed.metadata?.original_error;
      if (original && original.length > 10) {
        // Skip tool operational errors — these are not behavioral patterns
        const isToolError =
          /tool_use_error/i.test(original) ||
          /could not find the specified string/i.test(original) ||
          /file has not been read/i.test(original) ||
          /file does not exist/i.test(original) ||
          /failed to edit/i.test(original) ||
          /command (?:validation )?failed/i.test(original) ||
          /path does not exist/i.test(original) ||
          /not writable/i.test(original) ||
          /permission denied/i.test(original) ||
          /no such file or directory/i.test(original) ||
          /timed? ?out/i.test(original) ||
          /ENOENT|EACCES|EPERM|EISDIR/i.test(original) ||
          /found \d+ occurrences/i.test(original) ||
          /dangerous pattern/i.test(original);

        if (!isToolError) {
          const exists = antiPatterns.patterns.some(p => p.error === original.slice(0, 100));
          if (!exists) {
            newAntiPatterns.push({
              error: original.slice(0, 100),
              fix: content.slice(0, 150),
              confidence: node.confidence,
              source: node.project_id,
            });
          }
        }
      }
    }
  }

  // ── C1: Frequency-based tool promotion ─────────────────────────────────────
  // Scan ALL high-confidence nodes (not just current batch) and count how many
  // distinct node_ids mention each tool name. Tools appearing in 3+ separate
  // nodes are genuine preferences — behavioural signal, not just one sentence.
  const FREQUENCY_THRESHOLD = 3;
  const allNodes = db.prepare(`
    SELECT id, content FROM nodes
    WHERE confidence >= ? AND entity_type IN ('decision', 'lesson', 'pattern')
    ORDER BY updated_at DESC LIMIT 500
  `).all(0.65); // lower threshold for frequency scan — recurrence is the signal

  const toolFrequency = new Map(); // toolName → Set of node ids
  const positiveFreqRe = /(?:use|using|prefer(?:ring)?|chose|choosing|switch(?:ed|ing)? to|going with|went with|stick(?:ing)? with|decided on|picked|settled on|built? with)\s+([\w@/.-]{2,40})/gi;

  for (const node of allNodes) {
    const text = JSON.parse(node.content || "{}").text || "";
    for (const m of text.matchAll(positiveFreqRe)) {
      const tool = m[1].replace(/[.,;:!?]+$/, "");
      if (tool.length < 2 || /^(the|a|an|it|to|on|in|for|of|be|is|was|are|this|that)$/i.test(tool)) continue;
      if (!toolFrequency.has(tool)) toolFrequency.set(tool, new Set());
      toolFrequency.get(tool).add(node.id);
    }
  }

  for (const [tool, nodeIds] of toolFrequency.entries()) {
    if (nodeIds.size >= FREQUENCY_THRESHOLD && !newTools[tool] && !prefs.tools[tool]) {
      newTools[tool] = {
        confidence: 0.85,
        source: "frequency",
        content: `Appears in ${nodeIds.size} separate sessions — consistent usage pattern`,
        frequency: nodeIds.size,
      };
    }
  }

  // ── Merge into profile (don't overwrite existing) ───────────────────────────
  let changed = false;

  for (const [key, val] of Object.entries(newTools)) {
    if (!prefs.tools[key]) { prefs.tools[key] = val; changed = true; }
  }
  for (const [key, val] of Object.entries(newCoding)) {
    if (!prefs.coding[key]) { prefs.coding[key] = val; changed = true; }
  }
  for (const ap of newAntiPatterns) {
    antiPatterns.patterns.push(ap);
    changed = true;
  }
  // Cap anti-patterns at 50
  if (antiPatterns.patterns.length > 50) {
    antiPatterns.patterns = antiPatterns.patterns.slice(-50);
  }

  if (changed) {
    writeProfileJson("preferences.json", prefs);
    writeProfileJson("anti-patterns.json", antiPatterns);
    console.log(`[brain] Profile updated: ${Object.keys(newTools).length} tools, ${Object.keys(newCoding).length} coding, ${newAntiPatterns.length} anti-patterns`);
  }

  // Write combined profile export for claude-worker
  writeProfileExport();
}

// Add an explicit rule (from user via MCP)
function addExplicitRule(rule) {
  const rulesPath = path.join(PROFILE_DIR, "rules.md");
  let content = "";
  try { content = fs.readFileSync(rulesPath, "utf-8"); } catch {}

  // Check if rule already exists
  if (content.includes(rule)) return { added: false, reason: "Rule already exists" };

  content += `\n- ${rule}`;
  fs.writeFileSync(rulesPath, content);
  writeProfileExport();
  indexProfileAtoms().catch(() => {});
  return { added: true };
}

// Update philosophy
function updatePhilosophy(text) {
  fs.writeFileSync(path.join(PROFILE_DIR, "philosophy.md"), text);
  writeProfileExport();
  indexProfileAtoms().catch(() => {});
  return { updated: true };
}

// Update rules (full text replace)
function updateRules(text) {
  fs.writeFileSync(path.join(PROFILE_DIR, "rules.md"), text);
  writeProfileExport();
  indexProfileAtoms().catch(() => {});
  return { updated: true };
}

// Update identity (name, bio, role) — merges into identity.json
function updateIdentityJson(identity) {
  const current = readProfileJson("identity.json") || {};
  const updated = { ...current, ...identity };
  fs.writeFileSync(path.join(PROFILE_DIR, "identity.json"), JSON.stringify(updated, null, 2));
  writeProfileExport();
  indexProfileAtoms().catch(() => {});
  return { updated: true };
}

// Update identity DNA (compiled bio text) — writes directly to compiled-identity.txt
function updateIdentityDna(dna) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_CACHE_PATH, dna, "utf-8");
  return { updated: true };
}

// Save avatar (base64 data → file)
function saveAvatar(base64Data, mimeType) {
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const avatarPath = path.join(PROFILE_DIR, `avatar.${ext}`);

  // Remove old avatars
  for (const old of ["avatar.png", "avatar.jpg", "avatar.webp"]) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, old)); } catch {}
  }

  // Write new avatar
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(avatarPath, buffer);

  // Update identity.json with avatar path
  const identity = readProfileJson("identity.json") || {};
  identity.avatar = avatarPath;
  fs.writeFileSync(path.join(PROFILE_DIR, "identity.json"), JSON.stringify(identity, null, 2));

  return { path: avatarPath };
}

// Build the combined profile export that claude-worker reads
function writeProfileExport() {
  const identity = readProfileJson("identity.json");
  const prefs = readProfileJson("preferences.json");
  const antiPatterns = readProfileJson("anti-patterns.json");
  const style = readProfileJson("style.json");
  const rules = readProfileMd("rules.md");
  const philosophy = readProfileMd("philosophy.md");

  const sections = [];

  // Identity first — who is this person
  if (identity?.name) {
    const idParts = [`# ${identity.name}`];
    if (identity.role) idParts.push(identity.role);
    if (identity.bio) idParts.push(identity.bio);
    sections.push(idParts.join("\n"));
  }

  // Philosophy
  if (philosophy && philosophy.trim().length > 0) {
    sections.push("## Design Philosophy\n" + philosophy);
  }

  // Explicit rules (highest priority)
  if (rules && rules.trim().length > 0) {
    sections.push("## Rules\n" + rules);
  }

  // Observed preferences (only if there are any)
  if (prefs) {
    const toolEntries = Object.entries(prefs.tools || {});
    const codingEntries = Object.entries(prefs.coding || {});

    if (toolEntries.length > 0 || codingEntries.length > 0) {
      const parts = ["## Observed Preferences"];
      if (toolEntries.length > 0) {
        parts.push("### Tools & Libraries");
        for (const [tool, info] of toolEntries.slice(0, 10)) {
          parts.push(`- Prefers **${tool}**: ${info.content}`);
        }
      }
      if (codingEntries.length > 0) {
        parts.push("### Coding Patterns");
        for (const [, info] of codingEntries.slice(0, 10)) {
          parts.push(`- ${info.content}`);
        }
      }
      sections.push(parts.join("\n"));
    }
  }

  // Anti-patterns
  if (antiPatterns?.patterns?.length > 0) {
    const parts = ["## Known Anti-Patterns"];
    for (const ap of antiPatterns.patterns.slice(-10)) {
      parts.push(`- Avoid: ${ap.error} → Fix: ${ap.fix}`);
    }
    sections.push(parts.join("\n"));
  }

  const combined = sections.join("\n\n");

  try {
    fs.writeFileSync(path.join(PROFILE_DIR, "profile-export.md"), combined);
  } catch {}

  return combined;
}

// Get full profile for MCP/display
function getProfile() {
  let identityStr = "";
  try { identityStr = fs.readFileSync(IDENTITY_CACHE_PATH, "utf-8").trim(); } catch { /* identity not compiled yet */ }
  return {
    identity: readProfileJson("identity.json"),
    preferences: readProfileJson("preferences.json"),
    antiPatterns: readProfileJson("anti-patterns.json"),
    style: readProfileJson("style.json"),
    rules: readProfileMd("rules.md"),
    philosophy: readProfileMd("philosophy.md"),
    dna: identityStr,
  };
}

// --- Message Handler ---

process.parentPort.on("message", async ({ data }) => {
  try {
    switch (data.type) {
      case "llm_call_result": {
        // Response from main for an llm_call request — route to pending promise
        _handleLlmCallResult(data.callId, data.result);
        break;
      }

      case "index_events": {
        const result = await indexEvents(data.projectId, data.events);
        sendToMain({ type: "indexed", requestId: data.requestId, ...result });

        // Phase 5: Outcome tracking — decision→result feedback loops
        trackOutcomes(data.projectId, data.events);

        // Phase 5: Tension detection from new decisions
        const newDecisions = data.events.filter(e => e.type === "decision");
        if (newDecisions.length > 0 && embedderReady) {
          const tensions = await detectTensions(data.projectId, newDecisions);
          if (tensions.length > 0) {
            sendToMain({ type: "tensions_detected", projectId: data.projectId, tensions });
          }

          // Phase 5: Cross-project pattern transfer
          // Build node-like objects for newly indexed decisions/lessons/patterns
          const newNodes = data.events
            .filter(e => ["decision", "lesson", "pattern", "error_fix"].includes(e.type))
            .map(e => ({ id: nodeId(e.type, e.content || ""), content: e.content || "" }));
          if (newNodes.length > 0) {
            const crossEdges = await crossProjectTransfer(data.projectId, newNodes);
            if (crossEdges > 0) {
              console.log(`[brain] Created ${crossEdges} cross-project edges for ${data.projectId}`);
            }
          }
        }

        // Phase 5: Confidence decay (run occasionally — every ~10th indexing call)
        if (Math.random() < 0.1) {
          const decayed = decayStaleNodes(data.projectId);
          if (decayed > 0) console.log(`[brain] Decayed ${decayed} stale nodes in ${data.projectId}`);
        }

        const hasMeaningfulEvents = data.events.some(e =>
          ["decision", "lesson", "pattern", "error_fix"].includes(e.type)
        );

        // Phase 6: Profile extraction — run whenever meaningful events exist.
        // Cheap (SQLite reads + JSON writes), no reason to skip.
        if (hasMeaningfulEvents) {
          extractPreferences();
        }

        break;
      }

      case "search": {
        const results = await search(data.query, data.projectId, data.limit || 10);
        sendToMain({ type: "search_result", requestId: data.requestId, results });
        break;
      }

      case "contextual_search": {
        const result = await writeContextualExport(data.projectId, data.query, data.fileContext, data.intent, data.projectRoot || null, data.taskType || null, data.atomHints || [], data.projectWhy || "");
        sendToMain({ type: "contextual_result", requestId: data.requestId, ...result });
        break;
      }

      case "embed_texts": {
        // Batch-embed arbitrary texts (turn summaries, query, etc.).
        // Returns base64-encoded Float32Arrays for IPC transfer to main process.
        if (!embedderReady || !_embedPipeline) {
          sendToMain({ type: "embed_texts_result", requestId: data.requestId, embeddings: {} });
          break;
        }
        const texts = data.texts || [];
        const embeddings = await embedBatch(texts);
        const result = {};
        for (const [text, emb] of embeddings) {
          if (emb) {
            result[text] = Buffer.from(emb.buffer).toString("base64");
          } else {
            result[text] = null;
          }
        }
        sendToMain({ type: "embed_texts_result", requestId: data.requestId, embeddings: result });
        break;
      }

      case "codebase_compass": {
        const result = await findCodebaseCompass(data.query, data.projectId, data.projectRoot, data.limit || 8);
        sendToMain({ type: "codebase_compass_result", requestId: data.requestId, result });
        break;
      }

      case "index_project_files": {
        // Fire-and-forget: respond immediately, index in background
        sendToMain({ type: "index_project_files_ack", requestId: data.requestId });

        // Backfill events.jsonl for this project on first access.
        // backfillAll() only runs on startup when the DB is empty; new projects
        // added later need their pre-existing events indexed here.
        backfillProject(data.projectId).catch(() => {});

        // Symbol indexing runs first (fast, no LLM) — file summarization runs in parallel
        Promise.all([
          // Layer 1: Symbol index (regex, no LLM, fast)
          (async () => {
            if (!db) return;
            try {
              const { added, files_changed } = indexProjectSymbols(db, data.projectId, data.projectRoot, walkProjectFiles);
              if (added > 0 || files_changed > 0) {
                writeSymbolExport(db, data.projectId, BRAIN_DIR);
              }
            } catch (err) {
              console.error("[brain] symbol indexing error:", err.message);
            }
          })(),
          // LLM file summarization (slow, requires provider)
          indexProjectFiles(data.projectId, data.projectRoot).catch(err =>
            console.error("[brain] indexProjectFiles error:", err.message)
          ),
        ]);
        break;
      }

      case "find_symbols": {
        if (!db) { sendToMain({ type: "symbols_result", requestId: data.requestId, symbols: [] }); break; }
        const symbols = findSymbols(db, data.projectId, data.query, {
          kind: data.kind,
          file: data.file,
          limit: data.limit || 20,
        });
        sendToMain({ type: "symbols_result", requestId: data.requestId, symbols });
        break;
      }

      case "prune": {
        // Explicitly prune low-confidence nodes and orphaned edges.
        // Called on startup for all projects, or on-demand via brainRequest.
        if (!db) { sendToMain({ type: "prune_result", requestId: data.requestId, pruned: 0, deletedEdges: 0 }); break; }
        const result = pruneOldNodes(data.projectId);
        sendToMain({ type: "prune_result", requestId: data.requestId, ...result });
        break;
      }

      case "get_file_symbols": {
        if (!db) { sendToMain({ type: "file_symbols_result", requestId: data.requestId, symbols: [] }); break; }
        const fileSyms = getFileSymbols(db, data.projectId, data.filePath);
        sendToMain({ type: "file_symbols_result", requestId: data.requestId, symbols: fileSyms });
        break;
      }

      case "reindex_file_symbols": {
        // Called when a specific file changes (from file watcher)
        if (!db) { sendToMain({ type: "file_symbols_reindexed", requestId: data.requestId }); break; }
        try {
          const result = indexFileSymbols(db, data.projectId, data.filePath, data.projectRoot);
          if (!result.skipped) {
            writeSymbolExport(db, data.projectId, BRAIN_DIR);
          }
          sendToMain({ type: "file_symbols_reindexed", requestId: data.requestId, ...result });
        } catch (err) {
          console.error("[brain] reindex_file_symbols error:", err.message);
          sendToMain({ type: "file_symbols_reindexed", requestId: data.requestId, skipped: true });
        }
        break;
      }

      case "session_pins_get": {
        const pins = readSessionPins(data.projectId);
        sendToMain({ type: "session_pins_result", requestId: data.requestId, pins });
        break;
      }

      case "session_pins_clear": {
        clearSessionPins(data.projectId);
        sendToMain({ type: "session_pins_cleared", requestId: data.requestId });
        break;
      }

      case "get_related": {
        if (!db) break;
        const edges = db._stmts.getEdgesFor.all(data.nodeId, data.nodeId);
        db._stmts.bumpAccess.run(data.nodeId);
        sendToMain({ type: "related_result", requestId: data.requestId, edges });
        break;
      }

      case "get_stats": {
        if (!db) break;
        const stats = db._stmts.getStats.get();
        sendToMain({ type: "stats_result", requestId: data.requestId, ...stats });
        break;
      }

      case "get_intelligence_stats": {
        const intStats = getIntelligenceStats(data.projectId);
        sendToMain({ type: "intelligence_stats_result", requestId: data.requestId, stats: intStats });
        break;
      }

      case "get_all_projects": {
        // Return all project IDs that have nodes in the brain database
        if (!db) { sendToMain({ type: "all_projects_result", requestId: data.requestId, projects: [] }); break; }
        const rows = db._stmts.getAllProjects.all();
        sendToMain({ type: "all_projects_result", requestId: data.requestId, projects: rows.map(r => r.project_id) });
        break;
      }

      case "vacuum": {
        // Reclaim disk space by rebuilding the database file
        if (!db) break;
        try {
          db.exec("VACUUM");
          console.log("[brain] Database vacuum complete");
        } catch (err) {
          console.warn(`[brain] Vacuum failed: ${err.message}`);
        }
        sendToMain({ type: "vacuum_result", requestId: data.requestId });
        break;
      }

      case "backfill": {
        await backfillAll();
        break;
      }

      case "get_profile": {
        const profile = getProfile();
        sendToMain({ type: "profile_result", requestId: data.requestId, profile });
        break;
      }

      case "add_rule": {
        const result = addExplicitRule(data.rule);
        sendToMain({ type: "rule_result", requestId: data.requestId, ...result });
        break;
      }

      case "update_philosophy": {
        const result = updatePhilosophy(data.text);
        sendToMain({ type: "philosophy_result", requestId: data.requestId, ...result });
        break;
      }

      case "update_rules": {
        const result = updateRules(data.text);
        sendToMain({ type: "rules_result", requestId: data.requestId, ...result });
        break;
      }

      case "extract_profile": {
        extractPreferences();
        sendToMain({ type: "profile_extracted", requestId: data.requestId });
        break;
      }

      case "update_preferences_from_llm": {
        // Merge LLM-extracted preferences into profile files.
        // Runs after each conversation turn — complements regex extraction.
        const { extracted } = data;
        if (!extracted) break;

        const prefs = readProfileJson("preferences.json") || { coding: {}, communication: {}, tools: {}, _meta: {} };
        const antiPatterns = readProfileJson("anti-patterns.json") || { patterns: [], _meta: {} };
        let changed = false;

        // Tools
        for (const t of (extracted.tools || [])) {
          if (!t.name || t.name.length < 2) continue;
          const key = t.prefers === false ? `avoid:${t.name}` : t.name;
          if (!prefs.tools[key]) {
            prefs.tools[key] = {
              confidence: 0.8,
              source: "llm_extraction",
              content: t.evidence?.slice(0, 150) || t.name,
              prefers: t.prefers !== false,
            };
            changed = true;
          }
        }

        // Patterns
        for (const p of (extracted.patterns || [])) {
          if (!p.pattern || p.pattern.length < 5) continue;
          const key = p.pattern.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
          if (key.length > 4 && !prefs.coding[key]) {
            prefs.coding[key] = {
              confidence: 0.8,
              source: "llm_extraction",
              content: `${p.pattern}: ${p.evidence || ""}`.slice(0, 200),
            };
            changed = true;
          }
        }

        // Corrections → anti-patterns
        for (const c of (extracted.corrections || [])) {
          if (!c.toward || !c.away_from) continue;
          const error = `Using ${c.away_from} instead of ${c.toward}`.slice(0, 100);
          const exists = antiPatterns.patterns.some(ap => ap.error === error);
          if (!exists) {
            antiPatterns.patterns.push({
              error,
              fix: `Prefer ${c.toward}. ${c.evidence || ""}`.slice(0, 150),
              confidence: 0.8,
              source: "llm_extraction",
            });
            changed = true;
          }
        }

        if (changed) {
          writeProfileJson("preferences.json", prefs);
          writeProfileJson("anti-patterns.json", antiPatterns);
          writeProfileExport();
          // Re-index profile atoms so new preferences are semantically searchable
          indexProfileAtoms().catch(() => {});
          console.log(`[brain] LLM extraction merged: ${(extracted.tools||[]).length} tools, ${(extracted.patterns||[]).length} patterns, ${(extracted.corrections||[]).length} corrections`);
        }

        sendToMain({ type: "llm_preferences_updated", requestId: data.requestId, changed });
        break;
      }

      case "reindex_profile_atoms": {
        await indexProfileAtoms();
        sendToMain({ type: "profile_atoms_indexed", requestId: data.requestId });
        break;
      }

      case "update_identity": {
        const result = updateIdentityJson(data.identity);
        sendToMain({ type: "identity_result", requestId: data.requestId, ...result });
        break;
      }

      case "update_dna": {
        const result = updateIdentityDna(data.dna);
        sendToMain({ type: "dna_result", requestId: data.requestId, ...result });
        break;
      }

      case "save_avatar": {
        const result = saveAvatar(data.base64Data, data.mimeType);
        sendToMain({ type: "avatar_result", requestId: data.requestId, ...result });
        break;
      }

      case "get_avatar": {
        const ident = readProfileJson("identity.json");
        if (ident?.avatar) {
          try {
            const avatarBuf = fs.readFileSync(ident.avatar);
            const ext = path.extname(ident.avatar).slice(1);
            const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
            sendToMain({ type: "avatar_data", requestId: data.requestId, base64: avatarBuf.toString("base64"), mime });
          } catch {
            sendToMain({ type: "avatar_data", requestId: data.requestId, base64: null, mime: null });
          }
        } else {
          sendToMain({ type: "avatar_data", requestId: data.requestId, base64: null, mime: null });
        }
        break;
      }

      case "mind_add": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const id = `mind-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const embedding = await embed(data.content);
        const embeddingBuffer = embedding ? Buffer.from(embedding.buffer) : null;
        const projectId = data.projectId || null;
        db.prepare(`INSERT INTO mind_entries (id, content, embedding, project_id) VALUES (?, ?, ?, ?)`).run(id, data.content, embeddingBuffer, projectId);
        const entry = db.prepare(`SELECT * FROM mind_entries WHERE id = ?`).get(id);
        sendToMain({ type: "mind_entry", requestId: data.requestId, entry });
        break;
      }

      case "mind_get_all": {
        if (!db) { sendToMain({ type: "mind_entries", requestId: data.requestId, entries: [] }); break; }
        const entries = db.prepare(`SELECT * FROM mind_entries ORDER BY completed ASC, updated_at DESC`).all();
        sendToMain({ type: "mind_entries", requestId: data.requestId, entries });
        break;
      }

      case "mind_update": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        let embeddingBuffer = null;
        if (data.content !== undefined) {
          const embedding = await embed(data.content);
          embeddingBuffer = embedding ? Buffer.from(embedding.buffer) : null;
        }

        if (data.content !== undefined && data.completed !== undefined) {
          db.prepare(`UPDATE mind_entries SET content = ?, completed = ?, embedding = ?, updated_at = datetime('now') WHERE id = ?`).run(data.content, data.completed ? 1 : 0, embeddingBuffer, data.id);
        } else if (data.content !== undefined) {
          db.prepare(`UPDATE mind_entries SET content = ?, embedding = ?, updated_at = datetime('now') WHERE id = ?`).run(data.content, embeddingBuffer, data.id);
        } else if (data.completed !== undefined) {
          db.prepare(`UPDATE mind_entries SET completed = ?, updated_at = datetime('now') WHERE id = ?`).run(data.completed ? 1 : 0, data.id);
        }
        const entry = db.prepare(`SELECT * FROM mind_entries WHERE id = ?`).get(data.id);
        sendToMain({ type: "mind_entry", requestId: data.requestId, entry: entry ?? null });
        break;
      }

      case "mind_delete": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        db.prepare(`DELETE FROM mind_entries WHERE id = ?`).run(data.id);
        sendToMain({ type: "mind_deleted", requestId: data.requestId, id: data.id });
        break;
      }

      case "mind_thread_create": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const threadId = `mt-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        db.prepare(`INSERT INTO mind_threads (id, entry_id) VALUES (?, ?)`).run(threadId, data.entry_id);
        const thread = db.prepare(`SELECT * FROM mind_threads WHERE id = ?`).get(threadId);
        sendToMain({ type: "mind_thread", requestId: data.requestId, thread });
        break;
      }

      case "mind_thread_get": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const thread = db.prepare(`SELECT * FROM mind_threads WHERE entry_id = ? ORDER BY updated_at DESC LIMIT 1`).get(data.entry_id);
        let turns = [];
        if (thread) {
          turns = db.prepare(`SELECT * FROM mind_turns WHERE thread_id = ? ORDER BY timestamp ASC`).all(thread.id);
        }
        sendToMain({ type: "mind_thread_data", requestId: data.requestId, thread: thread || null, turns: turns || [] });
        break;
      }

      case "mind_thread_list_entry_ids": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const rows = db.prepare(`SELECT DISTINCT entry_id FROM mind_threads`).all();
        sendToMain({ type: "mind_thread_entry_ids", requestId: data.requestId, entryIds: rows.map(r => r.entry_id) });
        break;
      }

      case "mind_thread_add_turn": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const turnId = `mtu-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        db.prepare(`INSERT INTO mind_turns (id, thread_id, role, content_json) VALUES (?, ?, ?, ?)`).run(turnId, data.thread_id, data.role, data.content_json);
        db.prepare(`UPDATE mind_threads SET updated_at = datetime('now') WHERE id = ?`).run(data.thread_id);
        const turn = db.prepare(`SELECT * FROM mind_turns WHERE id = ?`).get(turnId);
        sendToMain({ type: "mind_turn", requestId: data.requestId, turn });
        break;
      }

      case "mind_thread_set_session": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        db.prepare(`UPDATE mind_threads SET session_id = ?, updated_at = datetime('now') WHERE id = ?`).run(data.session_id, data.thread_id);
        sendToMain({ type: "mind_thread_session_set", requestId: data.requestId });
        break;
      }

      case "mind_thread_delete": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        db.prepare(`DELETE FROM mind_turns WHERE thread_id = ?`).run(data.id);
        db.prepare(`DELETE FROM mind_threads WHERE id = ?`).run(data.id);
        sendToMain({ type: "mind_thread_deleted", requestId: data.requestId, id: data.id });
        break;
      }

      case "memory_lifecycle": {
        // Run the full memory lifecycle: decay → consolidate → graduate
        if (!db) { sendToMain({ type: "memory_lifecycle_done", requestId: data.requestId }); break; }
        try {
          // Always enable consolidation — consolidateMemories() has internal guards
          // (CONSOLIDATION_THRESHOLD, similarity clustering) and only calls the LLM
          // when there are actually clusters to synthesize. The old caller-side
          // Math.random() < 0.1 gate in main.mjs was pure waste.
          const result = await runMemoryLifecycle(db, data.projectId, llmCall);
          sendToMain({ type: "memory_lifecycle_done", requestId: data.requestId, result });
        } catch (err) {
          console.error("[brain] memory lifecycle error:", err.message);
          sendToMain({ type: "memory_lifecycle_done", requestId: data.requestId, error: err.message });
        }
        break;
      }

      case "memory_touch": {
        // Record that memories were accessed (prevents decay)
        if (!db) break;
        for (const nodeId of (data.nodeIds || [])) {
          touchMemory(db, nodeId);
        }
        break;
      }

      case "memory_reinforce": {
        // Boost a memory that proved useful
        if (!db) break;
        reinforceMemory(db, data.nodeId);
        break;
      }

      case "decay_completed_task": {
        // Completion propagation: decay brain nodes related to a finished task
        // and mark matching mind entries as completed.
        if (!db) {
          sendToMain({ type: "decay_completed_task_result", requestId: data.requestId, nodesDecayed: 0, mindMarked: 0 });
          break;
        }

        let nodesDecayed = 0;
        let mindMarked = 0;
        const decayAmount = data.decayAmount || 0.3;
        const threshold = data.similarityThreshold || 0.7;

        try {
          const taskEmbedding = embedderReady ? await embed(data.taskDescription) : null;

          if (taskEmbedding) {
            // Find and decay matching brain nodes
            const projectNodes = db.prepare(
              `SELECT id, embedding, confidence FROM nodes WHERE project_id = ? AND embedding IS NOT NULL AND confidence > 0.2`
            ).all(data.projectId);

            for (const node of projectNodes) {
              const nodeEmb = new Float32Array(new Uint8Array(node.embedding).buffer);
              const similarity = cosineSimilarity(taskEmbedding, nodeEmb);
              if (similarity >= threshold) {
                db._stmts.lowerConfidence.run(decayAmount, node.id);
                nodesDecayed++;
              }
            }

            // Also check completed todos for additional matches
            for (const todo of (data.completedTodos || [])) {
              const todoEmbedding = await embed(todo);
              if (!todoEmbedding) continue;
              for (const node of projectNodes) {
                const nodeEmb = new Float32Array(new Uint8Array(node.embedding).buffer);
                const similarity = cosineSimilarity(todoEmbedding, nodeEmb);
                if (similarity >= threshold) {
                  // Only decay if not already decayed by task description
                  const current = db.prepare(`SELECT confidence FROM nodes WHERE id = ?`).get(node.id);
                  if (current && current.confidence > 0.2) {
                    db._stmts.lowerConfidence.run(decayAmount * 0.5, node.id);
                    nodesDecayed++;
                  }
                }
              }
            }

            // Mark matching mind entries as completed
            const mindEntries = db.prepare(
              `SELECT id, content, embedding FROM mind_entries WHERE completed = 0 AND embedding IS NOT NULL`
            ).all();

            for (const entry of mindEntries) {
              const entryEmb = new Float32Array(new Uint8Array(entry.embedding).buffer);
              const similarity = cosineSimilarity(taskEmbedding, entryEmb);
              if (similarity >= threshold) {
                db.prepare(`UPDATE mind_entries SET completed = 1, updated_at = datetime('now') WHERE id = ?`).run(entry.id);
                mindMarked++;
              }
            }
          }
        } catch (err) {
          console.warn("[brain] decay_completed_task error (non-fatal):", err.message);
        }

        sendToMain({ type: "decay_completed_task_result", requestId: data.requestId, nodesDecayed, mindMarked });
        break;
      }

      case "lens_post_add": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const id = `lp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const created_at = new Date().toISOString();
        db.prepare(`INSERT INTO lens_posts (id, contributor, content, project_id, entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, data.contributor, data.content, data.projectId ?? null, data.entryId ?? null, created_at);
        const post = { id, contributor: data.contributor, content: data.content, project_id: data.projectId ?? null, entry_id: data.entryId ?? null, created_at };
        sendToMain({ type: "lens_post", requestId: data.requestId, post });
        break;
      }

      case "lens_posts_list": {
        if (!db) { sendToMain({ type: "lens_posts", requestId: data.requestId, posts: [] }); break; }
        const posts = db.prepare(`
          SELECT lp.*, COUNT(lc.id) as comment_count
          FROM lens_posts lp
          LEFT JOIN lens_comments lc ON lc.post_id = lp.id
          WHERE lp.project_id = ?
          GROUP BY lp.id
          ORDER BY lp.created_at ASC
        `).all(data.projectId ?? null);
        sendToMain({ type: "lens_posts", requestId: data.requestId, posts });
        break;
      }

      case "lens_post_get": {
        if (!db) { sendToMain({ type: "lens_post", requestId: data.requestId, post: null }); break; }
        const post = db.prepare(`SELECT * FROM lens_posts WHERE id = ?`).get(data.postId);
        sendToMain({ type: "lens_post", requestId: data.requestId, post: post ?? null });
        break;
      }

      case "lens_post_delete": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        // Delete post and cascade to all comments
        const delPost = db.prepare(`DELETE FROM lens_posts WHERE id = ? RETURNING *`).get(data.postId);
        const delComments = db.prepare(`DELETE FROM lens_comments WHERE post_id = ?`).run(data.postId);
        sendToMain({ type: "lens_post_deleted", requestId: data.requestId, deleted: true });
        break;
      }

      case "lens_comments_list": {
        if (!db) { sendToMain({ type: "lens_comments", requestId: data.requestId, comments: [] }); break; }
        const comments = db.prepare(`SELECT * FROM lens_comments WHERE post_id = ? ORDER BY timestamp ASC`).all(data.postId);
        sendToMain({ type: "lens_comments", requestId: data.requestId, comments });
        break;
      }

      case "lens_comment_add": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const commentId = `lc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const commentTimestamp = new Date().toISOString();
        db.prepare(`INSERT INTO lens_comments (id, post_id, role, content, session_id, timestamp) VALUES (?, ?, ?, ?, NULL, ?)`).run(commentId, data.postId, data.role, data.content, commentTimestamp);
        const comment = { id: commentId, post_id: data.postId, role: data.role, content: data.content, session_id: null, timestamp: commentTimestamp };
        sendToMain({ type: "lens_comment", requestId: data.requestId, comment });
        break;
      }

      case "lens_comment_set_session": {
        if (!db) { sendToMain({ type: "lens_comment_session_set", requestId: data.requestId }); break; }
        db.prepare(`UPDATE lens_comments SET session_id = ? WHERE post_id = ? AND session_id IS NULL`).run(data.sessionId, data.postId);
        sendToMain({ type: "lens_comment_session_set", requestId: data.requestId });
        break;
      }

      // ── Review session handlers ──────────────────────────────────────────
      case "review_session_create": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const rsId = `rs-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const rsCreated = new Date().toISOString();
        db.prepare(`INSERT INTO review_sessions (id, project_id, status, diff_summary, base_ref, punk_count, created_at) VALUES (?, ?, 'running', ?, ?, ?, ?)`).run(
          rsId, data.projectId, data.diffSummary ?? null, data.baseRef ?? null, data.punkCount ?? 0, rsCreated
        );
        sendToMain({ type: "review_session", requestId: data.requestId, session: { id: rsId, project_id: data.projectId, status: "running", created_at: rsCreated } });
        break;
      }

      case "review_session_complete": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const rsCompleted = new Date().toISOString();
        db.prepare(`UPDATE review_sessions SET status = ?, completed_at = ?, base_ref = ?, finding_count = ? WHERE id = ?`).run(
          data.status ?? "completed", rsCompleted, data.baseRef ?? null, data.findingCount ?? 0, data.sessionId
        );
        sendToMain({ type: "review_session_updated", requestId: data.requestId });
        break;
      }

      case "review_finding_add": {
        if (!db) { sendToMain({ type: "error", requestId: data.requestId, error: "db not ready" }); break; }
        const rfId = `rf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const rfCreated = new Date().toISOString();
        db.prepare(`INSERT INTO punk_findings (id, session_id, project_id, punk, severity, finding, structured, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          rfId, data.sessionId, data.projectId, data.punk, data.severity, data.finding, data.structured ?? "{}", data.location ?? null, rfCreated
        );
        sendToMain({ type: "review_finding", requestId: data.requestId, finding: { id: rfId, session_id: data.sessionId, project_id: data.projectId, punk: data.punk, severity: data.severity, finding: data.finding, structured: data.structured ?? "{}", location: data.location, created_at: rfCreated } });
        break;
      }

      case "review_findings_list": {
        if (!db) { sendToMain({ type: "review_findings", requestId: data.requestId, findings: [] }); break; }
        const rfFindings = db.prepare(`SELECT * FROM punk_findings WHERE session_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, punk, created_at`).all(data.sessionId);
        sendToMain({ type: "review_findings", requestId: data.requestId, findings: rfFindings });
        break;
      }

      case "review_sessions_list": {
        if (!db) { sendToMain({ type: "review_sessions", requestId: data.requestId, sessions: [] }); break; }
        const rsSessions = db.prepare(`SELECT * FROM review_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).all(data.projectId);
        sendToMain({ type: "review_sessions", requestId: data.requestId, sessions: rsSessions });
        break;
      }

      case "review_session_latest": {
        if (!db) { sendToMain({ type: "review_session_latest", requestId: data.requestId, session: null, findings: [] }); break; }
        const rsLatest = db.prepare(`SELECT * FROM review_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`).get(data.projectId);
        let rsFindings = [];
        if (rsLatest) {
          rsFindings = db.prepare(`SELECT * FROM punk_findings WHERE session_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, punk`).all(rsLatest.id);
        }
        sendToMain({ type: "review_session_latest", requestId: data.requestId, session: rsLatest ?? null, findings: rsFindings });
        break;
      }

      // ── Punk finding queries for Lens v2 ──────────────────────────────────
      case "findings_list": {
        if (!db) { sendToMain({ type: "findings_list_result", requestId: data.requestId, findings: [] }); break; }
        const fList = db.prepare(`
          SELECT * FROM punk_findings
          WHERE project_id = ? AND dismissed = 0
          ORDER BY created_at DESC
          LIMIT ?
        `).all(data.projectId, data.limit ?? 50);
        sendToMain({ type: "findings_list_result", requestId: data.requestId, findings: fList });
        break;
      }

      case "findings_by_punk": {
        if (!db) { sendToMain({ type: "findings_by_punk_result", requestId: data.requestId, findings: [] }); break; }
        const fByPunk = db.prepare(`
          SELECT * FROM punk_findings
          WHERE project_id = ? AND punk = ? AND dismissed = 0
          ORDER BY created_at DESC
          LIMIT ?
        `).all(data.projectId, data.punk, data.limit ?? 50);
        sendToMain({ type: "findings_by_punk_result", requestId: data.requestId, findings: fByPunk });
        break;
      }

      case "finding_dismiss": {
        if (!db) { sendToMain({ type: "finding_dismiss_result", requestId: data.requestId, success: false }); break; }
        db.prepare(`UPDATE punk_findings SET dismissed = 1 WHERE id = ?`).run(data.findingId);
        sendToMain({ type: "finding_dismiss_result", requestId: data.requestId, success: true });
        break;
      }

      // ── Knowledge graph queries ──────────────────────────────────────────
      case "knowledge_graph": {
        if (!db) { sendToMain({ type: "knowledge_graph_result", requestId: data.requestId, error: "db not ready" }); break; }

        const kgProjectId = data.projectId;

        // Get type counts (exclude system atoms and profile atoms)
        const typeCounts = db.prepare(`
          SELECT entity_type, COUNT(*) as count
          FROM nodes
          WHERE project_id = ? AND entity_type NOT IN ('system_atom', 'profile_atom')
          GROUP BY entity_type
          ORDER BY count DESC
        `).all(kgProjectId);

        // Get top nodes (highest confidence, most accessed)
        const topNodes = db.prepare(`
          SELECT id, name, entity_type, content, confidence, access_count, priority
          FROM nodes
          WHERE project_id = ? AND entity_type NOT IN ('project', 'system_atom', 'profile_atom')
            AND content != '{}'
          ORDER BY confidence DESC, access_count DESC
          LIMIT 20
        `).all(kgProjectId);

        // Parse node content from JSON storage format
        const parsedNodes = topNodes.map(n => {
          let content = n.content;
          try {
            const parsed = JSON.parse(n.content);
            content = parsed.text || parsed.content || n.name;
          } catch {
            content = n.content || n.name;
          }
          return {
            id: n.id,
            name: n.name,
            entity_type: n.entity_type,
            content: typeof content === "string" ? content.slice(0, 500) : String(content).slice(0, 500),
            confidence: n.confidence,
            access_count: n.access_count,
          };
        });

        // Get edge summary for this project's nodes
        const edges = db.prepare(`
          SELECT e.type, COUNT(*) as count
          FROM edges e
          WHERE e.source_id IN (SELECT id FROM nodes WHERE project_id = ?)
             OR e.target_id IN (SELECT id FROM nodes WHERE project_id = ?)
          GROUP BY e.type
          ORDER BY count DESC
        `).all(kgProjectId, kgProjectId);

        const edgeTypes = {};
        let totalEdges = 0;
        for (const e of edges) {
          edgeTypes[e.type] = e.count;
          totalEdges += e.count;
        }

        sendToMain({
          type: "knowledge_graph_result",
          requestId: data.requestId,
          typeCounts,
          nodes: parsedNodes,
          edgeTypes,
          totalEdges,
        });
        break;
      }

      case "shutdown": {
        if (db) db.close();
        process.exit(0);
      }
    }
  } catch (err) {
    console.error("[brain] Error handling message:", err);
    if (data.requestId) {
      sendToMain({ type: "error", requestId: data.requestId, error: err.message });
    }
  }
});

// --- Startup ---

try {
  initDatabase();
  initProfile();
  console.log("[brain] Database + profile initialized");

  // Embedding model loads lazily on first embed() call — no 500MB WASM heap at startup
  // Check if backfill needed (empty DB but events exist)
  const stats = db._stmts.getStats.get();
  if (stats.node_count === 0) {
    backfillAll().catch(err => console.error("[brain] Backfill error:", err));
  }
} catch (err) {
  console.error("[brain] Startup error:", err);
}

// Keep process alive
process.parentPort.start();
