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
import path from "node:path";
import os from "node:os";
import { execThroughWorker } from "./tool-executor.mjs";
import { ipcMain, BrowserWindow } from "electron";

import { isLoggedIn, getAuthToken, getUserSecret, getCloudUser, getCloudApiUrl } from "./cloud-auth.mjs";
import { deriveKey, encryptFile, decryptFile, checksumFile } from "./cloud-crypto.mjs";
const PANE_DIR = path.join(os.homedir(), ".pane");
const TEMP_DIR = path.join(PANE_DIR, "tmp");

// ---------------------------------------------------------------------------
// Upload — called after local backup completes
// ---------------------------------------------------------------------------

/**
 * Compress, encrypt, and upload a local backup directory to Pane Cloud.
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
    // Route through cmd-worker (utility process) to avoid SyncProcessRunner crash.
    // NOTE: tar may block for several seconds during backup — runs in utility process.
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

    // Step 1: get upload URL
    const urlRes = await fetch(`${apiUrl}/backups/upload-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!urlRes.ok) {
      const err = await urlRes.json().catch(() => ({}));
      throw new Error(err.error || `Upload URL failed: ${urlRes.status}`);
    }

    const { backup_id, r2_key, upload_url } = await urlRes.json();

    // Step 2: upload encrypted blob
    const blob = await fs.readFile(encPath);
    const uploadRes = await fetch(`${apiUrl}${upload_url}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: blob,
    });

    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadRes.status}`);
    }

    // Step 3: finalize
    const finalizeRes = await fetch(`${apiUrl}/backups`, {
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
    console.log(`[cloud-sync] uploaded ${backup_id} (${stat.size} bytes)`);

    emitProgress("complete", { backup_id, size_bytes: stat.size });
    return { backup_id, size_bytes: stat.size };
  } finally {
    // Clean up temp files
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

    // Download
    const dlRes = await fetch(`${apiUrl}/backups/${latest.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

    const encData = Buffer.from(await dlRes.arrayBuffer());
    await fs.writeFile(encPath, encData);

    // Verify checksum
    const checksum = await checksumFile(encPath);
    if (checksum !== latest.checksum) {
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
    emitProgress("complete", { backup_id: latest.id, created_at: latest.created_at });

    return { backup_id: latest.id, created_at: latest.created_at };
  } finally {
    await fs.unlink(encPath).catch(() => {});
    await fs.unlink(tarPath).catch(() => {});
    await fs.rm(path.join(TEMP_DIR, "restore-staging"), { recursive: true, force: true }).catch(() => {});
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

  ipcMain.handle("cloud_trigger_backup", async () => {
    // Find the most recent local backup
    const backupRoot = path.join(PANE_DIR, "backups");
    if (!existsSync(backupRoot)) throw new Error("No local backups found");

    const dirs = (await fs.readdir(backupRoot))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();

    if (dirs.length === 0) throw new Error("No local backups found");

    const latestDir = path.join(backupRoot, dirs[0]);
    return uploadBackup(latestDir);
  });

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
