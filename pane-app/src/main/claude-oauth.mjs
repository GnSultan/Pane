/**
 * Claude OAuth Token Provider
 *
 * Dual-source credential reading with Pane-native storage as primary:
 *   1. Pane-native: macOS Keychain ("Pane Claude-credentials") or ~/.pane/claude-credentials.json
 *   2. Claude Code: macOS Keychain ("Claude Code-credentials") or ~/.claude/.credentials.json
 *
 * Tokens are cached in memory (30s TTL) and refreshed via Anthropic's OAuth
 * endpoint. Refreshed tokens are written back to the source they came from.
 *
 * This enables direct Anthropic API calls using Claude subscription credentials —
 * no `claude` binary spawn, no separate API key needed. Pane-native credentials
 * are acquired via claude-login.mjs (built-in OAuth PKCE flow), removing the
 * dependency on Claude Code entirely.
 *
 * Architecture:
 *   1. Check Pane-native keychain → Claude Code keychain → Pane file → Claude Code file
 *   2. Cache: 30s in-memory TTL
 *   3. Refresh: POST https://claude.ai/v1/oauth/token
 *   4. Write-back: to the source the credentials came from
 */

import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// keytar: native binding for macOS Keychain — no child_process spawn, no EBADF
const _require = createRequire(import.meta.url);
const keytar = _require("keytar");

// ── Constants ──────────────────────────────────────────────────────────────

// Token refresh endpoint — platform.claude.com (matches Claude Code 2.1.206).
// Both claude.ai and platform.claude.com work for refresh, but platform.claude.com
// is the canonical endpoint Claude Code's binary uses.
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CACHE_TTL_MS = 30_000; // 30s — balances freshness vs keychain reads
const EXPIRY_BUFFER_MS = 60_000; // Refresh if token expires within 60s

// Beta flags matching Claude Code's base betas (opencode-claude-auth parity).
// `prompt-caching-2024-07-31` is intentionally NOT included — it's API-key-only.
// OAuth tokens use `prompt-caching-scope-2026-01-05` instead.
const BASE_BETA_FLAGS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
  "advisor-tool-2026-03-01",
  "thinking-token-count-2026-05-13",
  "extended-cache-ttl-2025-04-11",
  "effort-2025-11-24",
];

// Per-model beta exclusions (haiku doesn't support interleaved thinking)
const MODEL_BETA_EXCLUSIONS = {
  haiku: ["interleaved-thinking-2025-05-14"],
};

// Required headers for OAuth-authenticated requests
const OAUTH_BASE_HEADERS = {
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
};

// Stable session ID matching Claude Code's X-Claude-Code-Session-Id pattern
const SESSION_ID = randomUUID();

// ── State ──────────────────────────────────────────────────────────────────

let _cache = null; // { accessToken, expiresAt, cachedAt }
let _refreshToken = null; // Stored separately — rotates on each refresh

// ── Keychain / Credential Source ───────────────────────────────────────────
//
// Two independent sources, tried in order:
//   1. Pane-native:  Keychain "Pane Claude-credentials" or ~/.pane/claude-credentials.json
//   2. Claude Code:  Keychain "Claude Code-credentials" or ~/.claude/.credentials.json
//
// Pane-native credentials are acquired via claude-login.mjs (built-in OAuth PKCE flow)
// and don't require Claude Code to be installed. Claude Code credentials are the
// legacy fallback for users who installed Claude Code before Pane's native login existed.

const PANE_KEYCHAIN_SERVICE = "Pane Claude-credentials";

// ── Pane-native credential reading ─────────────────────────────────────

async function readPaneKeychainRaw() {
  if (process.platform !== "darwin") return null;
  try {
    return await keytar.getPassword(PANE_KEYCHAIN_SERVICE, "pane-claude-oauth");
  } catch {
    return null;
  }
}

function readPaneCredentialsFile() {
  try {
    const credPath = join(homedir(), ".pane", "claude-credentials.json");
    return readFileSync(credPath, "utf-8");
  } catch {
    return null;
  }
}

