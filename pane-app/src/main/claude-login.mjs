/**
 * Pane-native Claude Login
 *
 * Primary approach: SYNC from Claude CLI credentials (recommended by opencode community).
 *   Claude CLI stores OAuth tokens in macOS Keychain or ~/.claude/.credentials.json.
 *   We read those and copy them to Pane's own store. This avoids the fragile OAuth
 *   authorize flow entirely — no browser redirect, no "invalid request format" errors.
 *
 * Fallback: OAuth 2.1 PKCE authorization code flow (if no CLI credentials exist).
 *   Opens system browser, user authorizes, browser redirects to localhost callback,
 *   we exchange the code for tokens and store them.
 *
 * The OAuth authorize flow is inherently fragile (scope encoding, endpoint changes,
 * 429s, User-Agent requirements). Every successful third-party implementation
 * (opencode-claude-auth, opencode-claude-bridge, opencode-claude-plan) recommends
 * CLI sync and avoids the authorize flow entirely.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { shell } from "electron";

// keytar: native binding for macOS Keychain — no child_process spawn.
// execFileSync("/usr/bin/security") fails silently inside Electron's main process
// (EBADF / permission issues), causing readCliCredentials() to return null even
// when valid credentials exist. keytar uses native APIs directly and works.
const _require = typeof require !== "undefined"
  ? require
  : await import("node:module").then((m) => m.default.createRequire(import.meta.url));
const keytar = _require("keytar");

// ── Constants ──────────────────────────────────────────────────────────────

// OAuth endpoints matching Claude Code 2.1.206.
// Subscription login (loginWithClaudeAi=true) uses CLAUDE_AI_AUTHORIZE_URL, NOT
// CONSOLE_AUTHORIZE_URL. The Console endpoint (platform.claude.com) only supports
// Console scopes (org:create_api_key, user:profile) and rejects user:inference with
// "Invalid request format" after clicking Authorize. The Claude.ai endpoint handles
// all 6 scopes. The browser follows the 307 from claude.com/cai/ → claude.ai/ automatically.
const OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Exact scopes from Claude Code CLI 2.1.206 source.
// ALL_OAUTH_SCOPES (WJo) = dedup of CONSOLE_OAUTH_SCOPES + CLAUDE_AI_OAUTH_SCOPES.
// CONSOLE_OAUTH_SCOPES = [org:create_api_key, user:profile]
// CLAUDE_AI_OAUTH_SCOPES = [user:profile, user:inference, user:sessions:claude_code, user:mcp_servers, user:file_upload]
const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

const PANE_KEYCHAIN_SERVICE = "Pane Claude-credentials";
const PANE_KEYCHAIN_ACCOUNT = "pane-claude-oauth";

// ── State ──────────────────────────────────────────────────────────────────

let _loginPromise = null;

// ── PKCE ──────────────────────────────────────────────────────────────────

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ── Callback Server ────────────────────────────────────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>Pane — Signed In</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f17;color:#e0e0e0;}
.card{text-align:center;padding:40px;}h1{color:#10b981;margin:0 0 12px;}p{opacity:.7;margin:0;}</style>
</head><body><div class="card"><h1>✓ Signed in</h1><p>You can close this tab and return to Pane.</p></div></body></html>`;

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
  // Claude Code sends JSON (not form-encoded) to the token endpoint
  const body = {
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    state: undefined,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);

  let res;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    expiresAt: Date.now() + (data.expires_in ?? 36_000) * 1000,
  };
}

// ── Profile ────────────────────────────────────────────────────────────────

async function fetchProfile(accessToken) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  try {
    const res = await fetch(OAUTH_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
      },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Keychain / File Storage ────────────────────────────────────────────────

async function writePaneCredentials(creds) {
  const payload = JSON.stringify({
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken || null,
    expiresAt: creds.expiresAt,
    account: creds.account || null,
  });

  // File-first: always write to file (prompt-free, secure with 0600).
  // This is the primary credential store — keychain is secondary/best-effort.
  let fileWritten = false;
  try {
    const dir = join(homedir(), ".pane");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const credPath = join(dir, "claude-credentials.json");
    writeFileSync(credPath, payload, { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(credPath, 0o600);
    console.log("[claude-login] credentials written to file");
    fileWritten = true;
  } catch (err) {
    console.warn("[claude-login] file write failed:", err.message);
  }

  // Keychain write is best-effort — don't let ACL failures block login.
  // Only attempt if file write succeeded (so we don't prompt user for keychain
  // password when the primary store already has the credentials).
  if (fileWritten && process.platform === "darwin") {
    try {
      await keytar.setPassword(PANE_KEYCHAIN_SERVICE, PANE_KEYCHAIN_ACCOUNT, payload);
      console.log("[claude-login] credentials also written to Keychain (best-effort)");
    } catch (err) {
      // Non-fatal — file is the primary store
      console.warn("[claude-login] Keychain write skipped (non-fatal):", err.message);
    }
  }
}

async function readPaneCredentials() {
  // File-first: avoids macOS keychain ACL prompts on every login status check.
  try {
    const credPath = join(homedir(), ".pane", "claude-credentials.json");
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (typeof data.accessToken === "string" && data.accessToken) return data;
  } catch {}

  // Keychain fallback
  if (process.platform === "darwin") {
    try {
      const raw = await keytar.getPassword(PANE_KEYCHAIN_SERVICE, PANE_KEYCHAIN_ACCOUNT);
      if (raw) {
        const data = JSON.parse(raw);
        if (typeof data.accessToken === "string" && data.accessToken) return data;
      }
    } catch (err) {
      console.warn("[claude-login] Keychain read warning:", err.message);
    }
  }

  return null;
}

async function deletePaneCredentials() {
  if (process.platform === "darwin") {
    try {
      await keytar.deletePassword(PANE_KEYCHAIN_SERVICE, PANE_KEYCHAIN_ACCOUNT);
    } catch {}
  }

  try {
    const credPath = join(homedir(), ".pane", "claude-credentials.json");
    if (existsSync(credPath)) unlinkSync(credPath);
  } catch {}
}

// ── CLI Credential Sync ────────────────────────────────────────────────────

/**
 * Read Claude CLI's stored OAuth credentials from macOS Keychain or credentials file.
 * This is the recommended login approach — avoids the fragile OAuth authorize flow.
 *
 * @returns {{ accessToken: string, refreshToken: string|null, expiresAt: number, account: object|null } | null}
 */
