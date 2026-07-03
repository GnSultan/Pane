/**
 * Playbook Engine — reflection, principles, and the validation loop.
 *
 * Replaces the old consolidate/graduate pipeline. The core idea:
 * the value of accumulated memory is not storage, it's a small set of
 * tested principles that shape behavior. This module does what a
 * developer's mind does between sessions — distill raw observations
 * into a playbook of hard-won beliefs, then hold those beliefs
 * accountable against real outcomes.
 *
 * Three loops:
 *   1. REFLECTION  — periodic LLM pass over high-signal observations
 *                    (lessons, error fixes, patterns, decisions) that
 *                    REVISES a small playbook: merge, generalize,
 *                    resolve contradictions, retire. Nondestructive —
 *                    source nodes stay in the graph for recall.
 *   2. INJECTION   — the playbook markdown is written to
 *                    ~/.pane/profile/playbooks/<project>.md and read by
 *                    context-orchestrator at session start. Principles
 *                    shape behavior without needing recall.
 *   3. VALIDATION  — arbiter verdicts feed back: a finding that matches
 *                    a principle records a violation (belief not held /
 *                    not followed); clean turns slowly reinforce.
 *                    Confidence is EARNED, not assigned. Principles that
 *                    stop paying rent get retired at the next reflection.
 *
 * Ledger lives in the `principles` table — born_from sources, credited /
 * violated counts, empirical confidence. This is the "did Pane get
 * smarter this week" dashboard data.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PANE_DIR = path.join(os.homedir(), ".pane");
const PLAYBOOKS_DIR = path.join(PANE_DIR, "profile", "playbooks");

// ── Tunables ────────────────────────────────────────────────────────────
const MAX_ACTIVE_PRINCIPLES = 30;        // Per project — fewer, stronger beats many, weak
const MAX_GLOBAL_PRINCIPLES = 15;        // Cross-project craft profile
const MAX_OBSERVATIONS_PER_REFLECTION = 200;
const MIN_NEW_OBSERVATIONS = 3;          // Don't reflect over nothing
const REFLECTION_INTERVAL_MS = 6 * 60 * 60 * 1000;   // Per project
const GLOBAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BIRTH_CONFIDENCE = 0.5;            // A new principle is a hypothesis
const VIOLATION_PENALTY = 0.08;
const CLEAN_TURN_BOOST = 0.005;
const CONFIDENCE_CAP = 0.95;
const RETIRE_BELOW = 0.2;                // Auto-retire before reflection

// Observation types that qualify as knowledge (vs session exhaust)
export const KNOWLEDGE_TYPES = ["lesson", "error_fix", "pattern", "decision"];

// ============================================================================
// Schema
// ============================================================================

export function ensurePlaybookSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS principles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      born_from TEXT DEFAULT '[]',
      credited INTEGER DEFAULT 0,
      violated INTEGER DEFAULT 0,
      cycles_survived INTEGER DEFAULT 0,
      confidence REAL DEFAULT ${BIRTH_CONFIDENCE},
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_principles_project ON principles(project_id, status);
    CREATE TABLE IF NOT EXISTS syntheses (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      kind TEXT,
      content TEXT,
      source_hash TEXT,
      generated_at INTEGER
    );
  `);
}

// ============================================================================
// Reflection — the "sleep cycle"
// ============================================================================

const REFLECTION_SYSTEM_PROMPT = `You are the reflection engine of Pane, a development environment with persistent memory. Your job is what a developer's mind does during sleep: distill raw observations from real coding sessions into a small playbook of hard-won principles.

Rules:
- A principle is an actionable belief about how to work in THIS codebase: "do X when Y", "never Z because W". 1-2 sentences, concrete enough to change behavior.
- Merge overlapping observations into one general principle. Generalize from specific incidents to the rule they imply.
- Contradictions are the most valuable signal: when a new observation conflicts with an existing principle, revise or narrow the principle ("this holds except when X") rather than keeping both.
- Retire principles that are stale, too narrow to matter, chronically violated (see ledger counts), or subsumed by a better one. Omitting an existing principle from your output retires it.
- Fewer, stronger principles beat many weak ones. Only keep what would change how a developer acts.
- Never invent principles that are not grounded in the provided observations or existing playbook.

Output ONLY valid JSON, no prose, in this exact shape:
{"playbook": [{"text": "the principle", "from": "existing principle id or null", "sources": ["observation node id", ...]}]}`;

/**
 * Gather the high-signal observation corpus for a project.
 * Small by design — hundreds of items, not thousands.
 */
