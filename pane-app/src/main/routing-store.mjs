// ============================================================================
// Routing Store
// ============================================================================
//
// SQLite-backed store for routing outcomes and model capability profiles.
// Lives at ~/.pane/routing-store.db.
//
// Three tables:
//   routing_outcomes  — one row per request, signals filled in on completion
//   model_profiles    — rolling avg score per (model, provider, domain, task_type)
//   benchmark_priors  — external benchmark data seeded at startup
//

import { createRequire } from "module";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const require2 = createRequire(import.meta.url);
const Database  = require2("better-sqlite3");

const PANE_DIR = join(homedir(), ".pane");
const DB_PATH  = join(PANE_DIR, "routing-store.db");

class RoutingStore {
  constructor() {
    this._db = null;
  }

  get db() {
    if (!this._db) this._open();
    return this._db;
  }

  _open() {
    mkdirSync(PANE_DIR, { recursive: true });
    this._db = new Database(DB_PATH);
    this._db.pragma("journal_mode = WAL");
    this._migrate();
    console.log("[routing-store] opened:", DB_PATH);
  }

  _migrate() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS routing_outcomes (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id           TEXT,
        project_id           TEXT,
        task_type            TEXT,   -- direct | orchestrate | discuss
        domain               TEXT,   -- architecture | debugging | implementation | ...
        model                TEXT,
        provider             TEXT,
        heuristic_confidence REAL,
        oracle_used          INTEGER DEFAULT 0,
        oracle_confidence    REAL,
        prompt_length        INTEGER,
        timestamp            INTEGER,
        -- outcome signals, filled in on processEnded
        response_length      INTEGER,
        had_tool_errors      INTEGER DEFAULT 0,
        response_time_ms     INTEGER,
        score                REAL,
        explored             INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS model_profiles (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        model        TEXT NOT NULL,
        provider     TEXT NOT NULL,
        domain       TEXT NOT NULL,
        task_type    TEXT NOT NULL,
        sample_count INTEGER DEFAULT 0,
        total_score  REAL    DEFAULT 0,
        avg_score    REAL    DEFAULT 0.5,
        last_updated INTEGER,
        UNIQUE(model, provider, domain, task_type)
      );

      CREATE TABLE IF NOT EXISTS benchmark_priors (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        model             TEXT NOT NULL,
        provider          TEXT NOT NULL,
        source            TEXT,
        coding_score      REAL,
        reasoning_score   REAL,
        general_score     REAL,
        cost_input_mtok   REAL,
        cost_output_mtok  REAL,
        arena_rank        INTEGER,
        fetched_at        INTEGER,
        UNIQUE(model, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_model
        ON routing_outcomes(model, provider, domain, task_type);
      CREATE INDEX IF NOT EXISTS idx_outcomes_ts
        ON routing_outcomes(timestamp);
    `);

    // Version-gated migrations
    const currentVersion = this._db.pragma("user_version", { simple: true });

    if (currentVersion < 1) {
      // v1: add project_id column to model_profiles for per-project routing
      try {
        this._db.exec(`ALTER TABLE model_profiles ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
      } catch (err) {
        // Column may already exist if DB was manually altered — non-fatal
        if (!err.message.includes("duplicate column")) throw err;
      }
      // Drop old unique index and recreate with project_id included
      this._db.exec(`
        DROP INDEX IF EXISTS model_profiles_model_provider_domain_task_type;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_model_profiles_unique
          ON model_profiles(model, provider, domain, task_type, project_id);
      `);
      this._db.pragma("user_version = 1");
    }
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  recordOutcome(data) {
    return this.db.prepare(`
      INSERT INTO routing_outcomes
        (request_id, project_id, task_type, domain, model, provider,
         heuristic_confidence, oracle_used, oracle_confidence,
         prompt_length, timestamp, explored)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.requestId           ?? null,
      data.projectId           ?? null,
      data.taskType            ?? null,
      data.domain              ?? null,
      data.model               ?? null,
      data.provider            ?? null,
      data.routingConfidence ?? data.heuristicConfidence ?? null,
      data.oracleUsed          ? 1 : 0,
      data.oracleConfidence    ?? null,
      data.promptLength        ?? null,
      Date.now(),
      data.explored            ? 1 : 0,
    ).lastInsertRowid;
  }

  updateOutcome(id, signals) {
    if (!id) return;
    const score = this._computeScore(signals);
    this.db.prepare(`
      UPDATE routing_outcomes
      SET response_length = ?, had_tool_errors = ?, response_time_ms = ?, score = ?
      WHERE id = ?
    `).run(
      signals.responseLength ?? null,
      signals.hadToolErrors  ? 1 : 0,
      signals.responseTimeMs ?? null,
      score,
      id,
    );
    if (score !== null) {
      const row = this.db.prepare(
        "SELECT model, provider, domain, task_type, project_id FROM routing_outcomes WHERE id = ?"
      ).get(id);
      if (row) this._updateProfile(row, score, row.project_id ?? '');
    }
  }

  upsertPrior(data) {
    this.db.prepare(`
      INSERT INTO benchmark_priors
        (model, provider, source, coding_score, reasoning_score, general_score,
         cost_input_mtok, cost_output_mtok, arena_rank, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model, provider) DO UPDATE SET
        source            = excluded.source,
        coding_score      = excluded.coding_score,
        reasoning_score   = excluded.reasoning_score,
        general_score     = excluded.general_score,
        cost_input_mtok   = excluded.cost_input_mtok,
        cost_output_mtok  = excluded.cost_output_mtok,
        arena_rank        = excluded.arena_rank,
        fetched_at        = excluded.fetched_at
    `).run(
      data.model,               data.provider,
      data.source               ?? "embedded",
      data.codingScore          ?? null,
      data.reasoningScore       ?? null,
      data.generalScore         ?? null,
      data.costInputMtok        ?? null,
      data.costOutputMtok       ?? null,
      data.arenaRank            ?? null,
      Date.now(),
    );
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  getProfile(model, provider, domain, taskType, projectId = '') {
    if (projectId) {
      // Try per-project profile first (require at least 5 samples for reliability)
      const projectProfile = this.db.prepare(`
        SELECT * FROM model_profiles
        WHERE model = ? AND provider = ? AND domain = ? AND task_type = ? AND project_id = ?
          AND sample_count >= 5
      `).get(model, provider, domain, taskType, projectId);
      if (projectProfile) return projectProfile;
    }
    // Fall back to global profile (project_id = '')
    return this.db.prepare(`
      SELECT * FROM model_profiles
      WHERE model = ? AND provider = ? AND domain = ? AND task_type = ? AND project_id = ''
    `).get(model, provider, domain, taskType);
  }

  getPrior(model, provider) {
    return this.db.prepare(
      "SELECT * FROM benchmark_priors WHERE model = ? AND provider = ?"
    ).get(model, provider);
  }

  priorCount() {
    return this.db.prepare("SELECT COUNT(*) as n FROM benchmark_priors").get().n;
  }

  /**
   * All benchmark priors — used by the unified classifier to build the model catalog.
   * Returns one row per (model, provider) with scores, costs, and arena rank.
   */
  getAllPriors() {
    return this.db.prepare("SELECT * FROM benchmark_priors ORDER BY arena_rank ASC NULLS LAST").all();
  }

  /**
   * All model profiles — real outcome data aggregated per (model, provider, domain, task_type).
   * Used by the unified classifier to show the model its own track record.
   */
  getAllProfiles() {
    return this.db.prepare("SELECT * FROM model_profiles WHERE sample_count >= 1 ORDER BY avg_score DESC").all();
  }

  /**
   * Recent scored outcomes for a project — used for struggle detection.
   * Returns up to n rows ordered most-recent first.
   */
  getRecentProjectOutcomes(projectId, n = 6) {
    if (!projectId) return [];
    return this.db.prepare(`
      SELECT * FROM routing_outcomes
      WHERE project_id = ? AND score IS NOT NULL
      ORDER BY timestamp DESC LIMIT ?
    `).all(projectId, n);
  }

  /**
   * Best model available for the given provider set.
   * Ranks by composite benchmark score — used for struggle escalation.
   * @param {Set<string>} providers — available provider names
   * @returns {{ model: string, provider: string } | null}
   */
  getFrontierModel(providers) {
    const rows = this.db.prepare(`
      SELECT model, provider,
        (COALESCE(coding_score, 0) + COALESCE(reasoning_score, 0) + COALESCE(general_score, 0)) /
        MAX(1,
          (CASE WHEN coding_score IS NOT NULL THEN 1 ELSE 0 END +
           CASE WHEN reasoning_score IS NOT NULL THEN 1 ELSE 0 END +
           CASE WHEN general_score IS NOT NULL THEN 1 ELSE 0 END)
        ) AS composite
      FROM benchmark_priors
      ORDER BY composite DESC
    `).all();
    for (const row of rows) {
      if (providers.has(row.provider)) return { model: row.model, provider: row.provider };
    }
    return null;
  }

  // Retrospective adjustment — applied when the next message reveals whether
  // the previous response was actually good (todo completions, corrections, etc.)
  adjustOutcomeScore(outcomeId, delta) {
    if (!outcomeId || delta === 0) return;
    const row = this.db.prepare(
      "SELECT * FROM routing_outcomes WHERE id = ?"
    ).get(outcomeId);
    if (!row || row.score === null) return;

    const oldScore = row.score;
    const newScore = Math.max(0, Math.min(1, oldScore + delta));
    this.db.prepare(
      "UPDATE routing_outcomes SET score = ? WHERE id = ?"
    ).run(newScore, outcomeId);

    // Propagate delta to the running model profile (global profile only)
    const profile = this.getProfile(row.model, row.provider, row.domain, row.task_type, '');
    if (profile) {
      const newTotal = profile.total_score + (newScore - oldScore);
      const newAvg   = newTotal / profile.sample_count;
      this.db.prepare(`
        UPDATE model_profiles
        SET total_score = ?, avg_score = ?, last_updated = ?
        WHERE model = ? AND provider = ? AND domain = ? AND task_type = ? AND project_id = ''
      `).run(newTotal, newAvg, Date.now(),
        row.model, row.provider, row.domain, row.task_type);
    }
  }

  updatePriorCost(model, provider, costInputMtok, costOutputMtok) {
    this.db.prepare(`
      UPDATE benchmark_priors
      SET cost_input_mtok = ?, cost_output_mtok = ?, fetched_at = ?
      WHERE model = ? AND provider = ?
    `).run(costInputMtok, costOutputMtok, Date.now(), model, provider);
  }

  stats() {
    return {
      totalOutcomes:   this.db.prepare("SELECT COUNT(*) as n FROM routing_outcomes").get().n,
      scoredOutcomes:  this.db.prepare("SELECT COUNT(*) as n FROM routing_outcomes WHERE score IS NOT NULL").get().n,
      modelProfiles:   this.db.prepare("SELECT COUNT(*) as n FROM model_profiles").get().n,
      benchmarkPriors: this.db.prepare("SELECT COUNT(*) as n FROM benchmark_priors").get().n,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _computeScore(signals) {
    // Composite 0–1 from outcome signals.
    // Negative signals penalize failures. Positive signals reward clean, substantive
    // responses — so the system can learn genuine model affinity, not just avoidance.
    let score = 0.70; // optimistic prior

    if (signals.hadToolErrors)            score -= 0.25;
    if (signals.responseTimeMs > 60_000)  score -= 0.10;
    if (signals.responseTimeMs > 120_000) score -= 0.10; // stacks

    // Very short response for a complex task = underpowered model
    const isComplex = signals.taskType === "orchestrate" ||
                      signals.domain    === "architecture";
    if (isComplex && (signals.responseLength ?? 999) < 100) score -= 0.15;

    // Positive: fast, clean response with no tool errors
    if (!signals.hadToolErrors && (signals.responseTimeMs ?? 0) < 30_000) score += 0.05;

    // Positive: substantive response length relative to task type
    const len = signals.responseLength ?? 0;
    if (len > 0 && (isComplex ? len >= 500 : len >= 200)) score += 0.05;

    return Math.max(0, Math.min(1, score));
  }

  _updateProfile(row, score, projectId = '') {
    this._writeProfile(row.model, row.provider, row.domain, row.task_type, score, '');
    if (projectId) {
      this._writeProfile(row.model, row.provider, row.domain, row.task_type, score, projectId);
    }
  }

  _writeProfile(model, provider, domain, taskType, score, projectId) {
    const existing = this.getProfile(model, provider, domain, taskType, projectId);
    if (existing) {
      const n     = existing.sample_count + 1;
      const total = existing.total_score  + score;
      this.db.prepare(`
        UPDATE model_profiles
        SET sample_count = ?, total_score = ?, avg_score = ?, last_updated = ?
        WHERE model = ? AND provider = ? AND domain = ? AND task_type = ? AND project_id = ?
      `).run(n, total, total / n, Date.now(), model, provider, domain, taskType, projectId);
    } else {
      this.db.prepare(`
        INSERT OR IGNORE INTO model_profiles
          (model, provider, domain, task_type, project_id, sample_count, total_score, avg_score, last_updated)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(model, provider, domain, taskType, projectId, score, score, Date.now());
    }
  }
}

export const routingStore = new RoutingStore();
