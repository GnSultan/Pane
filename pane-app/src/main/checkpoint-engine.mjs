/**
 * checkpoint-engine.mjs — file-snapshot checkpoints.
 *
 * A checkpoint captures the content of every dirty/untracked file at a moment
 * in time, plus the current git HEAD. Restoring returns the working tree to
 * that exact state — the robust, content-based "revert to here" primitive
 * (unlike change-history revert, which is a fragile per-edit string swap).
 *
 * Created automatically before each user turn, and on demand by the model via
 * the create_checkpoint tool. Shared by the IPC handler (user-facing restore
 * buttons) and the tool executor (model-initiated snapshots) so both modes
 * checkpoint through one code path.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPaneDb } from "./pane-db.mjs";

const execFileAsync = promisify(execFile);

const CHECKPOINT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const CHECKPOINT_MAX_FILES = 200;

export function checkpointDir(projectId) {
  return path.join(os.homedir(), ".pane", "checkpoints", projectId);
}

/**
 * Snapshot the current working-tree state into a checkpoint.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.workingDir - project root (must be a git repo)
 * @param {string} [params.messageId] - message this checkpoint is anchored to
 * @param {string} [params.label] - optional human/model label
 * @returns {Promise<{id: string|null, fileCount: number, timestamp?: number, reason?: string}>}
 */
export async function createCheckpointSnapshot({ projectId, workingDir, messageId, label }) {
  const cpId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Must be a git repo — checkpoints anchor to HEAD for tracked-file recovery.
  let headCommit = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workingDir });
    headCommit = stdout.trim();
  } catch {
    return { id: null, fileCount: 0, reason: "not-a-git-repo" };
  }

  let porcelain = "";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-unormal"],
      { cwd: workingDir },
    );
    porcelain = stdout;
  } catch {
    return { id: null, fileCount: 0, reason: "git-status-failed" };
  }

  const entries = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const gitStatus = line.slice(0, 2).trim();
    let filePath = line.slice(3);
    const arrowPos = filePath.indexOf(" -> ");
    if (arrowPos !== -1) filePath = filePath.slice(arrowPos + 4);
    entries.push({ relativePath: filePath, gitStatus });
  }

  const files = [];
  for (const { relativePath, gitStatus } of entries.slice(0, CHECKPOINT_MAX_FILES)) {
    const fullPath = path.join(workingDir, relativePath);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.size > CHECKPOINT_MAX_FILE_SIZE) continue;
      const buffer = await fs.promises.readFile(fullPath);
      // Binary check: null byte in first 512 bytes
      const checkLen = Math.min(buffer.length, 512);
      let isBinary = false;
      for (let i = 0; i < checkLen; i++) {
        if (buffer[i] === 0) { isBinary = true; break; }
      }
      if (isBinary) continue;
      files.push({ relativePath, content: buffer.toString("utf-8"), gitStatus });
    } catch {
      // File in status but unreadable (e.g. deleted) — record as absent
      files.push({ relativePath, content: null, gitStatus });
    }
  }

  const checkpoint = {
    id: cpId,
    timestamp: Date.now(),
    projectId,
    headCommit,
    files,
    messageId: messageId ?? null,
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
    cpId, projectId, messageId ?? null,
    checkpoint.timestamp, files.length, headCommit,
  );

  // Keep manifest.json in sync for tool-executor and pane-mcp-server.
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
