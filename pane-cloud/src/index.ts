/**
 * Pane Cloud — Cloudflare Worker
 *
 * Thin API layer: auth, backup CRUD, presigned upload/download.
 * All backup data is encrypted client-side before it reaches R2.
 */

import type { Env, User } from "./types";
import { handleGitHubAuth, authenticateRequest } from "./auth";
import {
  getUploadUrl,
  handleUpload,
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

    // CORS headers for Electron app
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const res = await route(method, path, request, env);
      // Add CORS headers to every response
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

  // ── Backups ───────────────────────────────────────────────────────────
  if (method === "POST" && path === "/backups/upload-url") {
    const result = await getUploadUrl(user, env);
    return json(result);
  }

  // Direct upload endpoint — client PUTs encrypted blob here
  const uploadMatch = path.match(/^\/backups\/([a-f0-9]+)\/upload$/);
  if (method === "PUT" && uploadMatch) {
    const backupId = uploadMatch[1];
    const result = await handleUpload(backupId, request.body, user, env);
    return json(result);
  }

  if (method === "POST" && path === "/backups") {
    const body = await request.json<{
      backup_id: string;
      r2_key: string;
      size_bytes: number;
      checksum: string;
      device_name?: string;
      app_version?: string;
    }>();
    const backup = await finalizeBackup(user, body, env);
    return json(backup);
  }

  if (method === "GET" && path === "/backups") {
    const limit = parseInt(new URL(request.url).searchParams.get("limit") || "10");
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
