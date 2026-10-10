/**
 * ipc-allowlist.mjs — the preload bridge only crosses what main registered.
 *
 * The preload previously exposed invoke/send/on for ANY channel string, so
 * a compromised renderer (XSS in a webview, malicious drop payload) could
 * reach every handler — delete_file, git_push, voice_tool_call — including
 * handlers with unvalidated args. The structural fix: the bridge checks the
 * channel against the set of channels main has actually registered, and
 * refuses everything else. No channel = no access, by construction.
 *
 * allowChannel(channel) is called by main at registration time (wrapped
 * ipcMain.handle/on in main.mjs): registering a handler whitelists it for
 * the preload bridge. The preload receives the same list at window creation
 * via additionalArguments. One source of truth — the allowlist cannot drift
 * from the handlers.
 */

/**
 * @type {Set<string>} channels main has registered via ipcMain.handle/on
 */
const allowed = new Set();

/**
 * Whitelist a channel. Called by main when it registers a handler.
 * @param {string} channel
 */
export function allowChannel(channel) {
  if (typeof channel === "string" && channel.length > 0 && channel.length <= 128) {
    allowed.add(channel);
  }
}

/**
 * Check a channel against the allowlist.
 * @param {unknown} channel
 * @returns {boolean}
 */
export function isChannelAllowed(channel) {
  return typeof channel === "string" && allowed.has(channel);
}

/**
 * Snapshot of allowed channels — serialized into the preload bridge setup.
 * @returns {string[]}
 */
export function allowedChannels() {
  return [...allowed].sort();
}

/**
 * Load the allowlist into a fresh Set (used to build the preload's
 * frozen lookup). Returns a copy — preload mutations can't poison main.
 * @param {string[]} channels
 * @returns {Set<string>}
 */
export function freezeChannelSet(channels) {
  return new Set(channels.filter((c) => typeof c === "string"));
}

/**
 * Web-URL schemes safe to hand to shell.openExternal from the renderer.
 * The window-open handler forwards target=_blank links here; http/https
 * and the app's own deep link are allowed. Everything else — file:,
 * javascript:, data:, intent:, custom app schemes — is refused:
 * openExternal is a code-execution vector on some platforms when handed
 * arbitrary schemes.
 */
const OPEN_EXTERNAL_ALLOWED_SCHEMES = new Set(["http:", "https:", "pane:"]);

/**
 * Shell-injection vectors for an opened URL, matched against the DECODED
 * form so percent-encoded payloads are caught. Control characters and
 * whitespace enable argument injection when the OS shell wrapper splits
 * the URL; quotes/backslash/backtick/angle brackets enable command and
 * HTML injection downstream. URL normalization handles everything else —
 * parsed.toString() re-encodes any non-legal byte, so a whitelist of the
 * remaining alphabet would be redundant and would reject legitimate
 * encoded-space links.
 */
const OPEN_EXTERNAL_FORBIDDEN = /[\x00-\x20\x7f"'\\`<>]/;

/**
 * Validate a URL for shell.openExternal. Returns the normalized URL string
 * when safe, null when refused. Parses strictly — a malformed URL is a
 * refusal, not a passthrough.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function validateOpenExternal(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // Single-protocol check on the parsed scheme — never on the raw string
  // (scheme confusion via whitespace/control chars bypasses string matching).
  if (!OPEN_EXTERNAL_ALLOWED_SCHEMES.has(parsed.protocol)) return null;
  // pane: deep links are non-special to WHATWG; require an opaque-ish path
  // so "pane:" alone doesn't pass as a navigable target.
  if (parsed.protocol === "pane:" && !parsed.pathname) return null;
  // No userinfo in opened URLs (user:pass@example.com — credential
  // exfiltration vector), and the decoded path/query/fragment must be free
  // of shell-injection vectors (control chars, whitespace, quotes) so
  // handler-side shell wrappers or downstream HTML consumers can't be fed
  // hostile payload sequences.
  if (parsed.username || parsed.password) return null;
  // Malformed percent-encoding (e.g. a bare %) makes decodeURIComponent
  // throw URIError — a throw here would crash the open handler instead of
  // refusing the URL, so any decode failure is a refusal.
  let decoded;
  try {
    decoded = decodeURIComponent(parsed.pathname + parsed.search + parsed.hash);
  } catch {
    return null;
  }
  if (OPEN_EXTERNAL_FORBIDDEN.test(decoded)) {
    return null;
  }
  return parsed.toString();
}
