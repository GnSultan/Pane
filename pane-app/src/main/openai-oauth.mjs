/**
 * OpenAI OAuth Token Provider
 *
 * Mirrors claude-oauth.mjs — dual-source credential reading:
 *   1. Pane-native: ~/.pane/openai-credentials.json
 *   2. Codex CLI:   ~/.codex/auth.json
 *
 * Tokens are cached in memory (30s TTL) and refreshed via OpenAI's OAuth
 * endpoint. Refreshed tokens are written back to the source they came from.
 *
 * This enables API calls using ChatGPT subscription credentials through the
 * Codex backend at chatgpt.com/backend-api/codex — no separate API key needed.
 *
 * Architecture:
 *   1. Check Pane file → Codex CLI file
 *   2. Cache: 30s in-memory TTL
 *   3. Refresh: POST https://auth.openai.com/oauth/token (JSON body)
 *   4. Write-back: to the source the credentials came from
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CACHE_TTL_MS = 30_000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh if token expires within 5 min
const REFRESH_INTERVAL_MS = 55 * 60 * 1000; // Refresh if last refresh was >55 min ago

// ── State ──────────────────────────────────────────────────────────────────

let _cache = null; // { accessToken, accountId, expiresAt, cachedAt }
let _refreshToken = null;

// ── JWT Parsing ────────────────────────────────────────────────────────────

function parseJwtClaims(token) {
  if (!token || !token.includes(".")) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

function deriveAccountId(token) {
  const claims = parseJwtClaims(token);
  if (!claims) return null;

  const authClaim = claims["https://api.openai.com/auth"];
  if (authClaim && typeof authClaim.chatgpt_account_id === "string") {
    return authClaim.chatgpt_account_id;
  }
  if (typeof claims.chatgpt_account_id === "string") {
    return claims.chatgpt_account_id;
  }
  if (Array.isArray(claims.organizations) && claims.organizations[0]?.id) {
    return claims.organizations[0].id;
  }
  return null;
}

function getTokenExpiry(token) {
  const claims = parseJwtClaims(token);
  if (claims && typeof claims.exp === "number") {
    return claims.exp * 1000; // seconds → ms
  }
  return 0;
}

// ── Pane-native credential reading ─────────────────────────────────────

function readPaneCredentials() {
  try {
    const credPath = join(homedir(), ".pane", "openai-credentials.json");
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (typeof data.accessToken !== "string" || !data.accessToken) return null;

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || null,
      idToken: data.idToken || null,
      accountId: data.accountId || deriveAccountId(data.idToken) || deriveAccountId(data.accessToken) || null,
      expiresAt: data.expiresAt || getTokenExpiry(data.accessToken),
      lastRefresh: data.lastRefresh || null,
      _source: "pane",
    };
  } catch {
    return null; // File doesn't exist or is unreadable — not an error
  }
}

// ── Codex CLI credential reading ───────────────────────────────────────

function readCodexCredentials() {
  const candidates = [];
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) candidates.push(join(codexHome, "auth.json"));
  candidates.push(join(homedir(), ".codex", "auth.json"));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8"));
      const tokens = parsed.tokens;
      if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) continue;

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        idToken: tokens.id_token || null,
        accountId: tokens.account_id || deriveAccountId(tokens.id_token) || deriveAccountId(tokens.access_token) || null,
        expiresAt: getTokenExpiry(tokens.access_token),
        lastRefresh: parsed.last_refresh || null,
        _source: "codex",
        _sourcePath: candidate,
      };
    } catch {
      continue; // File doesn't exist or is unreadable — try next candidate
    }
  }

  return null;
}

// ── Unified credential reading ─────────────────────────────────────────

function readCredentials() {
  const pane = readPaneCredentials();
  if (pane) {
    console.log("[openai-oauth] Using Pane-native credentials");
    return pane;
  }
  const codex = readCodexCredentials();
  if (codex) {
    console.log("[openai-oauth] Using Codex CLI credentials");
    return codex;
  }
  return null;
}

// ── Token Refresh ──────────────────────────────────────────────────────────

function shouldRefresh(creds) {
  const now = Date.now();

  // If token has an expiry, check against buffer
  if (creds.expiresAt > 0 && creds.expiresAt <= now + EXPIRY_BUFFER_MS) {
    return true;
  }

  // If last refresh was too long ago
  if (creds.lastRefresh) {
    const refreshedAt = new Date(creds.lastRefresh).getTime();
    if (!isNaN(refreshedAt) && refreshedAt <= now - REFRESH_INTERVAL_MS) {
      return true;
    }
  }

  // No expiry info and no last refresh — be safe, refresh
  if (!creds.expiresAt && !creds.lastRefresh) {
    return true;
  }

  return false;
}

async function refreshViaOAuth(refreshToken) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: ac.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[openai-oauth] Token refresh returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    if (!data.access_token) {
      console.warn("[openai-oauth] Token refresh response missing access_token");
      return null;
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      idToken: data.id_token || null,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      accountId: deriveAccountId(data.id_token) || deriveAccountId(data.access_token) || null,
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn("[openai-oauth] Token refresh failed:", err.message);
    return null;
  }
}

// ── Write-back ─────────────────────────────────────────────────────────────

function writeBackPaneFile(creds) {
  try {
    const dir = join(homedir(), ".pane");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const credPath = join(dir, "openai-credentials.json");

    let existing = {};
    try {
      existing = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch { /* start fresh */ }

    existing.accessToken = creds.accessToken;
    existing.refreshToken = creds.refreshToken;
    existing.idToken = creds.idToken;
    existing.expiresAt = creds.expiresAt;
    existing.accountId = creds.accountId;
    existing.lastRefresh = new Date().toISOString();

    writeFileSync(credPath, JSON.stringify(existing), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(credPath, 0o600);
    return true;
  } catch (err) {
    console.warn("[openai-oauth] Pane file write-back failed:", err.message);
    return false;
  }
}

