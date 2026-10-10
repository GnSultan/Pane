/**
 * janitor.mjs — Pane keeps itself alive. This is the maintenance half.
 *
 * A year of sessions left real debt on disk: 527 orphaned atomic-write tmp
 * files (the rename pattern orphans its tmp file on any failure), a 29MB
 * unbounded voice-debug.log, 10GB of checkpoints with no retention policy
 * (one project alone held 2,252 full-file copies), and a pane.db carrying
 * ~96MB of free pages that never get released.
 *
 * runStartupJanitor() addresses all four. It runs once per launch, AFTER
 * the window is shown, fire-and-forget: every step is independently
 * try/caught, logs what it reclaimed, and never blocks startup or a turn.
 *
 * Checkpoint retention policy (all three bound together):
 *   - age: checkpoints older than CHECKPOINT_MAX_AGE_DAYS are removed
 *   - per-project size: oldest-first trim to CHECKPOINT_PROJECT_MAX_BYTES
 *   - global size: oldest-first trim across projects to GLOBAL_MAX_BYTES
 *   - recency floor: nothing younger than RECENT_FLOOR_DAYS is ever
 *     removed by size trimming — recent restore points stay guaranteed.
 * Disk and SQLite are kept in sync: every JSON deletion deletes its
 * checkpoints row, and orphaned JSONs (crash between file write and row
 * insert) are swept when older than the recency floor.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getPaneDb } from "./pane-db.mjs";
import { checkpointDir } from "./checkpoint-engine.mjs";

// ── Policy constants ────────────────────────────────────────────────────────

/** Atomic-write tmp files older than this are orphans, not in-flight writes. */
const TMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/** voice-debug.log rotates when it exceeds this; one .1 generation kept. */
const VOICE_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/** Checkpoints older than this age out regardless of size. */
const CHECKPOINT_MAX_AGE_DAYS = 30;

/** Size trim never touches checkpoints younger than this. */
const RECENT_FLOOR_DAYS = 7;

/** Oldest-first per-project trim target. */
const CHECKPOINT_PROJECT_MAX_BYTES = 1024 * 1024 * 1024; // 1GB

/** Oldest-first global trim target across all projects. */
const CHECKPOINT_GLOBAL_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

/** VACUUM only when free pages exceed this fraction of the database. */
const VACUUM_FREELIST_RATIO = 0.25;

const DAY_MS = 24 * 60 * 60 * 1000;

function paneDir() {
  return path.join(os.homedir(), ".pane");
}

function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

// ── 1. Orphaned atomic-write tmp files ──────────────────────────────────────
// The settings/plan write handlers use writeFile(tmp) → rename(tmp → final).
// A failure between the two (crash, ENOSPC) leaves settings.json.tmp.<bigint>
// behind forever. In-flight writes are <24h old — anything older is a leak.

async function sweepOrphanedTmpFiles() {
  const dir = paneDir();
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const cutoff = Date.now() - TMP_FILE_MAX_AGE_MS;
  let removed = 0;
  let bytes = 0;
  for (const name of entries) {
    // Matches settings.json.tmp.<hrtime> orphans (and a bare .tmp suffix
    // from an older format), never the live settings.json itself.
    if (!name.startsWith("settings.json.tmp")) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.mtimeMs > cutoff) continue; // possibly in-flight — leave it
      await fsp.unlink(full);
      removed += 1;
      bytes += stat.size;
    } catch {
      /* gone already or unreadable — next */
    }
  }
  return { removed, bytes };
}

// ── 2. voice-debug.log rotation ─────────────────────────────────────────────
// Written via appendFileSync/appendFile by main.mjs and voice-relay.mjs —
// both reopen by path on every write, so renaming under them is safe: the
// next write recreates a fresh log. One .1 generation is kept for triage.

async function rotateVoiceDebugLog() {
  const logPath = path.join(paneDir(), "voice-debug.log");
  let stat;
  try {
    stat = await fsp.stat(logPath);
  } catch {
    return { rotated: false, bytes: 0 };
  }
  if (stat.size < VOICE_LOG_MAX_BYTES) return { rotated: false, bytes: 0 };
  try {
    await fsp.rename(logPath, `${logPath}.1`);
    return { rotated: true, bytes: stat.size };
  } catch {
    return { rotated: false, bytes: 0 };
  }
}

