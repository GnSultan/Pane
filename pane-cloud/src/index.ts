/**
 * Pane Cloud — Cloudflare Worker
 *
 * Thin API layer: auth, backup CRUD, multipart upload.
 * Large backups are split into ≤4MB parts to stay under body size limits.
 * Parts are reassembled in R2 via the binding's multipart Upload API.
 */

import type { Env } from "./types";
import { handleGitHubAuth, authenticateRequest } from "./auth";
import {
  initMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  finalizeBackup,
  listBackups,
  getBackupStream,
  deleteBackup,
  deleteAllBackups,
  getUsage,
} from "./backups";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const res = await route(method, path, request, url, env);
      for (const [k, v] of Object.entries(corsHeaders)) {
        res.headers.set(k, v);
      }
      return res;
    } catch (err: any) {
      return json({ error: err.message || "Internal error" }, 500, corsHeaders);
    }
  },
};

async function route(
  method: string,
  path: string,
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {

  // ── Public: auth ──────────────────────────────────────────────────────
  if (method === "POST" && path === "/auth/github") {
    const body = await request.json<{ code: string }>();
    if (!body.code) return json({ error: "Missing code" }, 400);
    const result = await handleGitHubAuth(body.code, env);
    return json({
      access_token: result.access_token,
      user: {
        github_id: result.user.github_id,
        github_login: result.user.github_login,
        avatar_url: result.user.avatar_url,
      },
      user_secret: result.user.user_secret,
    });
  }

  // ── Everything below requires auth ────────────────────────────────────
  const user = await authenticateRequest(request, env);
  if (!user) return json({ error: "Unauthorized" }, 401);

  // ── User ──────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/user") {
    return json({
      github_id: user.github_id,
      github_login: user.github_login,
      avatar_url: user.avatar_url,
      user_secret: user.user_secret,
    });
  }

  if (method === "DELETE" && path === "/user") {
    await deleteAllBackups(user, env);
    await env.DB.prepare("DELETE FROM devices WHERE user_id = ?")
      .bind(user.id)
      .run();
    await env.DB.prepare("DELETE FROM users WHERE id = ?")
      .bind(user.id)
      .run();
    return json({ deleted: true });
  }

  // ── Backups: multipart upload ─────────────────────────────────────────
  //
  // Flow:
  //   1. POST /backups/upload-init  →  { backup_id, r2_key, upload_id }
  //   2. PUT /backups/upload-part/{backupId}?partNumber=N&uploadId=X&r2Key=Y  →  { etag }
  //   3. POST /backups/upload-complete  →  complete multipart, then finalize

  if (method === "POST" && path === "/backups/upload-init") {
    const result = await initMultipartUpload(user, env);
    return json(result);
  }

  if (method === "PUT" && /^\/backups\/upload-part\/[a-f0-9]+$/.test(path)) {
    const partNumber = parseInt(url.searchParams.get("partNumber") || "0");
    const uploadId = url.searchParams.get("uploadId") || "";
    const r2Key = url.searchParams.get("r2Key") || "";

    if (!partNumber || partNumber < 1 || partNumber > 10000) {
      return json({ error: "Invalid partNumber (1-10000)" }, 400);
    }
    if (!uploadId || !r2Key) {
      return json({ error: "Missing uploadId or r2Key" }, 400);
    }

    // Verify ownership — confirm this user's r2Key starts with their ID
    if (!r2Key.startsWith(`${user.github_id}/`)) {
      return json({ error: "r2Key does not match user" }, 403);
    }

    // Stream the part body directly to R2 — no buffering
    // Cloudflare Workers limit: 100MB per request, but parts are ≤4MB
    const result = await uploadPart(r2Key, uploadId, partNumber, request.body!, env);
    return json(result);
  }

  if (method === "POST" && path === "/backups/upload-complete") {
    const body = await request.json<{
      backup_id: string;
      r2_key: string;
      upload_id: string;
      parts: { partNumber: number; etag: string }[];
      size_bytes: number;
      checksum: string;
      device_name?: string;
      app_version?: string;
    }>();

    if (!body.r2_key.startsWith(`${user.github_id}/`)) {
      return json({ error: "r2_key does not match user" }, 403);
    }

    // Complete the multipart upload in R2
    await completeMultipartUpload(body.r2_key, body.upload_id, body.parts, env);

    // Register in D1
    const backup = await finalizeBackup(user, {
      backup_id: body.backup_id,
      r2_key: body.r2_key,
      size_bytes: body.size_bytes,
      checksum: body.checksum,
      device_name: body.device_name,
      app_version: body.app_version,
    }, env);

    return json(backup);
  }

  if (method === "POST" && path === "/backups/upload-abort") {
    const body = await request.json<{ r2_key: string; upload_id: string }>();
    await abortMultipartUpload(body.r2_key, body.upload_id, env);
    return json({ aborted: true });
  }

  // ── Backups: list / download / delete ─────────────────────────────────

  if (method === "GET" && path === "/backups") {
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const backups = await listBackups(user, env, Math.min(limit, 50));
    return json({ backups });
  }

  const downloadMatch = path.match(/^\/backups\/([a-f0-9]+)\/download$/);
  if (method === "GET" && downloadMatch) {
    const backupId = downloadMatch[1];
    const result = await getBackupStream(backupId, user, env);
    if (!result) return json({ error: "Backup not found" }, 404);
    return new Response(result.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(result.size),
        "X-Checksum": result.checksum,
      },
    });
  }

  const deleteMatch = path.match(/^\/backups\/([a-f0-9]+)$/);
  if (method === "DELETE" && deleteMatch) {
    const ok = await deleteBackup(deleteMatch[1], user, env);
    return ok ? json({ deleted: true }) : json({ error: "Not found" }, 404);
  }

  // ── Usage ─────────────────────────────────────────────────────────────
  if (method === "GET" && path === "/usage") {
    const usage = await getUsage(user, env);
    return json(usage);
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
