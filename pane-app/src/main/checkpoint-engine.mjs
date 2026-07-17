/**
 * checkpoint-engine.mjs — copy-on-write file checkpoints.
 *
 * No git dependency. Instead of snapshotting git-dirty files before each turn,
 * we intercept file writes as they happen during a turn. Right before the
 * first write to each file, we save its current content. This "journal" of
 * pre-edit state is flushed to a checkpoint on disk when the model calls
 * pane_checkpoint. Restoring simply writes all journaled files back.
 *
 * Shell commands with write intent trigger a full project pre-snapshot
 * (capped at 200 files / 2MB per file) to cover writes that bypass tools.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getPaneDb } from "./pane-db.mjs";

const CHECKPOINT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const CHECKPOINT_MAX_FILES = 200;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".pane", "target", ".turbo", "coverage", ".nyc_output",
]);

export function checkpointDir(projectId) {
  return path.join(os.homedir(), ".pane", "checkpoints", projectId);
}

/**
 * Read a file's current content for journaling.
 * @param {string} fullPath - absolute path
 * @returns {Promise<string|null|undefined>}
 *   string = file content, null = file doesn't exist, undefined = skip (binary/oversized)
 */
export async function readFileForJournal(fullPath) {
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.size > CHECKPOINT_MAX_FILE_SIZE) return undefined;
    const buffer = await fs.promises.readFile(fullPath);
    const checkLen = Math.min(buffer.length, 512);
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) return undefined; // binary
    }
    return buffer.toString("utf-8");
  } catch {
    return null; // file doesn't exist
  }
}

/**
 * Walk a directory recursively, collecting all text-file paths.
 * Skips binary files, oversized files, and known noise directories.
 * @param {string} dirPath - absolute directory path
 * @param {number} maxFiles - stop after this many files
 * @returns {Promise<string[]>} absolute file paths
 */
async function walkProjectFiles(dirPath, maxFiles) {
  const results = [];
  const stack = [dirPath];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".gitignore") continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > CHECKPOINT_MAX_FILE_SIZE) continue;
          results.push(fullPath);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  return results;
}

/**
 * Snapshot all project files into a journal Map.
 * Used as a safety net before shell commands with write intent.
 * @param {string} workingDir - project root
 * @param {Map<string, string|null>} existingJournal - merge into this, don't overwrite existing entries
 * @returns {Promise<number>} number of newly journaled files
 */
export async function snapshotAllFiles(workingDir, existingJournal) {
  const paths = await walkProjectFiles(workingDir, CHECKPOINT_MAX_FILES);
  let added = 0;

  for (const fullPath of paths) {
    const relativePath = path.relative(workingDir, fullPath);
    if (existingJournal.has(relativePath)) continue;
    const content = await readFileForJournal(fullPath);
    if (content !== undefined) {
      existingJournal.set(relativePath, content);
      added++;
    }
  }
  return added;
}

/**
 * Flush an accumulated file journal to a checkpoint file on disk.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.workingDir
 * @param {Map<string, string|null>} params.journal - relativePath → preEditContent
 * @param {string} [params.label]
 * @returns {Promise<{id: string|null, fileCount: number, timestamp?: number, reason?: string}>}
 */
export async function flushJournal({ projectId, workingDir, journal, label }) {
  if (!journal || journal.size === 0) {
    return { id: null, fileCount: 0, reason: "no-files-journaled" };
  }

  const cpId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const files = [];
  for (const [relativePath, preEditContent] of journal) {
    files.push({ relativePath, content: preEditContent });
  }

  const checkpoint = {
    id: cpId,
    timestamp: Date.now(),
    projectId,
    files,
    label: label ?? null,
  };

  const dir = checkpointDir(projectId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${cpId}.json`),
    JSON.stringify(checkpoint),
    "utf-8",
  );

  const db = getPaneDb();
  db.stmts.insertCheckpoint.run(
    cpId, projectId, null,
    checkpoint.timestamp, files.length, null,
  );

  // Keep manifest.json in sync
  try {
    const allMeta = db.stmts.listCheckpoints.all(projectId);
    const manifest = allMeta.map((m) => ({
      id: m.id,
      timestamp: m.created_at,
      messageId: m.message_id,
      fileCount: m.file_count,
      headCommit: m.head_commit,
      workingDir,
    }));
    await fs.promises.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ projectId, projectRoot: workingDir, checkpoints: manifest }),
      "utf-8",
    );
  } catch {}

  return { id: cpId, fileCount: files.length, timestamp: checkpoint.timestamp };
}

/**
 * Create a checkpoint from an accumulated journal.
 * Replaces the old git-based createCheckpointSnapshot.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.workingDir
 * @param {Map<string, string|null>} params.journal - accumulated pre-edit state
 * @param {string} [params.messageId]
 * @param {string} [params.label]
 * @returns {Promise<{id: string|null, fileCount: number, timestamp?: number, reason?: string}>}
 */
export async function createCheckpointSnapshot({ projectId, workingDir, journal, messageId, label }) {
  if (!journal || journal.size === 0) {
    return { id: null, fileCount: 0, reason: "no-files-journaled" };
  }
  return flushJournal({ projectId, workingDir, journal, label });
}

/**
 * Restore files from a checkpoint — writes all journaled files back to their
 * pre-edit state. Files that were created during the turn (preEditContent === null)
 * are deleted. No git dependency.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.checkpointId
 * @param {string} params.workingDir
 * @returns {Promise<{success: boolean, error?: string, restoredFiles: Array<{path: string, action: string}>}>}
 */
export async function restoreCheckpoint({ projectId, checkpointId, workingDir }) {
  let checkpoint;
  try {
    const raw = await fs.promises.readFile(
      path.join(checkpointDir(projectId), `${checkpointId}.json`),
      "utf-8",
    );
    checkpoint = JSON.parse(raw);
  } catch {
    return { success: false, error: "Checkpoint not found", restoredFiles: [] };
  }

  const restored = [];

  for (const file of checkpoint.files) {
    const fullPath = path.join(workingDir, file.relativePath);
    try {
      if (file.content === null) {
        // File didn't exist at checkpoint time — delete it
        try {
          await fs.promises.unlink(fullPath);
          restored.push({ path: file.relativePath, action: "deleted" });
        } catch {
          // already gone
          restored.push({ path: file.relativePath, action: "already_gone" });
        }
      } else {
        // Restore file to its pre-edit content
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, file.content, "utf-8");
        restored.push({ path: file.relativePath, action: "restored" });
      }
    } catch (err) {
      restored.push({ path: file.relativePath, action: "failed", error: err.message });
    }
  }

  return { success: true, restoredFiles: restored };
}