function gatherObservations(db, projectId) {
  const rows = db.prepare(`
    SELECT id, entity_type, content, confidence, access_count, updated_at
    FROM nodes
    WHERE project_id = ?
      AND entity_type IN (${KNOWLEDGE_TYPES.map(() => "?").join(",")})
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(projectId, ...KNOWLEDGE_TYPES, MAX_OBSERVATIONS_PER_REFLECTION);

  return rows.map((r) => {
    let text = "";
    try {
      const parsed = JSON.parse(r.content || "{}");
      text = parsed.text || parsed.content || "";
    } catch {}
    return { id: r.id, type: r.entity_type, text, version: r.updated_at };
  }).filter((o) => o.text && o.text.length >= 15);
}

function computeSourceHash(observations) {
  const h = crypto.createHash("sha256");
  for (const o of observations) h.update(`${o.id}:${o.version}|`);
  return h.digest("hex").slice(0, 16);
}

function getSynthesis(db, projectId, kind) {
  try {
    return db.prepare(
      `SELECT * FROM syntheses WHERE project_id = ? AND kind = ?`
    ).get(projectId, kind) || null;
  } catch {
    return null;
  }
}

function putSynthesis(db, projectId, kind, content, sourceHash) {
  db.prepare(`
    INSERT INTO syntheses (id, project_id, kind, content, source_hash, generated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET content = excluded.content,
      source_hash = excluded.source_hash, generated_at = excluded.generated_at
  `).run(`${kind}-${projectId}`, projectId, kind, content, sourceHash, Math.floor(Date.now() / 1000));
}

/** Extract a JSON object from an LLM response that may be fenced or padded. */
function parseJsonResponse(raw) {
  if (!raw) return null;
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Run one reflection cycle for a project. Throttled internally —
 * safe to call fire-and-forget on every lifecycle tick.
 *
 * @param {object} db - brain database
 * @param {string} projectId
 * @param {Function} llmCall - (system, user) => Promise<string|null>
 * @returns {Promise<{skipped?: string, kept?: number, added?: number, retired?: number}>}
 */
export async function runReflection(db, projectId, llmCall) {
  if (!llmCall) return { skipped: "no-llm" };
  ensurePlaybookSchema(db);

  // Throttle: time + corpus change
  const meta = getSynthesis(db, projectId, "playbook");
  if (meta && Date.now() - meta.generated_at * 1000 < REFLECTION_INTERVAL_MS) {
    return { skipped: "throttled" };
  }

  const observations = gatherObservations(db, projectId);
  const sourceHash = computeSourceHash(observations);
  if (meta && meta.source_hash === sourceHash) return { skipped: "unchanged" };

  // Auto-retire principles whose earned confidence collapsed
  db.prepare(`
    UPDATE principles SET status = 'archived', updated_at = datetime('now')
    WHERE project_id = ? AND status = 'active' AND confidence < ?
  `).run(projectId, RETIRE_BELOW);

  const active = db.prepare(`
    SELECT id, text, confidence, credited, violated FROM principles
    WHERE project_id = ? AND status = 'active'
    ORDER BY confidence DESC
  `).all(projectId);

  // First reflection needs a real corpus; later ones can run on playbook alone
  // (to apply ledger evidence) but only when something actually changed.
  if (active.length === 0 && observations.length < MIN_NEW_OBSERVATIONS) {
    return { skipped: "too-few-observations" };
  }

  const playbookLines = active.map(
    (p) => `${p.id} | conf ${p.confidence.toFixed(2)} | credited ${p.credited} / violated ${p.violated} | ${p.text}`
  ).join("\n") || "(empty — this is the first reflection)";

  const observationLines = observations.map(
    (o) => `${o.id} | ${o.type} | ${o.text}`
  ).join("\n") || "(none)";

  const userPrompt = [
    `Project: ${projectId}`,
    ``,
    `Current playbook (id | confidence | ledger | text):`,
    playbookLines,
    ``,
    `Observations from recent sessions (id | type | text):`,
    observationLines,
    ``,
    `Produce the revised playbook. Maximum ${MAX_ACTIVE_PRINCIPLES} principles.`,
  ].join("\n");

  const raw = await llmCall(REFLECTION_SYSTEM_PROMPT, userPrompt);
  const parsed = parseJsonResponse(raw);
  if (!parsed || !Array.isArray(parsed.playbook)) {
    console.warn(`[playbook] reflection for ${projectId}: unparseable LLM output`);
    return { skipped: "bad-llm-output" };
  }

  const revised = parsed.playbook
    .filter((p) => p && typeof p.text === "string" && p.text.trim().length >= 15)
    .slice(0, MAX_ACTIVE_PRINCIPLES);

  // Apply the revision inside a transaction
  const activeIds = new Set(active.map((p) => p.id));
  const survivingIds = new Set();
  let added = 0, kept = 0;

  const apply = db.transaction(() => {
    for (const entry of revised) {
      const from = entry.from && activeIds.has(entry.from) ? entry.from : null;
      const sources = Array.isArray(entry.sources) ? entry.sources.slice(0, 20) : [];
      if (from) {
        db.prepare(`
          UPDATE principles SET text = ?, cycles_survived = cycles_survived + 1,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(entry.text.trim(), from);
        survivingIds.add(from);
        kept++;
      } else {
        const id = `pr-${projectId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
        db.prepare(`
          INSERT INTO principles (id, project_id, text, born_from, confidence)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, projectId, entry.text.trim(), JSON.stringify(sources), BIRTH_CONFIDENCE);
        survivingIds.add(id);
        added++;
      }
    }
    // Anything active that the reflection omitted is retired
    for (const p of active) {
      if (!survivingIds.has(p.id)) {
        db.prepare(`
          UPDATE principles SET status = 'archived', updated_at = datetime('now')
          WHERE id = ?
        `).run(p.id);
      }
    }
  });
  apply();

  const retired = active.length - kept;
  const markdown = writePlaybookMarkdown(db, projectId);
  putSynthesis(db, projectId, "playbook", markdown, sourceHash);

  console.log(`[playbook] reflection for ${projectId}: kept=${kept} added=${added} retired=${retired}`);
  return { kept, added, retired };
}