async function readCliCredentials() {
  // macOS Keychain: Claude Code stores under "Claude Code-credentials" service
  if (process.platform === "darwin") {
    try {
      const account = userInfo().username;
      const raw = await keytar.getPassword("Claude Code-credentials", account);
      if (raw) {
        const parsed = JSON.parse(raw);
        const oauth = parsed.claudeAiOauth ?? parsed;
        if (typeof oauth.accessToken === "string" && oauth.accessToken) {
          return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || null,
            expiresAt: oauth.expiresAt || 0,
            account: {
              subscriptionType: oauth.subscriptionType || null,
              rateLimitTier: oauth.rateLimitTier || null,
            },
          };
        }
      }
    } catch (err) {
      console.warn("[claude-login] Keychain read warning:", err.message);
    }
  }

  // Credentials file fallback: ~/.claude/.credentials.json
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw);
    const oauth = parsed.claudeAiOauth ?? parsed;
    if (typeof oauth.accessToken === "string" && oauth.accessToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken || null,
        expiresAt: oauth.expiresAt || 0,
        account: {
          subscriptionType: oauth.subscriptionType || null,
          rateLimitTier: oauth.rateLimitTier || null,
        },
      };
    }
  } catch {}

  return null;
}

/**
 * Copy Claude CLI credentials to Pane's own store.
 * Returns the account info if successful.
 *
 * @returns {{ success: boolean, account?: object|null, error?: string, method?: string }}
 */
