/**
 * Pane Cloud Sync
 *
 * Compress → encrypt → upload daily backups to Pane Cloud.
 * Download → decrypt → decompress for restore on new devices.
 *
 * Uses system tar (no npm dependency) and cloud-crypto for AES-256-GCM.
 */

import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { execThroughWorker } from "./tool-executor.mjs";
import { ipcMain, BrowserWindow } from "electron";

import { isLoggedIn, getAuthToken, getUserSecret, getCloudUser, getCloudApiUrl } from "./cloud-auth.mjs";
import { deriveKey, encryptFile, decryptFile, checksumFile } from "./cloud-crypto.mjs";

const require2 = createRequire(import.meta.url);
const PANE_DIR = path.join(os.homedir(), ".pane");
const TEMP_DIR = path.join(PANE_DIR, "tmp");

// ── Fetch timeout ───────────────────────────────────────────────────────
// Cloudflare Workers have a 30s CPU timeout per invocation, but I/O (fetch,
// R2) doesn't count — so a hanging R2 call would never timeout on its own.
// We add client-side timeouts to match the Worker's expected response window.
const FETCH_TIMEOUT = 60_000; // 60s — generous but not infinite

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Upload — called after local backup completes
// ---------------------------------------------------------------------------

/**
 * Compress, encrypt, and upload a local backup directory to Pane Cloud.
 *
 * Uploads directly to R2 via an AWS SigV4 presigned PUT URL — zero Worker
 * buffering, no body size limits, one HTTP round-trip instead of the
 * legacy multipart-though-Worker approach.
 *
 * @param {string} backupDir — path to the dated backup dir (e.g. ~/.pane/backups/2026-03-22/)
 * @returns {{ backup_id: string, size_bytes: number }}
 */