/**
 * Render the active playbook to markdown and write it where the
 * context-orchestrator (main process) reads it. File-based handoff —
 * no worker roundtrip on the hot path.
 */
export function writePlaybookMarkdown(db, projectId) {
  const active = db.prepare(`
    SELECT text, confidence FROM principles
    WHERE project_id = ? AND status = 'active'
    ORDER BY confidence DESC, updated_at DESC
  `).all(projectId);

  const lines = active.map((p) => `- ${p.text}`);
  const markdown = lines.join("\n");

  try {
    fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
    const filePath = path.join(PLAYBOOKS_DIR, `${projectId}.md`);
    if (markdown) {
      fs.writeFileSync(filePath, markdown + "\n", "utf-8");
    } else if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath); // empty playbook — don't inject an empty section
    }
  } catch (err) {
    console.warn(`[playbook] failed to write markdown for ${projectId}: ${err.message}`);
  }
  return markdown;
}

/**
 * Cross-project reflection: distill the global craft profile from all
 * per-project playbooks. Only what holds regardless of project belongs here.
 */
export async function runGlobalReflection(db, llmCall) {
  if (!llmCall) return { skipped: "no-llm" };
  ensurePlaybookSchema(db);

  const meta = getSynthesis(db, "__global__", "playbook-global");
  if (meta && Date.now() - meta.generated_at * 1000 < GLOBAL_INTERVAL_MS) {
    return { skipped: "throttled" };
  }

  let files = [];
  try {
    files = fs.readdirSync(PLAYBOOKS_DIR)
      .filter((f) => f.endsWith(".md") && f !== "global.md");
  } catch {}
  if (files.length < 2) return { skipped: "too-few-playbooks" };

  const sections = files.map((f) => {
    const body = fs.readFileSync(path.join(PLAYBOOKS_DIR, f), "utf-8").trim();
    return `## ${f.replace(/\.md$/, "")}\n${body}`;
  });
  const combined = sections.join("\n\n");
  const sourceHash = crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
  if (meta && meta.source_hash === sourceHash) return { skipped: "unchanged" };

  const raw = await llmCall(
    `You distill a developer's cross-project craft profile. Given per-project playbooks, extract ONLY the principles that hold regardless of project — how this developer works, what they value, what always breaks. Skip anything project-specific (file names, frameworks, particular subsystems). Maximum ${MAX_GLOBAL_PRINCIPLES} principles, each 1-2 actionable sentences. Output ONLY valid JSON: {"playbook": [{"text": "..."}]}`,
    combined
  );
  const parsed = parseJsonResponse(raw);
  if (!parsed || !Array.isArray(parsed.playbook)) return { skipped: "bad-llm-output" };

  const lines = parsed.playbook
    .filter((p) => p && typeof p.text === "string" && p.text.trim().length >= 15)
    .slice(0, MAX_GLOBAL_PRINCIPLES)
    .map((p) => `- ${p.text.trim()}`);

  if (lines.length === 0) return { skipped: "empty" };

  const markdown = lines.join("\n") + "\n";
  fs.mkdirSync(PLAYBOOKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PLAYBOOKS_DIR, "global.md"), markdown, "utf-8");
  putSynthesis(db, "__global__", "playbook-global", markdown, sourceHash);

  console.log(`[playbook] global craft profile updated: ${lines.length} principles`);
  return { principles: lines.length };
}

