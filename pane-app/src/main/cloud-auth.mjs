/**
 * Pane Cloud Auth
 *
 * GitHub OAuth from Electron using the system browser.
 * Tokens stored encrypted via Electron's safeStorage (OS keychain).
 *
 * Flow:
 *   1. shell.openExternal(github authorize URL)
 *   2. GitHub redirects to pane://auth/callback?code=XXXX
 *   3. Electron catches deep link via app.on('open-url')
 *   4. Worker exchanges code for token + user_secret
 *   5. Stored encrypted in ~/.pane/auth.enc
 */

import { app, shell, safeStorage, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR  = path.join(os.homedir(), ".pane");
const AUTH_FILE = path.join(PANE_DIR, "auth.enc");

// Bundled defaults — override via ~/.pane/settings.json if needed
const DEFAULT_CLOUD_API_URL  = "https://pane-cloud.workers.dev";
const DEFAULT_GITHUB_CLIENT_ID = ""; // filled in after GitHub OAuth App is created

let CLOUD_API_URL      = DEFAULT_CLOUD_API_URL;
let GITHUB_CLIENT_ID   = DEFAULT_GITHUB_CLIENT_ID;

// In-memory state
let currentAuth = null; // { token, userSecret, user: { github_id, github_login, avatar_url } }
let pendingAuthResolve = null; // resolve fn for the OAuth flow promise
let mainWindowRef = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initCloudAuth(mainWindow) {
  mainWindowRef = mainWindow;

  // Load settings for cloud config
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(PANE_DIR, "settings.json"), "utf-8"));
    if (settings.cloud_api_url) CLOUD_API_URL = settings.cloud_api_url;
    if (settings.github_client_id) GITHUB_CLIENT_ID = settings.github_client_id;
  } catch {}

  // Register pane:// protocol for OAuth callback
  if (!app.isDefaultProtocolClient("pane")) {
    app.setAsDefaultProtocolClient("pane");
  }

  // macOS / Linux: deep link fires as an app event
  app.on("open-url", (_event, url) => {
    handleDeepLink(url);
  });

  // Windows: deep link arrives as a second-instance argv
  // The main app must call app.requestSingleInstanceLock() for this to work.
  // We hook second-instance here; if main.mjs also needs it, both listeners fire.
  app.on("second-instance", (_event, argv) => {
    // argv on Windows includes the protocol URL as the last argument
    const url = argv.find(a => a.startsWith("pane://"));
    if (url) handleDeepLink(url);
    // Also focus the main window
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore();
      mainWindowRef.focus();
    }
  });

  // Load saved auth
  loadAuth();

  // Register IPC handlers
  ipcMain.handle("cloud_login", async () => {
    return login();
  });

  ipcMain.handle("cloud_logout", async () => {
    logout();
    return { success: true };
  });

  ipcMain.handle("cloud_get_user", async () => {
    return getCloudUser();
  });
}

// ---------------------------------------------------------------------------
// Login / Logout
// ---------------------------------------------------------------------------

async function login() {
  if (!GITHUB_CLIENT_ID) {
    throw new Error("GitHub OAuth not configured — set github_client_id in settings.json");
  }

  const authUrl =
    `https://github.com/login/oauth/authorize` +
    `?client_id=${GITHUB_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent("pane://auth/callback")}` +
    `&scope=read:user`;

  // Open system browser
  shell.openExternal(authUrl);

  // Wait for the deep link callback
  return new Promise((resolve, reject) => {
    pendingAuthResolve = resolve;
    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingAuthResolve === resolve) {
        pendingAuthResolve = null;
        reject(new Error("OAuth timed out"));
      }
    }, 5 * 60 * 1000);
  });
}

function logout() {
  currentAuth = null;
  try { fs.unlinkSync(AUTH_FILE); } catch {}
  notifyRenderer();
}

// ---------------------------------------------------------------------------
// Deep link handler
// ---------------------------------------------------------------------------

async function handleDeepLink(url) {
  if (!url.startsWith("pane://auth/callback")) return;

  const parsed = new URL(url);
  const code = parsed.searchParams.get("code");
  if (!code) {
    console.error("[cloud-auth] OAuth callback missing code");
    return;
  }

  try {
    // Exchange code via Pane Cloud Worker
    const res = await fetch(`${CLOUD_API_URL}/auth/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Auth failed: ${res.status}`);
    }

    const data = await res.json();

    currentAuth = {
      token: data.access_token,
      userSecret: data.user_secret,
      user: data.user,
    };

    storeAuth();
    notifyRenderer();

    // Focus Pane window
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore();
      mainWindowRef.focus();
    }

    // Resolve the pending login() promise
    if (pendingAuthResolve) {
      pendingAuthResolve(getCloudUser());
      pendingAuthResolve = null;
    }

    console.log(`[cloud-auth] logged in as ${data.user.github_login}`);
  } catch (err) {
    console.error("[cloud-auth] OAuth exchange failed:", err.message);
    if (pendingAuthResolve) {
      pendingAuthResolve = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Token storage — encrypted at rest via OS keychain
// ---------------------------------------------------------------------------

function storeAuth() {
  if (!currentAuth) return;
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: store as plaintext (linux without keyring)
    console.warn("[cloud-auth] safeStorage not available — storing plaintext");
    fs.mkdirSync(PANE_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(currentAuth), "utf-8");
    return;
  }

  const encrypted = safeStorage.encryptString(JSON.stringify(currentAuth));
  fs.mkdirSync(PANE_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, encrypted);
}

function loadAuth() {
  try {
    const raw = fs.readFileSync(AUTH_FILE);
    if (safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(raw);
      currentAuth = JSON.parse(decrypted);
    } else {
      // Plaintext fallback
      currentAuth = JSON.parse(raw.toString("utf-8"));
    }
    console.log(`[cloud-auth] restored session for ${currentAuth?.user?.github_login || "unknown"}`);
  } catch {
    currentAuth = null;
  }
}

// ---------------------------------------------------------------------------
// Public API — used by cloud-sync.mjs and backup-engine.mjs
// ---------------------------------------------------------------------------

export function isLoggedIn() {
  return currentAuth !== null;
}

export function getCloudUser() {
  if (!currentAuth) return null;
  return {
    github_login: currentAuth.user.github_login,
    github_id: currentAuth.user.github_id,
    avatar_url: currentAuth.user.avatar_url,
    logged_in: true,
  };
}

export function getAuthToken() {
  return currentAuth?.token || null;
}

export function getUserSecret() {
  return currentAuth?.userSecret || null;
}

export function getCloudApiUrl() {
  return CLOUD_API_URL;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function notifyRenderer() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send("cloud-auth-changed", getCloudUser());
  }
}
