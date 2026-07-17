import type { Env, User, Backup } from "./types";

const MAX_CLOUD_BACKUPS = 7;

// ---------------------------------------------------------------------------
// Multipart upload — splits the backup into chunks so each part stays well
// under the Worker's 100MB body limit.
// ---------------------------------------------------------------------------

/**
 * Initiate a multipart upload. Client will upload parts one at a time,
 * then call completeMultipartUpload.
 */
export async function initMultipartUpload(
  user: User,
  env: Env,
): Promise<{
  backup_id: string;
  r2_key: string;
  upload_id: string;
}> {
  const backupId = generateId();
  const r2Key = `${user.github_id}/${backupId}.tar.gz.enc`;

  const multipartUpload = await env.BACKUPS.createMultipartUpload(r2Key);

  return {
    backup_id: backupId,
    r2_key: r2Key,
    upload_id: multipartUpload.uploadId,
  };
}

/**
 * Upload a single part of a multipart upload.
 * Each part should be ≤ 5 MB to stay well under Worker limits.
 *
 * Buffers the incoming stream to an ArrayBuffer before passing to R2,
 * because direct ReadableStream piping can hang in some Workers runtime
 * configurations (the stream's completion signal may not reach R2's
 * multipart upload API reliably).
 */
export async function uploadPart(
  r2Key: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream,
  env: Env,
): Promise<{ etag: string }> {
  const resume = env.BACKUPS.resumeMultipartUpload(r2Key, uploadId);

  // Buffer the incoming stream to a known-length ArrayBuffer.
  // 4MB per part → negligible CPU cost on the Worker.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.byteLength;
  }

  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const result = await resume.uploadPart(partNumber, combined.buffer as ArrayBuffer);
  return { etag: result.etag };
}

/**
 * Complete a multipart upload, assembling all parts.
 */
export async function completeMultipartUpload(
  r2Key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
  env: Env,
): Promise<void> {
  const resume = env.BACKUPS.resumeMultipartUpload(r2Key, uploadId);
  // Sort by part number — R2 requires ascending order
  parts.sort((a, b) => a.partNumber - b.partNumber);
  await resume.complete(parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })));
}

/**
 * Abort a multipart upload (cleanup on failure).
 */
export async function abortMultipartUpload(
  r2Key: string,
  uploadId: string,
  env: Env,
): Promise<void> {
  try {
    const resume = env.BACKUPS.resumeMultipartUpload(r2Key, uploadId);
    await resume.abort();
  } catch {
    // Abort is best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Backup finalization + CRUD
// ---------------------------------------------------------------------------

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