// ============================================================================
// Validation loop — verdicts hold principles accountable
// ============================================================================

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "when", "then", "than", "that",
  "this", "these", "those", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should", "could",
  "not", "no", "never", "always", "with", "without", "for", "from", "into",
  "over", "under", "before", "after", "use", "using", "used", "it", "its",
  "on", "in", "at", "by", "to", "of", "as", "via", "any", "all", "only",
]);

function significantWords(text) {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) || [])
      .filter((w) => !STOPWORDS.has(w))
  );
}

/**
 * Feed an arbiter verdict back into the principle ledger.
 *
 * A finding whose text overlaps a principle records a violation — the
 * belief exists but didn't shape behavior (or is wrong). A clean turn
 * slowly reinforces every active principle. Confidence is earned.
 *
 * @param {object} db - brain database
 * @param {string} projectId
 * @param {{pass: boolean, findings?: Array<{plain?: string, raw?: string, code?: string}>}} verdict
 * @returns {{violations: number, reinforced: number}}
 */
export function recordPlaybookFeedback(db, projectId, verdict) {
  ensurePlaybookSchema(db);
  const active = db.prepare(`
    SELECT id, text FROM principles WHERE project_id = ? AND status = 'active'
  `).all(projectId);
  if (active.length === 0) return { violations: 0, reinforced: 0 };

  let violations = 0;
  let reinforced = 0;

  if (verdict?.pass) {
    // Clean turn — small credit to every injected principle. "credited"
    // counts sessions survived without a matching violation.
    db.prepare(`
      UPDATE principles
      SET credited = credited + 1,
          confidence = MIN(${CONFIDENCE_CAP}, confidence + ${CLEAN_TURN_BOOST}),
          updated_at = datetime('now')
      WHERE project_id = ? AND status = 'active'
    `).run(projectId);
    reinforced = active.length;
    return { violations, reinforced };
  }

  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  if (findings.length === 0) return { violations, reinforced };

  const principleWords = active.map((p) => ({ ...p, words: significantWords(p.text) }));

  for (const finding of findings) {
    const text = `${finding.plain || finding.raw || ""} ${finding.code || ""}`;
    const words = significantWords(text);
    if (words.size < 3) continue;

    let best = null;
    let bestOverlap = 0;
    for (const p of principleWords) {
      let overlap = 0;
      for (const w of words) if (p.words.has(w)) overlap++;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = p; }
    }

    // Conservative: require real lexical overlap before blaming a principle
    if (best && bestOverlap >= 3) {
      db.prepare(`
        UPDATE principles
        SET violated = violated + 1,
            confidence = MAX(0.05, confidence - ${VIOLATION_PENALTY}),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(best.id);
      violations++;
    }
  }

  return { violations, reinforced };
}

// ============================================================================
// One-time migration — archive the dead weight
// ============================================================================

// Session exhaust that accumulated in the graph but belongs to handoff/journal
// state (which has its own storage in ~/.pane/session and events.jsonl).
const EXHAUST_TYPES = ["accomplishment", "command", "intent", "discovery", "blocker", "file_edit"];

/**
 * Clean the graph of nodes that never earned their place:
 *   - "principle" nodes from the old runaway consolidation (126K+, ~0 accessed)
 *   - journaling exhaust types that were never meant to be knowledge
 * Only zero-access nodes are touched — anything ever recalled survives.
 * Guarded by a syntheses marker; runs once.
 */
export function runPlaybookMigration(db) {
  ensurePlaybookSchema(db);
  if (getSynthesis(db, "__global__", "playbook-migration")) {
    return { skipped: "already-ran" };
  }

  const started = Date.now();
  const targets = db.prepare(`
    SELECT id FROM nodes
    WHERE access_count = 0
      AND entity_type IN ('principle', ${EXHAUST_TYPES.map(() => "?").join(",")})
  `).all(...EXHAUST_TYPES);

  const ids = targets.map((r) => r.id);
  let deleted = 0;

  const purge = db.transaction((batch) => {
    for (const id of batch) {
      db.prepare("DELETE FROM node_versions WHERE node_id = ?").run(id);
      db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(id, id);
      db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
      deleted++;
    }
  });

  // Batch to keep transactions bounded
  for (let i = 0; i < ids.length; i += 5000) {
    purge(ids.slice(i, i + 5000));
  }

  putSynthesis(db, "__global__", "playbook-migration", `deleted=${deleted}`, "");

  // Retire digest.txt — the old graduation target. It accumulated raw
  // session dumps (the graduation filter was confidence≥0.9 on nodes born
  // at 0.95 ceiling) and nothing injected it. Playbooks replace it.
  try {
    const digestPath = path.join(PANE_DIR, "profile", "digest.txt");
    if (fs.existsSync(digestPath)) {
      fs.renameSync(digestPath, digestPath + ".pre-playbook.bak");
    }
  } catch {}

  // Reclaim space. One-time synchronous cost in the utility process —
  // queued messages wait, nothing breaks.
  let vacuumMs = 0;
  try {
    const vStart = Date.now();
    db.exec("VACUUM");
    vacuumMs = Date.now() - vStart;
  } catch (err) {
    console.warn(`[playbook] VACUUM failed (non-fatal): ${err.message}`);
  }

  console.log(
    `[playbook] migration: deleted ${deleted} dead nodes in ${Date.now() - started - vacuumMs}ms, ` +
    `VACUUM ${vacuumMs}ms`
  );
  return { deleted, vacuumMs };
}

// ============================================================================
// Ledger read — the "did Pane get smarter" dashboard
// ============================================================================

/**
 * Ledger snapshot for a project: active principles with their earned stats.
 */
export function getPlaybookLedger(db, projectId) {
  ensurePlaybookSchema(db);
  return db.prepare(`
    SELECT id, text, confidence, credited, violated, cycles_survived,
           born_from, created_at, updated_at
    FROM principles
    WHERE project_id = ? AND status = 'active'
    ORDER BY confidence DESC
  `).all(projectId);
}