function writeBackCodexFile(creds, sourcePath) {
  try {
    const credPath = sourcePath || join(homedir(), ".codex", "auth.json");
    let parsed = {};
    try {
      parsed = JSON.parse(readFileSync(credPath, "utf-8"));
    } catch { /* start fresh */ }

    if (!parsed.tokens) parsed.tokens = {};
    parsed.tokens.access_token = creds.accessToken;
    parsed.tokens.refresh_token = creds.refreshToken;
    parsed.tokens.id_token = creds.idToken;
    parsed.tokens.account_id = creds.accountId;
    parsed.last_refresh = new Date().toISOString();

    writeFileSync(credPath, JSON.stringify(parsed, null, 2), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(credPath, 0o600);
    return true;
  } catch (err) {
    console.warn("[openai-oauth] Codex file write-back failed:", err.message);
    return false;
  }
}

function writeBackCredentials(creds) {
  if (creds._source === "pane") {
    return writeBackPaneFile(creds);
  }
  return writeBackCodexFile(creds, creds._sourcePath);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if necessary.
 * Returns null if no credentials exist or refresh fails.
 */
export async function getAccessToken() {
  const now = Date.now();

  // Cache hit — token still valid
  if (_cache && _cache.expiresAt - now > EXPIRY_BUFFER_MS) {
    const age = now - _cache.cachedAt;
    if (age < CACHE_TTL_MS) return _cache.accessToken;
  }

  // Read from source
  const creds = readCredentials();
  if (!creds) {
    _cache = null;
    _refreshToken = null;
    return null;
  }

  // Check if refresh is needed
  if (!shouldRefresh(creds)) {
    _cache = {
      accessToken: creds.accessToken,
      accountId: creds.accountId,
      expiresAt: creds.expiresAt || now + 3600_000,
      cachedAt: now,
    };
    _refreshToken = creds.refreshToken;
    return creds.accessToken;
  }

  // Token needs refresh
  const refreshToken = creds.refreshToken || _refreshToken;
  if (!refreshToken) {
    // No refresh token — return existing access token and hope it works
    _cache = {
      accessToken: creds.accessToken,
      accountId: creds.accountId,
      expiresAt: creds.expiresAt || now + 3600_000,
      cachedAt: now,
    };
    return creds.accessToken;
  }

  console.log("[openai-oauth] Token needs refresh, refreshing...");
  const fresh = await refreshViaOAuth(refreshToken);
  if (!fresh) {
    // Refresh failed — return existing token as fallback
    _cache = {
      accessToken: creds.accessToken,
      accountId: creds.accountId,
      expiresAt: creds.expiresAt || now + 3600_000,
      cachedAt: now,
    };
    _refreshToken = creds.refreshToken;
    return creds.accessToken;
  }

  // Preserve source for write-back
  fresh._source = creds._source;
  fresh._sourcePath = creds._sourcePath;

  // Write back refreshed tokens
  writeBackCredentials(fresh);

  _cache = {
    accessToken: fresh.accessToken,
    accountId: fresh.accountId,
    expiresAt: fresh.expiresAt,
    cachedAt: now,
  };
  _refreshToken = fresh.refreshToken;

  console.log("[openai-oauth] Token refreshed, new expiry:", new Date(fresh.expiresAt).toISOString());
  return fresh.accessToken;
}

/**
 * Get the account ID from cached credentials.
 */
export function getAccountId() {
  if (_cache?.accountId) return _cache.accountId;
  const creds = readCredentials();
  return creds?.accountId || null;
}

/**
 * Get the base URL for the Codex API.
 */
export function getCodexBaseUrl() {
  return CODEX_BASE_URL;
}

/**
 * Build headers for a Codex API request.
 */
export function getOAuthHeaders(accessToken, accountId) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "openai-sentinel-chat-requirements-token": "", // Some endpoints require this but empty works
  };
}

/**
 * Check whether OpenAI OAuth credentials are available (without triggering refresh).
 */
export function hasOAuthCredentials() {
  if (_cache && _cache.expiresAt - Date.now() > EXPIRY_BUFFER_MS) return true;

  const paneCreds = readPaneCredentials();
  if (paneCreds?.accessToken) return true;

  const codexCreds = readCodexCredentials();
  return codexCreds !== null && !!codexCreds.accessToken;
}

/**
 * Force a cache invalidation — next getAccessToken() will re-read from source.
 */
export function invalidateCache() {
  _cache = null;
  _refreshToken = null;
}
