import type { Env, User, Backup } from "./types";

const MAX_CLOUD_BACKUPS = 7;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const PRESIGN_TTL = 1800; // 30 minutes

/**
 * Generate a presigned upload URL for direct-to-R2 upload.
 * Bypasses the Worker's body size limit.
 */
export async function getUploadUrl(
  user: User,
  env: Env,
): Promise<{ upload_url: string; backup_id: string; r2_key: string }> {
  const backupId = generateId();
  const r2Key = `${user.github_id}/${backupId}.tar.gz.enc`;

  // R2 presigned URLs require the S3-compatible API.
  // For Workers with R2 binding, we use a two-step approach:
  // Client uploads to a Worker endpoint that proxies to R2.
  // This keeps it simple and avoids S3 credential management.
  return {
    upload_url: `/backups/${backupId}/upload`,
    backup_id: backupId,
    r2_key: r2Key,
  };
}

/**
 * Handle the actual upload — receive the encrypted blob and write to R2.
 */
export async function handleUpload(
  backupId: string,
  body: ReadableStream | null,
  user: User,
  env: Env,
): Promise<{ success: boolean; size_bytes: number }> {
  if (!body) {
    throw new Error("No body provided");
  }

  const r2Key = `${user.github_id}/${backupId}.tar.gz.enc`;

  const obj = await env.BACKUPS.put(r2Key, body, {
    customMetadata: {
      user_id: String(user.id),
      backup_id: backupId,
    },
  });

  return { success: true, size_bytes: obj.size };
}

/**
 * Finalize a backup — register in D1 and enforce rotation.
 */
export async function finalizeBackup(
  user: User,
  data: {
    backup_id: string;
    r2_key: string;
    size_bytes: number;
    checksum: string;
    device_name?: string;
    app_version?: string;
  },
  env: Env,
): Promise<Backup> {
  // Insert backup record
  await env.DB.prepare(
    `INSERT INTO backups (id, user_id, r2_key, size_bytes, checksum, device_name, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      data.backup_id,
      user.id,
      data.r2_key,
      data.size_bytes,
      data.checksum,
      data.device_name || null,
      data.app_version || null,
    )
    .run();

  // Rotate — keep only the last MAX_CLOUD_BACKUPS
  const old = await env.DB.prepare(
    `SELECT id, r2_key FROM backups
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT -1 OFFSET ?`,
  )
    .bind(user.id, MAX_CLOUD_BACKUPS)
    .all<{ id: string; r2_key: string }>();

  for (const row of old.results) {
    await env.BACKUPS.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM backups WHERE id = ?").bind(row.id).run();
  }

  return {
    id: data.backup_id,
    user_id: user.id,
    r2_key: data.r2_key,
    size_bytes: data.size_bytes,
    checksum: data.checksum,
    device_name: data.device_name || null,
    app_version: data.app_version || null,
    created_at: new Date().toISOString(),
  };
}

/**
 * List backups for a user (most recent first).
 */
export async function listBackups(
  user: User,
  env: Env,
  limit = 10,
): Promise<Backup[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(user.id, limit)
    .all<Backup>();

  return result.results;
}

/**
 * Get a backup download stream from R2.
 */
export async function getBackupStream(
  backupId: string,
  user: User,
  env: Env,
): Promise<{ body: ReadableStream; size: number; checksum: string } | null> {
  // Verify ownership
  const backup = await env.DB.prepare(
    "SELECT * FROM backups WHERE id = ? AND user_id = ?",
  )
    .bind(backupId, user.id)
    .first<Backup>();

  if (!backup) return null;

  const obj = await env.BACKUPS.get(backup.r2_key);
  if (!obj) return null;

  return {
    body: obj.body,
    size: obj.size,
    checksum: backup.checksum,
  };
}

/**
 * Delete a specific backup.
 */
export async function deleteBackup(
  backupId: string,
  user: User,
  env: Env,
): Promise<boolean> {
  const backup = await env.DB.prepare(
    "SELECT * FROM backups WHERE id = ? AND user_id = ?",
  )
    .bind(backupId, user.id)
    .first<Backup>();

  if (!backup) return false;

  await env.BACKUPS.delete(backup.r2_key);
  await env.DB.prepare("DELETE FROM backups WHERE id = ?")
    .bind(backupId)
    .run();

  return true;
}

/**
 * Delete all backups for a user (account deletion).
 */
export async function deleteAllBackups(user: User, env: Env): Promise<void> {
  const all = await env.DB.prepare(
    "SELECT r2_key FROM backups WHERE user_id = ?",
  )
    .bind(user.id)
    .all<{ r2_key: string }>();

  for (const row of all.results) {
    await env.BACKUPS.delete(row.r2_key);
  }

  await env.DB.prepare("DELETE FROM backups WHERE user_id = ?")
    .bind(user.id)
    .run();
}

/**
 * Get storage usage for a user.
 */
export async function getUsage(
  user: User,
  env: Env,
): Promise<{ total_bytes: number; backup_count: number }> {
  const result = await env.DB.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) as total_bytes, COUNT(*) as backup_count FROM backups WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ total_bytes: number; backup_count: number }>();

  return result || { total_bytes: 0, backup_count: 0 };
}

function generateId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