// ── 3. Checkpoint retention ─────────────────────────────────────────────────

/**
 * Delete one checkpoint everywhere it lives: JSON file + SQLite row.
 * Best-effort on both halves — a missing file doesn't block row deletion
 * and vice versa.
 */
async function deleteCheckpointEverywhere(cp, db) {
  const file = path.join(checkpointDir(cp.project_id), `${cp.id}.json`);
  let bytes = 0;
  try {
    const stat = await fsp.stat(file);
    bytes = stat.size;
    await fsp.unlink(file);
  } catch {
    /* file already gone — still drop the row */
  }
  try {
    db.stmts.deleteCheckpointById.run(cp.id);
  } catch {
    /* row already gone */
  }
  return bytes;
}

/**
 * Retention pass over all projects' checkpoints.
 * Order matters: age-out first (unconditional), then per-project size trim,
 * then global size trim — each respecting the recency floor.
 * @param {object} db open pane database (getPaneDb() in production; injected
 *   in tests — better-sqlite3 is codesign-stripped for DMG builds and can't
 *   load in the test process)
 * @returns {Promise<{removed: number, bytes: number}>}
 */
async function pruneCheckpoints(db) {
  const all = db
    .prepare("SELECT id, project_id, created_at FROM checkpoints ORDER BY created_at ASC")
    .all();
  if (all.length === 0) return { removed: 0, bytes: 0 };

  const now = Date.now();
  const maxAgeMs = CHECKPOINT_MAX_AGE_DAYS * DAY_MS;
  const floorMs = RECENT_FLOOR_DAYS * DAY_MS;

  // Group by project, oldest-first (already ordered).
  const byProject = new Map();
  for (const cp of all) {
    if (!byProject.has(cp.project_id)) byProject.set(cp.project_id, []);
    byProject.get(cp.project_id).push(cp);
  }

  const doomed = new Set();

  // Pass 1 — age out.
  for (const cp of all) {
    if (now - cp.created_at > maxAgeMs) doomed.add(cp.id);
  }

  // Pass 2 — per-project size trim, oldest-first, recency floor respected.
  for (const [, cps] of byProject) {
    let size = 0;
    const sizes = new Map();
    for (const cp of cps) {
      try {
        sizes.set(cp.id, (await fsp.stat(path.join(checkpointDir(cp.project_id), `${cp.id}.json`))).size);
      } catch {
        sizes.set(cp.id, 0); // orphaned row, no file
      }
      size += sizes.get(cp.id);
    }
    if (size <= CHECKPOINT_PROJECT_MAX_BYTES) continue;
    for (const cp of cps) {
      if (size <= CHECKPOINT_PROJECT_MAX_BYTES) break;
      if (doomed.has(cp.id)) continue;
      if (now - cp.created_at < floorMs) continue; // recent — protected
      doomed.add(cp.id);
      size -= sizes.get(cp.id) || 0;
    }
  }

  // Pass 3 — global trim across remaining checkpoints, oldest-first.
  {
    let size = 0;
    for (const [, cps] of byProject) {
      for (const cp of cps) {
        if (doomed.has(cp.id)) continue;
        try {
          size += (await fsp.stat(path.join(checkpointDir(cp.project_id), `${cp.id}.json`))).size;
        } catch {
          /* no file, no bytes */
        }
      }
    }
    if (size > CHECKPOINT_GLOBAL_MAX_BYTES) {
      for (const cp of all) {
        if (size <= CHECKPOINT_GLOBAL_MAX_BYTES) break;
        if (doomed.has(cp.id)) continue;
        if (now - cp.created_at < floorMs) continue;
        doomed.add(cp.id);
        try {
          size -= (await fsp.stat(path.join(checkpointDir(cp.project_id), `${cp.id}.json`))).size;
        } catch {
          /* already counted as 0 */
        }
      }
    }
  }

  let removed = 0;
  let bytes = 0;
  for (const cp of all) {
    if (!doomed.has(cp.id)) continue;
    bytes += await deleteCheckpointEverywhere(cp, db);
    removed += 1;
  }

  // Orphan sweep: JSON files on disk with no SQLite row (crash between the
  // file write and the row insert in flushJournal). Older than the recency
  // floor only — anything younger might be mid-write right now.
  try {
    const knownIds = new Set(all.map((c) => c.id));
    const projects = await fsp.readdir(paneDir() + "/checkpoints", { withFileTypes: true });
    for (const entry of projects) {
      if (!entry.isDirectory()) continue;
      const pdir = path.join(paneDir(), "checkpoints", entry.name);
      let files;
      try {
        files = await fsp.readdir(pdir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith("cp-") || !f.endsWith(".json")) continue;
        const id = f.slice(0, -".json".length);
        if (knownIds.has(id)) continue;
        const full = path.join(pdir, f);
        try {
          const stat = await fsp.stat(full);
          if (now - stat.mtimeMs < floorMs) continue;
          await fsp.unlink(full);
          removed += 1;
          bytes += stat.size;
        } catch {
          /* next */
        }
      }
    }
  } catch {
    /* checkpoints dir missing — nothing to sweep */
  }

  return { removed, bytes };
}

