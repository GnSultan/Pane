/**
 * Pane Backup Engine
 *
 * Runs a daily backup of all user data at midnight.
 * Keeps the last 7 daily snapshots — automatic rotation.
 * Invisible to the user unless something actually broke.
 *
 * What gets backed up (~/.pane/):
 *   session/         — active task, working set, decisions per project
 *   memory/          — event logs, decisions, lessons per project
 *   brain/context/   — semantic context exports per project
 *   brain/exports/   — knowledge graph exports
 *   brain/symbols/   — symbol indexes
 *   profile/         — identity, rules, philosophy
 *   plans/           — plan history
 *   change-history/  — file edit tracking
 *   checkpoint/      — file snapshots
 *   state/           — MCP state
 *   benchmark-scout.json
 *
 *   brain/brain.db        — via SQLite .backup() API (safe while live)
 *   routing-store.db      — via SQLite .backup() API (safe while live)
 *
 * What gets skipped:
 *   backups/         — no recursion
 *   brain/models/    — large downloaded models, re-downloadable
 *   cache/           — ephemeral model lists
 *   record-change-debug.log
 */

import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const require2 = createRequire(import.meta.url);

const PANE_DIR  = path.join(os.homedir(), ".pane");
const BACKUP_ROOT = path.join(PANE_DIR, "backups");
const KEEP_DAYS = 7;

// Directories copied recursively (relative to PANE_DIR)
const COPY_DIRS = [
  "session",
  "memory",
  "profile",
  "plans",
  "change-history",
  "checkpoint",
  "state",
];

// Brain subdirectories — copy these but NOT brain/models (too large)
const COPY_BRAIN_SUBDIRS = ["context", "exports", "symbols"];

// Flat files copied directly (relative to PANE_DIR)
const COPY_FILES = ["benchmark-scout.json"];

// SQLite databases — backed up via .backup() API, not raw copy
const SQLITE_PATHS = [
  { src: path.join(PANE_DIR, "brain", "brain.db"),   dest: "brain/brain.db" },
  { src: path.join(PANE_DIR, "routing-store.db"),    dest: "routing-store.db" },
];

// ---------------------------------------------------------------------------
// SQLite hot backup — safe while the database is open in another connection
// ---------------------------------------------------------------------------

async function backupSqlite(srcPath, destPath) {
  if (!existsSync(srcPath)) return;
  mkdirSync(path.dirname(destPath), { recursive: true });

  let db = null;
  try {
    const Database = require2("better-sqlite3");
    db = new Database(srcPath, { readonly: true });
    await db.backup(destPath);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Directory / file copy
// ---------------------------------------------------------------------------

async function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  await fs.cp(src, dest, { recursive: true, errorOnExist: false, force: true });
}

async function copyFile(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

// ---------------------------------------------------------------------------
// Rotation — keep only the most recent KEEP_DAYS backups
// ---------------------------------------------------------------------------

async function rotate() {
  let entries;
  try {
    entries = await fs.readdir(BACKUP_ROOT);
  } catch {
    return; // no backups dir yet
  }

  // Backup dirs are named YYYY-MM-DD — sort ascending, drop oldest
  const dated = entries
    .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e))
    .sort();

  const toDelete = dated.slice(0, Math.max(0, dated.length - KEEP_DAYS));
  for (const name of toDelete) {
    try {
      await fs.rm(path.join(BACKUP_ROOT, name), { recursive: true, force: true });
      console.log("[backup] rotated out:", name);
    } catch (err) {
      console.warn("[backup] rotation failed for", name, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Core backup run
// ---------------------------------------------------------------------------

async function runBackup() {
  const tag = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(BACKUP_ROOT, tag);
  mkdirSync(dest, { recursive: true });

  console.log(`[backup] starting daily backup → ${dest}`);
  const t0 = Date.now();

  const tasks = [];

  // Regular directories
  for (const dir of COPY_DIRS) {
    tasks.push(copyDir(path.join(PANE_DIR, dir), path.join(dest, dir)));
  }

  // Brain subdirectories (skip models)
  for (const sub of COPY_BRAIN_SUBDIRS) {
    tasks.push(copyDir(
      path.join(PANE_DIR, "brain", sub),
      path.join(dest, "brain", sub),
    ));
  }

  // Flat files
  for (const file of COPY_FILES) {
    tasks.push(copyFile(path.join(PANE_DIR, file), path.join(dest, file)));
  }

  // SQLite hot backups
  for (const { src, dest: rel } of SQLITE_PATHS) {
    tasks.push(backupSqlite(src, path.join(dest, rel)));
  }

  const results = await Promise.allSettled(tasks);
  const failed  = results.filter(r => r.status === "rejected");
  if (failed.length > 0) {
    for (const f of failed) {
      console.warn("[backup] partial failure:", f.reason?.message ?? f.reason);
    }
  }

  console.log(`[backup] done in ${Date.now() - t0}ms (${failed.length} failures)`);

  // Rotate after successful backup
  await rotate();
}

// ---------------------------------------------------------------------------
// Schedule — fire at the next midnight, then every 24h
// ---------------------------------------------------------------------------

function msUntilMidnight() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0); // next 00:00:00.000
  return next - now;
}

export function startBackupSchedule() {
  const delay = msUntilMidnight();
  const hh = Math.floor(delay / 3_600_000);
  const mm = Math.floor((delay % 3_600_000) / 60_000);
  console.log(`[backup] next run in ${hh}h ${mm}m`);

  setTimeout(() => {
    runBackup().catch(err => console.error("[backup] run failed:", err.message));
    // After the first midnight fire, repeat every 24h exactly
    setInterval(() => {
      runBackup().catch(err => console.error("[backup] run failed:", err.message));
    }, 24 * 60 * 60 * 1000);
  }, delay);
}
