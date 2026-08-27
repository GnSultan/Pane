/**
 * Pane-native OpenAI Login
 *
 * Mirrors claude-login.mjs — reads OAuth credentials from the Codex CLI.
 *
 * Primary approach: SYNC from Codex CLI credentials (~/.codex/auth.json).
 *   The Codex CLI stores OAuth tokens after `npx @openai/codex login` or
 *   `npx openai-oauth login`. We read those and cache them in Pane's own store.
 *
 * Fallback: OAuth 2.0 PKCE authorization code flow (if no CLI credentials exist).
 *   Opens system browser → user authorizes → browser redirects to localhost callback →
 *   we exchange the code for tokens and store them.
 *
 * The upstream API endpoint is `chatgpt.com/backend-api/codex` which supports
 * `/v1/chat/completions`, `/v1/responses`, and `/v1/models`.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shell } from "electron";

// ── Constants ──────────────────────────────────────────────────────────────

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_AUTHORIZE_URL = `${OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${OAUTH_ISSUER}/oauth/token`;
const OAUTH_SCOPES = "openid profile email offline_access";

// ── State ──────────────────────────────────────────────────────────────────

let _loginPromise = null;

// ── PKCE ──────────────────────────────────────────────────────────────────

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE() {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── Callback Server ────────────────────────────────────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>Pane — Signed In</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f17;color:#e0e0e0;}
.card{text-align:center;padding:40px;}h1{color:#10b981;margin:0 0 12px;}p{opacity:.7;margin:0;}</style>
</head><body><div class="card"><h1>✓ Signed in to OpenAI</h1><p>You can close this tab and return to Pane.</p></div></body></html>`;

const ERROR_HTML = (msg) =>
  `<!DOCTYPE html><html><head><title>Pane — Sign In Failed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f17;color:#e0e0e0;}
.card{text-align:center;padding:40px;}h1{color:#ef4444;margin:0 0 12px;}p{opacity:.7;margin:0;}</style>
</head><body><div class="card"><h1>Sign In Failed</h1><p>${msg}</p></div></body></html>`;

function startCallbackServer(timeoutMs = 120_000) {
  return new Promise((outerResolve, outerReject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        res.writeHead(400).end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(ERROR_HTML(errorDesc || error));
        rejectCode(new Error(`OAuth error: ${errorDesc || error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_HTML);
        resolveCode({ code, state });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Waiting…</p>");
    });

    server.unref();

    server.listen(0, "localhost", () => {
      const port = server.address().port;

      const timer = setTimeout(() => {
        rejectCode(new Error("Login timed out — no response from browser after 2 minutes."));
      }, timeoutMs);

      const promise = codePromise
        .then((r) => { clearTimeout(timer); server.close(); return r; })
        .catch((e) => { clearTimeout(timer); server.close(); throw e; });

      outerResolve({ port, promise });
    });

    server.on("error", outerReject);
  });
}

// ── Token Exchange ─────────────────────────────────────────────────────────

async function exchangeCodeForTokens(code, codeVerifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);

  let res;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error("Token exchange returned non-JSON response");
  }

  if (!data.access_token) throw new Error("Token exchange: no access_token in response");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    idToken: data.id_token || null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

// ── Credential File Storage ────────────────────────────────────────────────

function getPaneCredPath() {
  return join(homedir(), ".pane", "openai-credentials.json");
}

function writePaneCredentials(creds) {
  const payload = JSON.stringify({
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken || null,
    idToken: creds.idToken || null,
    expiresAt: creds.expiresAt,
    accountId: creds.accountId || null,
    lastRefresh: new Date().toISOString(),
  });

  try {
    const dir = join(homedir(), ".pane");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(getPaneCredPath(), payload, { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(getPaneCredPath(), 0o600);
    console.log("[openai-login] credentials written to file");
  } catch (err) {
    console.warn("[openai-login] file write failed:", err.message);
  }
}

function readPaneCredentials() {
  try {
    const data = JSON.parse(readFileSync(getPaneCredPath(), "utf-8"));
    if (typeof data.accessToken === "string" && data.accessToken) return data;
  } catch {}
  return null;
}

function deletePaneCredentials() {
  try {
    if (existsSync(getPaneCredPath())) unlinkSync(getPaneCredPath());
  } catch {}
}

// ── Codex CLI Credential Sync ──────────────────────────────────────────────

/**
 * Derive the ChatGPT account ID from a JWT token.
 */