export async function uploadBackup(backupDir) {
  if (!isLoggedIn()) throw new Error("Not logged in");
  if (!existsSync(backupDir)) throw new Error(`Backup dir not found: ${backupDir}`);

  const token     = getAuthToken();
  const secret    = getUserSecret();
  const user      = getCloudUser();
  const apiUrl    = getCloudApiUrl();
  const key       = deriveKey(secret, user.github_id);

  mkdirSync(TEMP_DIR, { recursive: true });
  const tarPath = path.join(TEMP_DIR, "backup.tar.gz");
  const encPath = path.join(TEMP_DIR, "backup.tar.gz.enc");

  try {
    emitProgress("compressing");

    // Compress backup directory
    const tarCompressCmd = `tar czf ${tarPath} -C ${backupDir} .`;
    const tarResult = await execThroughWorker(tarCompressCmd, { timeout: 120 });
    if (!tarResult.success) {
      throw new Error(`Backup compression failed: ${tarResult.errorMessage || tarResult.stderr}`);
    }

    emitProgress("encrypting");

    // Encrypt
    await encryptFile(tarPath, encPath, key);

    // Checksum of the encrypted blob
    const checksum = await checksumFile(encPath);
    const stat = await fs.stat(encPath);

    emitProgress("uploading");

    // Step 1: Request a presigned upload URL from the Worker
    const urlRes = await fetchWithTimeout(`${apiUrl}/backups/upload-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ size_bytes: stat.size, checksum }),
    });

    if (!urlRes.ok) {
      const err = await urlRes.json().catch(() => ({}));
      throw new Error(err.error || `Failed to get upload URL: ${urlRes.status}`);
    }

    const { backup_id, r2_key, upload_url } = await urlRes.json();

    // Step 2: Upload directly to R2 via presigned URL — no Worker proxy,
    // no body size limits, no multipart buffering. One round-trip.
    // Timeout: larger uploads need more time; 5 minutes covers ~500 MB
    // on a typical connection.
    const R2_UPLOAD_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    const encData = await fs.readFile(encPath);

    const r2Ctrl = new AbortController();
    const r2Timer = setTimeout(() => r2Ctrl.abort(), R2_UPLOAD_TIMEOUT);
    let uploadRes;
    try {
      uploadRes = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: encData,
        signal: r2Ctrl.signal,
      });
    } finally {
      clearTimeout(r2Timer);
    }

    if (!uploadRes.ok) {
      throw new Error(`R2 upload failed: ${uploadRes.status} ${uploadRes.statusText || ""}`);
    }

    // Step 3: Finalize — register in D1 and rotate old backups
    const finalizeRes = await fetchWithTimeout(`${apiUrl}/backups/upload-complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        backup_id,
        r2_key,
        size_bytes: stat.size,
        checksum,
        device_name: os.hostname(),
        app_version: "1.0.0",
      }),
    });

    if (!finalizeRes.ok) {
      const err = await finalizeRes.json().catch(() => ({}));
      throw new Error(err.error || `Finalize failed: ${finalizeRes.status}`);
    }

    await finalizeRes.json();
    console.log(`[cloud-sync] uploaded ${backup_id} (${stat.size} bytes, direct R2)`);

    emitProgress("complete", { backup_id, size_bytes: stat.size });
    return { backup_id, size_bytes: stat.size };
  } catch (err) {
    emitProgress("error", { message: err.message || "Upload failed" });
    console.warn("[cloud-sync] upload failed:", err.message);
    throw err;
  } finally {
    await fs.unlink(tarPath).catch(() => {});
    await fs.unlink(encPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Download + Restore
// ---------------------------------------------------------------------------

/**
 * Download the latest cloud backup, decrypt, and decompress into ~/.pane/.
 * WARNING: This overwrites local data.
 */
export async function restoreFromCloud() {
  if (!isLoggedIn()) throw new Error("Not logged in");

  const token     = getAuthToken();
  const secret    = getUserSecret();
  const user      = getCloudUser();
  const apiUrl    = getCloudApiUrl();
  const key       = deriveKey(secret, user.github_id);

  mkdirSync(TEMP_DIR, { recursive: true });
  const encPath = path.join(TEMP_DIR, "restore.tar.gz.enc");
  const tarPath = path.join(TEMP_DIR, "restore.tar.gz");

  try {
    emitProgress("finding");

    // List backups, get latest
    const listRes = await fetch(`${apiUrl}/backups?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!listRes.ok) throw new Error(`List failed: ${listRes.status}`);
    const { backups } = await listRes.json();

    if (!backups || backups.length === 0) {
      throw new Error("No cloud backups found");
    }

    const latest = backups[0];

    emitProgress("downloading");

    // Download stream from Worker — Worker proxies from R2 directly
    const dlRes = await fetch(`${apiUrl}/backups/${latest.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

    const checksum = dlRes.headers.get("X-Checksum") || latest.checksum;
    const encData = Buffer.from(await dlRes.arrayBuffer());
    await fs.writeFile(encPath, encData);

    // Verify checksum
    const actualChecksum = await checksumFile(encPath);
    if (actualChecksum !== checksum) {
      throw new Error("Checksum mismatch — download may be corrupted");
    }

    emitProgress("decrypting");

    // Decrypt
    await decryptFile(encPath, tarPath, key);

    emitProgress("restoring");

    // Decompress into ~/.pane/ — overwrites existing data
    // Extract into a temp dir first, then move to avoid partial restores
    const restoreDir = path.join(TEMP_DIR, "restore-staging");
    mkdirSync(restoreDir, { recursive: true });
    const tarDecompressCmd = `tar xzf ${tarPath} -C ${restoreDir}`;
    const tarResult = await execThroughWorker(tarDecompressCmd, { timeout: 120 });
    if (!tarResult.success) {
      throw new Error(`Restore decompression failed: ${tarResult.errorMessage || tarResult.stderr}`);
    }

    // Move restored contents into ~/.pane/
    const entries = await fs.readdir(restoreDir);
    for (const entry of entries) {
      const src  = path.join(restoreDir, entry);
      const dest = path.join(PANE_DIR, entry);
      // Remove existing, then move restored
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.rename(src, dest);
    }

    console.log(`[cloud-sync] restored backup ${latest.id} from ${latest.created_at}`);

    // Post-restore: rebuild FTS index (messages_fts was excluded from backup)
    emitProgress("rebuilding-fts");
    try {
      rebuildFtsIndex(path.join(PANE_DIR, "pane.db"));
    } catch (err) {
      console.warn("[cloud-sync] FTS rebuild failed (non-fatal):", err.message);
    }

    emitProgress("complete", { backup_id: latest.id, created_at: latest.created_at });
    return { backup_id: latest.id, created_at: latest.created_at };
  } finally {
    await fs.unlink(encPath).catch(() => {});
    await fs.unlink(tarPath).catch(() => {});
    await fs.rm(path.join(TEMP_DIR, "restore-staging"), { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// FTS rebuild — called after restore to repopulate search index
// ---------------------------------------------------------------------------

/**
 * Rebuild the FTS5 search index from the messages table.
 *
 * The optimized backup excludes messages_fts (33 MB recreatable index).
 * After restore, this function repopulates it from the messages table.
 * Called synchronously — the app will block on FTS search until this
 * completes, but that's acceptable for a one-time post-restore step.
 *
 * @param {string} paneDbPath — path to the restored pane.db
 */
function rebuildFtsIndex(paneDbPath) {
  if (!existsSync(paneDbPath)) {
    console.warn("[cloud-sync] pane.db not found at", paneDbPath, "— skipping FTS rebuild");
    return;
  }

  const Database = require2("better-sqlite3");
  const db = new Database(paneDbPath);
  try {
    // Create FTS virtual table if it doesn't exist
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        project_id  UNINDEXED,
        message_id  UNINDEXED,
        text_content,
        tokenize = 'porter unicode61'
      )
    `);

    // Find messages not yet indexed
    const messages = db.prepare(`
      SELECT m.id, m.project_id, m.content
      FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.message_id = m.id)
    `).all();

    if (messages.length === 0) {
      console.log("[cloud-sync] FTS index already up to date — nothing to rebuild");
      return;
    }

    const insert = db.prepare("INSERT INTO messages_fts (project_id, message_id, text_content) VALUES (?, ?, ?)");

    // Inline version of extractMessageText to avoid circular dependency on pane-db.mjs
    const extractText = (contentJson) => {
      try {
        const msg = JSON.parse(contentJson);
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        return blocks
          .filter(b => b.type === "text" && typeof b.text === "string")
          .map(b => b.text)
          .join(" ")
          .trim();
      } catch {
        return "";
      }
    };

    const batchInsert = db.transaction((items) => {
      for (const msg of items) {
        const text = extractText(msg.content);
        if (text) {
          insert.run(msg.project_id, msg.id, text);
        }
      }
    });

    batchInsert(messages);
    console.log(`[cloud-sync] Rebuilt FTS index: ${messages.length} messages indexed (${db.prepare("SELECT COUNT(*) as cnt FROM messages_fts").get().cnt} total entries)`);

    // Recreate the delete trigger that keeps FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete
      AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END
    `);
  } catch (err) {
    console.warn("[cloud-sync] FTS rebuild error:", err.message);
    throw err;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Cloud status
// ---------------------------------------------------------------------------

/**
 * Fetch cloud backup status for UI display.
 */
export async function getCloudStatus() {
  if (!isLoggedIn()) return null;

  const token  = getAuthToken();
  const apiUrl = getCloudApiUrl();

  const [usageRes, backupsRes] = await Promise.all([
    fetch(`${apiUrl}/usage`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${apiUrl}/backups?limit=1`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  const usage   = usageRes.ok ? await usageRes.json() : { total_bytes: 0, backup_count: 0 };
  const backups = backupsRes.ok ? await backupsRes.json() : { backups: [] };

  return {
    last_backup: backups.backups?.[0]?.created_at || null,
    storage_bytes: usage.total_bytes,
    storage_mb: Math.round((usage.total_bytes / 1024 / 1024) * 10) / 10,
    backup_count: usage.backup_count,
  };
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

export function registerCloudSyncHandlers() {
  ipcMain.handle("cloud_get_status", async () => {
    return getCloudStatus();
  });

  // cloud_trigger_backup is registered in backup-engine.mjs (runs local backup first)

  ipcMain.handle("cloud_restore", async () => {
    return restoreFromCloud();
  });

  ipcMain.handle("cloud_list_backups", async () => {
    if (!isLoggedIn()) return { backups: [] };
    const token  = getAuthToken();
    const apiUrl = getCloudApiUrl();
    const res = await fetch(`${apiUrl}/backups?limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok ? await res.json() : { backups: [] };
  });
}

// ---------------------------------------------------------------------------
// Progress events — pushed to renderer
// ---------------------------------------------------------------------------

function emitProgress(phase, data = {}) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send("cloud-sync-progress", { phase, ...data });
  }
}