async function syncFromCli() {
  const creds = await readCliCredentials();
  if (!creds) {
    return { success: false, error: "No Claude CLI credentials found" };
  }

  console.log("[claude-login] Synced credentials from Claude CLI keychain");
  await writePaneCredentials(creds);
  return { success: true, account: creds.account, method: "cli-sync" };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Start the login flow.
 *
 * Strategy:
 *   1. Try CLI sync first (reads existing Claude CLI credentials — no browser needed)
 *   2. If no CLI credentials, fall back to OAuth PKCE authorize flow
 *
 * @param {{ onStatus?: (msg: string) => void }} [options]
 * @returns {Promise<{ success: boolean, account?: object|null, error?: string, method?: string }>}
 */
export async function startLogin(options = {}) {
  const { onStatus } = options;

  if (_loginPromise) return { success: false, error: "Login already in progress." };

  _loginPromise = (async () => {
    try {
      // ── Strategy 1: CLI Sync (recommended, no browser) ───────────────
      onStatus?.("checking for Claude CLI credentials...");
      const cliResult = await syncFromCli();
      if (cliResult.success) {
        console.log("[claude-login] login via CLI sync:", cliResult.account);
        return { success: true, account: cliResult.account, method: "cli-sync" };
      }

      // ── Strategy 2: OAuth PKCE (fallback, opens browser) ─────────────
      onStatus?.("starting browser login...");
      const { verifier, challenge } = generatePKCE();
      const state = base64url(randomBytes(16));

      onStatus?.("starting callback server...");
      const { port, promise: codePromise } = await startCallbackServer(120_000);

      const redirectUri = `http://localhost:${port}/callback`;

      // Build authorize URL matching Claude Code 2.1.206 exactly.
      // code=true IS required — it was removed as a workaround for CLI 2.1.83 regression
      // but is present and required in 2.1.206. Without it, "Authorization failed - Invalid
      // request format" appears after clicking Authorize on the consent page.
      const authorizeUrl = new URL(OAUTH_AUTHORIZE_URL);
      authorizeUrl.searchParams.append("code", "true");
      authorizeUrl.searchParams.append("client_id", OAUTH_CLIENT_ID);
      authorizeUrl.searchParams.append("response_type", "code");
      authorizeUrl.searchParams.append("redirect_uri", redirectUri);
      authorizeUrl.searchParams.append("scope", OAUTH_SCOPES.join(" "));
      authorizeUrl.searchParams.append("code_challenge", challenge);
      authorizeUrl.searchParams.append("code_challenge_method", "S256");
      authorizeUrl.searchParams.append("state", state);

      console.log("[claude-login] authorize URL:", authorizeUrl.toString());
      onStatus?.("opening browser...");
      shell.openExternal(authorizeUrl.toString());

      onStatus?.("waiting for authorization...");
      const { code, state: returnedState } = await codePromise;

      if (returnedState !== state) {
        throw new Error("State mismatch — possible CSRF. Please try again.");
      }

      onStatus?.("exchanging code for tokens...");
      const tokens = await exchangeCodeForTokens(code, verifier, redirectUri);

      onStatus?.("fetching account info...");
      const profile = await fetchProfile(tokens.accessToken);

      const account = profile
        ? {
            email: profile.email || profile.emailAddress || null,
            displayName: profile.displayName || profile.name || null,
            organizationName: profile.organizationName || null,
            billingType: profile.billingType || profile.subscriptionType || null,
            hasExtraUsageEnabled:
              profile.hasExtraUsageEnabled === true || profile.hasExtraUsageEnabled === "True",
          }
        : null;

      onStatus?.("saving credentials...");
      await writePaneCredentials({ ...tokens, account });

      console.log("[claude-login] login complete:", account?.email || "(no email)");
      return { success: true, account, method: "oauth" };
    } catch (err) {
      console.error("[claude-login] login failed:", err.message);
      return { success: false, error: err.message || "Login failed" };
    } finally {
      _loginPromise = null;
    }
  })();

  return _loginPromise;
}

/**
 * Returns true if Pane has stored Claude subscription credentials,
 * or if Claude CLI credentials are available to sync.
 */
export async function hasPaneCredentials() {
  if (await readPaneCredentials()) return true;
  if (await readCliCredentials()) return true;
  return false;
}

/**
 * Returns the current auth state for UI display.
 * Checks Pane-native store first, then CLI credentials.
 */
export async function getAuthState() {
  const creds = await readPaneCredentials();
  if (creds) {
    const valid = creds.expiresAt > Date.now() + 60_000 || !!creds.refreshToken;
    return { authenticated: valid, account: creds.account || null };
  }

  // Also check CLI credentials (Pane can use them directly via claude-oauth.mjs)
  const cliCreds = await readCliCredentials();
  if (cliCreds) {
    const valid = cliCreds.expiresAt > Date.now() + 60_000 || !!cliCreds.refreshToken;
    return { authenticated: valid, account: cliCreds.account || null };
  }

  return { authenticated: false, account: null };
}

/**
 * Delete all Pane-stored Claude credentials.
 */
export async function clearCredentials() {
  await deletePaneCredentials();
  console.log("[claude-login] credentials cleared");
}