function deriveAccountId(token) {
  if (!token || !token.includes(".")) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));

    // Check nested claim first
    const authClaim = payload["https://api.openai.com/auth"];
    if (authClaim && typeof authClaim.chatgpt_account_id === "string") {
      return authClaim.chatgpt_account_id;
    }
    if (typeof payload.chatgpt_account_id === "string") {
      return payload.chatgpt_account_id;
    }
    // Try organizations
    if (Array.isArray(payload.organizations) && payload.organizations[0]?.id) {
      return payload.organizations[0].id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read Codex CLI stored OAuth credentials from ~/.codex/auth.json.
 */
function readCodexCredentials() {
  const candidates = [];

  // CODEX_HOME override
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) candidates.push(join(codexHome, "auth.json"));

  // Default location
  candidates.push(join(homedir(), ".codex", "auth.json"));

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(raw);

      const tokens = parsed.tokens;
      if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) continue;

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        idToken: tokens.id_token || null,
        accountId: tokens.account_id || deriveAccountId(tokens.id_token) || deriveAccountId(tokens.access_token) || null,
        expiresAt: 0, // We don't store expiry in the file — use JWT exp claim
        lastRefresh: parsed.last_refresh || null,
        _sourcePath: candidate,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Copy Codex CLI credentials to Pane's own store.
 */
function syncFromCodex() {
  const creds = readCodexCredentials();
  if (!creds) {
    return { success: false, error: "No Codex CLI credentials found" };
  }

  console.log("[openai-login] Synced credentials from Codex CLI");
  writePaneCredentials(creds);
  return { success: true, accountId: creds.accountId, method: "cli-sync" };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the login flow.
 *
 * Strategy:
 *   1. Try Codex CLI sync first (reads existing credentials — no browser needed)
 *   2. If no CLI credentials, fall back to OAuth PKCE authorize flow
 */
export async function startLogin(options = {}) {
  const { onStatus } = options;

  if (_loginPromise) return { success: false, error: "Login already in progress." };

  _loginPromise = (async () => {
    try {
      // ── Strategy 1: Codex CLI Sync (recommended, no browser) ─────────
      onStatus?.("checking for Codex CLI credentials...");
      const cliResult = syncFromCodex();
      if (cliResult.success) {
        console.log("[openai-login] login via CLI sync:", cliResult.accountId);
        return { success: true, accountId: cliResult.accountId, method: "cli-sync" };
      }

      // ── Strategy 2: OAuth PKCE (fallback, opens browser) ─────────────
      onStatus?.("starting browser login...");
      const { verifier, challenge } = generatePKCE();
      const state = base64url(randomBytes(16));

      onStatus?.("starting callback server...");
      const { port, promise: codePromise } = await startCallbackServer(120_000);

      const redirectUri = `http://localhost:${port}/auth/callback`;

      const authorizeUrl = new URL(OAUTH_AUTHORIZE_URL);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", OAUTH_SCOPES);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
      authorizeUrl.searchParams.set("id_token_add_organizations", "true");

      console.log("[openai-login] authorize URL:", authorizeUrl.toString());
      onStatus?.("opening browser...");
      shell.openExternal(authorizeUrl.toString());

      onStatus?.("waiting for authorization...");
      const { code, state: returnedState } = await codePromise;

      if (returnedState !== state) {
        throw new Error("State mismatch — possible CSRF. Please try again.");
      }

      onStatus?.("exchanging code for tokens...");
      const tokens = await exchangeCodeForTokens(code, verifier, redirectUri);

      const accountId = deriveAccountId(tokens.idToken) || deriveAccountId(tokens.accessToken) || null;

      onStatus?.("saving credentials...");
      writePaneCredentials({ ...tokens, accountId });

      console.log("[openai-login] login complete:", accountId);
      return { success: true, accountId, method: "oauth" };
    } catch (err) {
      console.error("[openai-login] login failed:", err.message);
      return { success: false, error: err.message || "Login failed" };
    } finally {
      _loginPromise = null;
    }
  })();

  return _loginPromise;
}

/**
 * Returns true if Pane has stored OpenAI OAuth credentials,
 * or if Codex CLI credentials are available to sync.
 */
export function hasCredentials() {
  if (readPaneCredentials()) return true;
  if (readCodexCredentials()) return true;
  return false;
}

/**
 * Returns the current auth state for UI display.
 */
export function getAuthState() {
  const creds = readPaneCredentials();
  if (creds?.accessToken) {
    return { authenticated: true, accountId: creds.accountId || null };
  }

  const codexCreds = readCodexCredentials();
  if (codexCreds?.accessToken) {
    return { authenticated: true, accountId: codexCreds.accountId || null };
  }

  return { authenticated: false, accountId: null };
}

/**
 * Delete all Pane-stored OpenAI credentials.
 */
export function clearCredentials() {
  deletePaneCredentials();
  console.log("[openai-login] credentials cleared");
}
