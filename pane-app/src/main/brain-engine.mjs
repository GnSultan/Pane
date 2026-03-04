// Pane Brain Engine — UtilityProcess that owns the knowledge graph, embeddings, and semantic search.
// Isolated V8 — if the brain crashes, Pane and Claude keep working.
// Same pattern as claude-worker.mjs and pty-worker.mjs.

import __cjs_mod__ from "node:module";
const require2 = __cjs_mod__.createRequire(import.meta.url);
const Database = require2("better-sqlite3");

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const BRAIN_DIR = path.join(os.homedir(), ".pane", "brain");
const MEMORY_DIR = path.join(os.homedir(), ".pane", "memory");
const PROFILE_DIR = path.join(os.homedir(), ".pane", "profile");
const EXPORTS_DIR = path.join(BRAIN_DIR, "exports");
const MODEL_CACHE = path.join(BRAIN_DIR, "models");

// --- State ---
let db = null;
let embedder = null;
let embedderLoading = false;
let embedderReady = false;

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
      access_count INTEGER DEFAULT 0
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
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
  `);

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
    getAllProjectNodes: db.prepare(`SELECT * FROM nodes WHERE project_id = ? AND embedding IS NOT NULL`),
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
  };
}

// --- Embedder (lazy-loaded, WASM-based) ---

async function loadEmbedder() {
  if (embedderReady || embedderLoading) return;
  embedderLoading = true;

  try {
    // Dynamic import — @huggingface/transformers is pure ESM
    const { pipeline, env } = await import("@huggingface/transformers");

    // Cache models locally
    env.cacheDir = MODEL_CACHE;
    // Use WASM backend (no native ONNX needed)
    env.backends.onnx.wasm.numThreads = 1;

    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
      revision: "main",
    });

    embedderReady = true;
    sendToMain({ type: "embedder_ready" });
    console.log("[brain] Embedding model loaded");
  } catch (err) {
    console.error("[brain] Failed to load embedding model:", err.message);
    // Brain still works without embeddings — just no semantic search
    embedderLoading = false;
  }
}

async function embed(text) {
  if (!embedderReady || !embedder) return null;
  try {
    const result = await embedder(text, { pooling: "mean", normalize: true });
    return new Float32Array(result.data);
  } catch {
    return null;
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Vectors are already normalized, so dot product = cosine similarity
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
        const embeddingBuffer = Buffer.from(embedding.buffer);
        db._stmts.insertNode.run(id, name, event.type, projectId, JSON.stringify({ text: content, metadata: event.metadata || {} }), embeddingBuffer, 0.5);
      } else {
        // Embedding failed — insert without
        db._stmts.insertNode.run(id, name, event.type, projectId, JSON.stringify({ text: content, metadata: event.metadata || {} }), null, 0.5);
      }
    } else {
      // Embedder not ready — insert without embedding
      db._stmts.insertNode.run(id, name, event.type, projectId, JSON.stringify({ text: content, metadata: event.metadata || {} }), null, 0.5);
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

    indexed++;
  }

  // Write search export after indexing
  writeSearchExport(projectId);

  return { indexed, deduplicated };
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
      for (const node of nodes) {
        if (node.embedding) {
          const nodeEmbedding = new Float32Array(node.embedding.buffer, node.embedding.byteOffset, node.embedding.byteLength / 4);
          const similarity = cosineSimilarity(queryEmbedding, nodeEmbedding);

          // Also compute keyword score
          const content = JSON.parse(node.content || "{}").text || node.name;
          const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const contentLower = content.toLowerCase();
          const keywordScore = queryWords.length > 0
            ? queryWords.filter(w => contentLower.includes(w)).length / queryWords.length
            : 0;

          // Hybrid score: 60% semantic + 40% keyword
          const score = 0.6 * similarity + 0.4 * keywordScore;

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

// --- Contextual Search (for proactive injection) ---

async function contextualSearch(query, fileContext, projectId) {
  if (!db) return { memories: [], tensions: [] };

  // Combine query + file context for richer search
  const searchText = fileContext ? `${query} ${fileContext}` : query;
  const memories = await search(searchText, projectId, 5);

  // Filter for high-value results only (decisions, lessons, error_fixes, patterns)
  const valuable = memories.filter(m =>
    ["decision", "lesson", "pattern", "error_fix"].includes(m.type) && m.score > 0.3
  );

  // Detect tensions: does the current query relate to past decisions in conflicting ways?
  let tensions = [];
  if (embedderReady && query.length > 10) {
    // Treat the query as a potential new direction and compare against past decisions
    tensions = await detectTensions(projectId, [{ type: "decision", content: query }]);
  }

  // Also include cross-project insights if relevant
  let crossProjectHits = [];
  if (embedderReady && valuable.length > 0) {
    const otherNodes = db._stmts.getHighConfidenceNodes.all(projectId);
    if (otherNodes.length > 0) {
      const queryEmbedding = await embed(searchText);
      if (queryEmbedding) {
        for (const other of otherNodes) {
          if (!other.embedding) continue;
          const otherEmbedding = new Float32Array(other.embedding.buffer, other.embedding.byteOffset, other.embedding.byteLength / 4);
          const sim = cosineSimilarity(queryEmbedding, otherEmbedding);
          if (sim > 0.5) {
            const content = JSON.parse(other.content || "{}").text || other.name;
            crossProjectHits.push({
              id: other.id,
              name: other.name,
              type: other.entity_type,
              content: content.slice(0, 200),
              confidence: other.confidence,
              score: sim,
              project: other.project_id,
            });
          }
        }
        crossProjectHits.sort((a, b) => b.score - a.score);
        crossProjectHits = crossProjectHits.slice(0, 3);
      }
    }
  }

  return { memories: valuable, tensions, crossProjectInsights: crossProjectHits };
}

// --- Search Export (for MCP server) ---

function writeSearchExport(projectId) {
  if (!db) return;
  try {
    const nodes = db._stmts.getAllProjectNodes.all(projectId);
    const exported = nodes.map(n => {
      const content = JSON.parse(n.content || "{}").text || n.name;
      // Convert embedding BLOB to float array for MCP server
      let embeddingArray = null;
      if (n.embedding) {
        const floats = new Float32Array(n.embedding.buffer, n.embedding.byteOffset, n.embedding.byteLength / 4);
        embeddingArray = Array.from(floats);
      }
      return {
        id: n.id,
        name: n.name,
        type: n.entity_type,
        content: content.slice(0, 500),
        confidence: n.confidence,
        embedding: embeddingArray,
      };
    });

    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(EXPORTS_DIR, `${projectId}.json`), JSON.stringify(exported));
  } catch (err) {
    console.error("[brain] Export write error:", err.message);
  }
}

// --- Contextual Export (for claude-worker brief injection) ---

async function writeContextualExport(projectId, query, fileContext) {
  const result = await contextualSearch(query || "", fileContext || "", projectId);

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

    // Tool preferences: library, framework, package mentions
    const toolPatterns = /(?:use|using|prefer|chose|switched to|installed)\s+([\w@/-]+)/i;
    const toolMatch = content.match(toolPatterns);
    if (toolMatch) {
      const tool = toolMatch[1];
      if (!newTools[tool]) {
        newTools[tool] = { confidence: node.confidence, source: node.project_id, content: content.slice(0, 150) };
      }
    }

    // Coding style: naming, structure, patterns
    if (lower.includes("naming") || lower.includes("convention") || lower.includes("style") ||
        lower.includes("pattern") || lower.includes("structure") || lower.includes("architecture")) {
      const key = content.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, "-").toLowerCase();
      if (key.length > 5 && !newCoding[key]) {
        newCoding[key] = { confidence: node.confidence, source: node.project_id, content: content.slice(0, 150) };
      }
    }

    // Anti-patterns: things from error_fix or low-confidence-then-dropped decisions
    if (node.entity_type === "error_fix") {
      const original = JSON.parse(node.content || "{}").metadata?.original_error;
      if (original && original.length > 10) {
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

  // Merge into profile (don't overwrite existing)
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
  return { added: true };
}

// Update philosophy
function updatePhilosophy(text) {
  fs.writeFileSync(path.join(PROFILE_DIR, "philosophy.md"), text);
  writeProfileExport();
  return { updated: true };
}

// Update rules (full text replace)
function updateRules(text) {
  fs.writeFileSync(path.join(PROFILE_DIR, "rules.md"), text);
  writeProfileExport();
  return { updated: true };
}

// Update identity (name, bio, role)
function updateIdentity(identity) {
  const current = readProfileJson("identity.json") || {};
  const updated = { ...current, ...identity };
  fs.writeFileSync(path.join(PROFILE_DIR, "identity.json"), JSON.stringify(updated, null, 2));
  writeProfileExport();
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

  // Explicit rules (highest priority)
  if (rules && rules.trim().length > 0) {
    sections.push("## Rules\n" + rules);
  }

  // Philosophy
  if (philosophy && philosophy.trim().length > 0) {
    sections.push("## Design Philosophy\n" + philosophy);
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
  return {
    identity: readProfileJson("identity.json"),
    preferences: readProfileJson("preferences.json"),
    antiPatterns: readProfileJson("anti-patterns.json"),
    style: readProfileJson("style.json"),
    rules: readProfileMd("rules.md"),
    philosophy: readProfileMd("philosophy.md"),
  };
}

// --- Message Handler ---

process.parentPort.on("message", async ({ data }) => {
  try {
    switch (data.type) {
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

        // Phase 6: Profile extraction (run occasionally — every ~5th indexing call)
        if (Math.random() < 0.2) {
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
        const result = await writeContextualExport(data.projectId, data.query, data.fileContext);
        sendToMain({ type: "contextual_result", requestId: data.requestId, ...result });
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

      case "update_identity": {
        const result = updateIdentity(data.identity);
        sendToMain({ type: "identity_result", requestId: data.requestId, ...result });
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

  // Check if backfill needed (empty DB but events exist)
  const stats = db._stmts.getStats.get();
  if (stats.node_count === 0) {
    // Backfill in background — don't block startup
    backfillAll().catch(err => console.error("[brain] Backfill error:", err));
  }

  // Start loading embedding model (async, doesn't block anything)
  loadEmbedder();
} catch (err) {
  console.error("[brain] Startup error:", err);
}

// Keep process alive
process.parentPort.start();