function parsePaneCredentials(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    // Pane credentials are stored flat (no claudeAiOauth wrapper)
    if (typeof data.accessToken !== "string" || !data.accessToken) return null;
    if (typeof data.expiresAt !== "number") return null;

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt,
      subscriptionType: data.account?.billingType || data.account?.subscriptionType || null,
      _source: "pane", // Track which source for write-back
    };
  } catch {
    return null;
  }
}

async function readPaneCredentials() {
  // File-first: avoids macOS keychain ACL prompts on every token read.
  // Keychain entries created by Pane don't have stable ACL trust entries,
  // so each access triggers a password prompt. File-based storage with
  // mode 0600 is secure and prompt-free.
  const raw = readPaneCredentialsFile();
  const fileCreds = parsePaneCredentials(raw);
  if (fileCreds) return fileCreds;

  // Keychain fallback (for credentials written before this change)
  if (process.platform === "darwin") {
    const kcRaw = await readPaneKeychainRaw();
    if (kcRaw) {
      const creds = parsePaneCredentials(kcRaw);
      if (creds) return creds;
    }
  }
  return null;
}

// ── Claude Code credential reading (legacy fallback) ───────────────────

async function readClaudeKeychainRaw() {
  if (process.platform !== "darwin") return null;
  try {
    // Claude Code stores credentials under the system username as the account name
    const account = userInfo().username;
    return await keytar.getPassword("Claude Code-credentials", account);
  } catch {
    return null;
  }
}

function readClaudeCredentialsFile() {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    return readFileSync(credPath, "utf-8");
  } catch {
    return null;
  }
}

function parseClaudeCredentials(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Claude Code wraps OAuth tokens in claudeAiOauth
    const data = parsed.claudeAiOauth ?? parsed;

    if (typeof data.accessToken !== "string" || !data.accessToken) return null;
    if (typeof data.expiresAt !== "number") return null;

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt,
      subscriptionType: data.subscriptionType || null,
      _source: "claude-code", // Track which source for write-back
    };
  } catch {
    return null;
  }
}

async function readClaudeCredentials() {
  // File-first: avoids macOS keychain ACL prompts.
  // Claude Code stores OAuth tokens in ~/.claude/.credentials.json as fallback
  // when keychain is unavailable. Reading file-first prevents prompts.
  const raw = readClaudeCredentialsFile();
  const fileCreds = parseClaudeCredentials(raw);
  if (fileCreds) return fileCreds;

  // Keychain fallback (for credentials that exist only in keychain)
  if (process.platform === "darwin") {
    const kcRaw = await readClaudeKeychainRaw();
    if (kcRaw) {
      const creds = parseClaudeCredentials(kcRaw);
      if (creds) return creds;
    }
  }
  return null;
}

// ── Unified credential reading ─────────────────────────────────────────

/**
 * Try Pane-native credentials first, then fall back to Claude Code.
 * Returns credentials with a `_source` field indicating origin.
 */
async function readCredentials() {
  const pane = await readPaneCredentials();
  if (pane) {
    console.log("[claude-oauth] Using Pane-native credentials");
    return pane;
  }
  const claude = await readClaudeCredentials();
  if (claude) {
    console.log("[claude-oauth] Using Claude Code credentials");
    return claude;
  }
  return null;
}

// ── Token Refresh ──────────────────────────────────────────────────────────