// ── 4. Database vacuum ──────────────────────────────────────────────────────
// WAL mode never returns free pages to the OS. After heavy churn (change
// history pruning, message pruning) the file carries dead weight. Vacuum
// once per launch when fragmentation is heavy — it's a one-to-few-second
// synchronous pass, so it only runs when the reclaim justifies it.

function vacuumIfFragmented(db) {
  const freelist = db.pragma("freelist_count", { simple: true });
  const pageCount = db.pragma("page_count", { simple: true });
  if (!pageCount || freelist / pageCount < VACUUM_FREELIST_RATIO) {
    return { vacuumed: false, reclaimed: 0 };
  }
  const pageSize = db.pragma("page_size", { simple: true });
  const before = pageCount * pageSize;
  db.exec("VACUUM");
  const after = db.pragma("page_count", { simple: true }) * pageSize;
  return { vacuumed: true, reclaimed: Math.max(0, before - after) };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run every janitor pass once. Fire-and-forget safe: each step is
 * independently guarded, and the whole thing is designed to be called with
 * `setImmediate(runStartupJanitor)` after the window is shown.
 */
export async function runStartupJanitor() {
  const started = Date.now();

  // DB-dependent passes need the database; skip cleanly when init failed.
  let dbReady = true;
  try {
    getPaneDb();
  } catch {
    dbReady = false;
  }

  const results = {};
  try {
    results.tmp = await sweepOrphanedTmpFiles();
  } catch (err) {
    console.warn("[janitor] tmp sweep failed:", err.message);
  }
  try {
    results.log = await rotateVoiceDebugLog();
  } catch (err) {
    console.warn("[janitor] log rotation failed:", err.message);
  }
  if (dbReady) {
    const db = getPaneDb();
    try {
      results.checkpoints = await pruneCheckpoints(db);
    } catch (err) {
      console.warn("[janitor] checkpoint prune failed:", err.message);
    }
    try {
      results.vacuum = vacuumIfFragmented(db);
    } catch (err) {
      console.warn("[janitor] vacuum failed:", err.message);
    }
  }

  const lines = [];
  if (results.tmp?.removed) lines.push(`tmp files: ${results.tmp.removed} removed (${formatBytes(results.tmp.bytes)})`);
  if (results.log?.rotated) lines.push(`voice-debug.log rotated (${formatBytes(results.log.bytes)})`);
  if (results.checkpoints?.removed)
    lines.push(`checkpoints: ${results.checkpoints.removed} pruned (${formatBytes(results.checkpoints.bytes)})`);
  if (results.vacuum?.vacuumed) lines.push(`db vacuumed (${formatBytes(results.vacuum.reclaimed)} reclaimed)`);
  if (lines.length > 0) {
    console.log(`[janitor] ${lines.join(" · ")} — ${Date.now() - started}ms`);
  } else {
    console.log("[janitor] clean — nothing to reclaim");
  }
}

/** Exposed for tests. */
export const _internals = {
  sweepOrphanedTmpFiles,
  rotateVoiceDebugLog,
  pruneCheckpoints,
  vacuumIfFragmented,
  formatBytes,
  TMP_FILE_MAX_AGE_MS,
  VOICE_LOG_MAX_BYTES,
  CHECKPOINT_MAX_AGE_DAYS,
  RECENT_FLOOR_DAYS,
  CHECKPOINT_PROJECT_MAX_BYTES,
  CHECKPOINT_GLOBAL_MAX_BYTES,
};
