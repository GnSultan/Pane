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
      data.heuristicConfidence ?? null,
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
        "SELECT model, provider, domain, task_type FROM routing_outcomes WHERE id = ?"
      ).get(id);
      if (row) this._updateProfile(row, score);
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

  getProfile(model, provider, domain, taskType) {
    return this.db.prepare(`
      SELECT * FROM model_profiles
      WHERE model = ? AND provider = ? AND domain = ? AND task_type = ?
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

    // Propagate delta to the running model profile
    const profile = this.getProfile(row.model, row.provider, row.domain, row.task_type);
    if (profile) {
      const newTotal = profile.total_score + (newScore - oldScore);
      const newAvg   = newTotal / profile.sample_count;
      this.db.prepare(`
        UPDATE model_profiles
        SET total_score = ?, avg_score = ?, last_updated = ?
        WHERE model = ? AND provider = ? AND domain = ? AND task_type = ?
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
    // Deliberately simple — more signal types get added over time as the system
    // learns what correlates with good routing decisions.
    let score = 0.70; // optimistic prior

    if (signals.hadToolErrors)            score -= 0.25;
    if (signals.responseTimeMs > 60_000)  score -= 0.10;
    if (signals.responseTimeMs > 120_000) score -= 0.10; // stacks

    // Very short response for a complex task = underpowered model
    const isComplex = signals.taskType === "orchestrate" ||
                      signals.domain    === "architecture";
    if (isComplex && (signals.responseLength ?? 999) < 100) score -= 0.15;

    return Math.max(0, Math.min(1, score));
  }

  _updateProfile(row, score) {
    const existing = this.getProfile(row.model, row.provider, row.domain, row.task_type);
    if (existing) {
      const n     = existing.sample_count + 1;
      const total = existing.total_score  + score;
      this.db.prepare(`
        UPDATE model_profiles
        SET sample_count = ?, total_score = ?, avg_score = ?, last_updated = ?
        WHERE model = ? AND provider = ? AND domain = ? AND task_type = ?
      `).run(n, total, total / n, Date.now(),
        row.model, row.provider, row.domain, row.task_type);
    } else {
      this.db.prepare(`
        INSERT INTO model_profiles
          (model, provider, domain, task_type, sample_count, total_score, avg_score, last_updated)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(row.model, row.provider, row.domain, row.task_type, score, score, Date.now());
    }
  }
}

export const routingStore = new RoutingStore();