async function refreshViaOAuth(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ac.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`[claude-oauth] Token refresh returned HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (!data.access_token) {
      console.warn("[claude-oauth] Token refresh response missing access_token");
      return null;
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 36_000) * 1000,
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn("[claude-oauth] Direct OAuth refresh failed:", err.message);
    return null;
  }
}

// ── Write-back ─────────────────────────────────────────────────────────────

// ── Write-back (to correct source) ─────────────────────────────────────

async function writeBackPaneKeychain(creds) {
  if (process.platform !== "darwin") return false;
  try {
    await keytar.setPassword(PANE_KEYCHAIN_SERVICE, "pane-claude-oauth", JSON.stringify({
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    }));
    return true;
  } catch (err) {
    console.warn("[claude-oauth] Pane keychain write-back failed:", err.message);
    return false;
  }
}

function writeBackPaneFile(creds) {
  try {
    const dir = join(homedir(), ".pane");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const credPath = join(dir, "claude-credentials.json");

    let existing = {};
    try {
      const raw = readFileSync(credPath, "utf-8");
      existing = JSON.parse(raw);
    } catch { /* start fresh */ }

    existing.accessToken = creds.accessToken;
    existing.refreshToken = creds.refreshToken;
    existing.expiresAt = creds.expiresAt;

    writeFileSync(credPath, JSON.stringify(existing), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(credPath, 0o600);
    return true;
  } catch (err) {
    console.warn("[claude-oauth] Pane file write-back failed:", err.message);
    return false;
  }
}

async function writeBackClaudeKeychain(creds) {
  if (process.platform !== "darwin") return false;
  try {
    const account = userInfo().username;
    const raw = await keytar.getPassword("Claude Code-credentials", account);
    if (!raw) return false;

    let parsed;
    try { parsed = JSON.parse(raw); } catch { return false; }

    const wrapper = parsed.claudeAiOauth ?? parsed;
    wrapper.accessToken = creds.accessToken;
    wrapper.refreshToken = creds.refreshToken;
    wrapper.expiresAt = creds.expiresAt;

    await keytar.setPassword("Claude Code-credentials", account, JSON.stringify(parsed));
    return true;
  } catch (err) {
    console.warn("[claude-oauth] Claude Code keychain write-back failed:", err.message);
    return false;
  }
}

function writeBackClaudeFile(creds) {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    let parsed = {};
    try {
      const raw = readFileSync(credPath, "utf-8");
      parsed = JSON.parse(raw);
    } catch { /* start fresh */ }

    const wrapper = parsed.claudeAiOauth ?? parsed;
    wrapper.accessToken = creds.accessToken;
    wrapper.refreshToken = creds.refreshToken;
    wrapper.expiresAt = creds.expiresAt;

    const dir = dirname(credPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(credPath, JSON.stringify(parsed), { encoding: "utf-8", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(credPath, 0o600);
    return true;
  } catch (err) {
    console.warn("[claude-oauth] Claude Code file write-back failed:", err.message);
    return false;
  }
}

async function writeBackCredentials(creds) {
  const source = creds._source || "claude-code";

  // File-only write-back. We intentionally do NOT write to keychain.
  // Keychain items created by Pane/Electron don't have stable ACL trust entries,
  // so keytar.setPassword() triggers a macOS password prompt on every refresh.
  // The file is the primary store (mode 0600) — prompt-free and secure.
  // Keychain is kept as a read-only fallback for pre-migration installations only.
  if (source === "pane") {
    return writeBackPaneFile(creds);
  }

  return writeBackClaudeFile(creds);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if necessary.
 * Returns null if no credentials exist or refresh fails.
 *
 * @returns {Promise<string|null>} The access token, or null
 */
export async function getAccessToken() {
  const now = Date.now();

  // Cache hit — token still valid
  if (_cache && _cache.expiresAt - now > EXPIRY_BUFFER_MS) {
    const age = now - _cache.cachedAt;
    if (age < CACHE_TTL_MS) return _cache.accessToken;
    // Cache expired — re-read from source
  }

  // Read from source
  const creds = await readCredentials();
  if (!creds) {
    _cache = null;
    _refreshToken = null;
    return null;
  }

  // Token is still valid — cache and return
  if (creds.expiresAt - now > EXPIRY_BUFFER_MS) {
    _cache = {
      accessToken: creds.accessToken,
      expiresAt: creds.expiresAt,
      cachedAt: now,
    };
    _refreshToken = creds.refreshToken;
    return creds.accessToken;
  }

  // Token near expiry — try refresh
  const refreshToken = creds.refreshToken || _refreshToken;
  if (!refreshToken) {
    _cache = null;
    return null;
  }

  console.log("[claude-oauth] Token near expiry, refreshing...");
  const fresh = await refreshViaOAuth(refreshToken);
  if (!fresh) {
    _cache = null;
    _refreshToken = null;
    return null;
  }

  // Preserve source so write-back goes to the correct keychain
  fresh._source = creds._source || "claude-code";

  // Write back refreshed tokens
  writeBackCredentials(fresh);

  _cache = {
    accessToken: fresh.accessToken,
    expiresAt: fresh.expiresAt,
    cachedAt: now,
  };
  _refreshToken = fresh.refreshToken;

  console.log("[claude-oauth] Token refreshed successfully, new expiry:", new Date(fresh.expiresAt).toISOString());
  return fresh.accessToken;
}

/**
 * Compute model-specific beta flags. Excludes betas known to be incompatible
 * with certain model families (e.g. haiku doesn't support interleaved thinking).
 *
 * @param {string} [modelId] - Model ID for exclusions (e.g. "claude-sonnet-4-20250514")
 * @returns {string[]} Model-appropriate beta flags
 */
function getBetasForModel(modelId) {
  let betas = [...BASE_BETA_FLAGS];

  // Merge env beta flags
  const envBetas = process.env.ANTHROPIC_BETA_FLAGS
    ? process.env.ANTHROPIC_BETA_FLAGS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  for (const beta of envBetas) {
    if (!betas.includes(beta)) betas.push(beta);
  }

  // Apply per-model exclusions
  if (modelId) {
    const lower = modelId.toLowerCase();
    for (const [pattern, exclusions] of Object.entries(MODEL_BETA_EXCLUSIONS)) {
      if (lower.includes(pattern)) {
        betas = betas.filter((b) => !exclusions.includes(b));
        break; // First match wins
      }
    }
  }

  return betas;
}

/**
 * Get stainless SDK headers matching Claude Code's fingerprint.
 * The API may validate these for OAuth-authenticated requests.
 *
 * @returns {Record<string, string>}
 */
function getStainlessHeaders() {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  };
}

/**
 * Get the `?beta=true` URL for the Anthropic API. The API requires this
 * query parameter for OAuth-authenticated requests to the Messages endpoint.
 *
 * @param {string} baseUrl - The base API URL
 * @returns {string} URL with ?beta=true appended
 */
export function getOAuthApiUrl(baseUrl = "https://api.anthropic.com/v1/messages") {
  const url = new URL(baseUrl);
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true");
  }
  return url.toString();
}

/**
 * Get the full set of headers needed for an Anthropic API request using OAuth.
 * Includes Authorization: Bearer, model-specific beta flags, user-agent,
 * required OAuth headers, stainless SDK headers, and session tracking.
 *
 * @param {string} accessToken - The OAuth access token
 * @param {string} [modelId] - Model ID for model-specific beta exclusions
 * @returns {Record<string, string>} Headers to merge into the request
 */
export function getOAuthHeaders(accessToken, modelId) {
  const cliVersion = process.env.ANTHROPIC_CLI_VERSION || "2.1.185";
  // "sdk-cli" (not just "cli") — matches Claude Code's external SDK user-agent
  const userAgent = process.env.ANTHROPIC_USER_AGENT || `claude-cli/${cliVersion} (external, sdk-cli)`;

  const betas = getBetasForModel(modelId);

  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": betas.join(","),
    "user-agent": userAgent,
    ...OAUTH_BASE_HEADERS,
    ...getStainlessHeaders(),
    "x-client-request-id": randomUUID(),
    "X-Claude-Code-Session-Id": SESSION_ID,
  };
}

/**
 * Check whether OAuth credentials are available (without triggering refresh).
 * Checks Pane-native storage first, then Claude Code as fallback.
 * Used by getApiConfig to decide whether to use OAuth mode.
 *
 * @returns {Promise<boolean>}
 */
export async function hasOAuthCredentials() {
  // Check cache first
  if (_cache && _cache.expiresAt - Date.now() > EXPIRY_BUFFER_MS) return true;

  const paneCreds = await readPaneCredentials();
  if (paneCreds?.accessToken) return true;

  const claudeCreds = await readClaudeCredentials();
  return claudeCreds !== null && claudeCreds.accessToken !== null;
}

/**
 * Force a cache invalidation — next getAccessToken() will re-read from source.
 */
export function invalidateCache() {
  _cache = null;
  _refreshToken = null;
}
