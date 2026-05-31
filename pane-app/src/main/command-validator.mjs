/**
 * Command Validator — shared shell command safety gate.
 *
 * Single source of truth for command validation used by both:
 * - tool-executor.mjs (HTTP backend path → cmd-worker)
 * - pane-mcp-server.mjs (MCP stdio server path → execSync)
 *
 * Two-layer validation:
 * 1. Blacklist: reject explicitly dangerous patterns (rm -rf /, mkfs, etc.)
 * 2. Path-boundary: when projectRoot is given, reject commands that write
 *    or execute outside the project directory (catch-all for escapes).
 */

import path from "node:path";
import os from "node:os";

// ── Dangerous command patterns (blacklist) ────────────────────────────────
const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+.*-rf?\s+\//, // Root deletion
  /rm\s+.*-rf?\s+\*/, // Catch-all deletion
  /rm\s+.*\.\.\//,    // Relative deletion
  /rm\s+.*-rf?\s+~(?:\/|$)/, // Home directory deletion
  /mkfs/,             // Disk formatting
  /dd\s+if=.*(of=\/dev\/(sd|xvd|vd|nvme|loop|nbd))/, // Raw disk writing to block devices
  /passwd/,           // Password changing
  /shutdown|reboot/,  // System control
  /chmod\s+.*777/,    // Dangerous permissions
  /chmod\s+.*777\s+~(?:\/|$)/, // Home directory permissions
  /:\(\)\s*\{\s*:\|:&\s*;\s*\};?\s*:/, // Fork bomb
  /curl\s+.*\|\s*(?:ba)?sh\b/, // curl pipe to shell
  /wget\s+.*\|\s*(?:ba)?sh\b/, // wget pipe to shell
  /git\s+clone\s+.*\s+\/(etc|dev|proc|sys|tmp)\b/, // git clone into system paths
  // Block writes to system devices EXCEPT harmless ones
  // Allowed: /dev/null, /dev/zero, /dev/random, /dev/urandom, /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/
  />\s*\/dev\/(?!null|zero|random|urandom|stdin|stdout|stderr|fd\/)/,
  // Redirect to home root (overwrite ~/.bashrc, etc.)
  />\s*~(?:\/|$)/,
];

// Path prefixes allowed even when outside projectRoot
const ALLOWED_EXTERNAL_PREFIXES = [
  "/tmp/",
  "/var/tmp/",
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
];

/**
 * Check that a command doesn't escape the project directory.
 * This is a heuristic — catches the most common escape vectors.
 *
 * Looks for absolute paths and `..` traversals that resolve outside projectRoot.
 * Only triggers on write/execution operations (rm, mv, cp, dd, cat >, etc.)
 * or path arguments to commands that access the filesystem.
 */
function checkPathBoundary(command, projectRoot) {
  if (!projectRoot) return { valid: true };

  const normalizedRoot = projectRoot.replace(/\/+$/, "");

  // Extract paths that look like absolute paths or contain ..
  // Matches: /absolute/path, "~/path", ../relative
  const pathRefs = command.match(/(?:\s+|^)(["']?)((?:\/[^\s"'$`;|&()]+|\.\.[^\s"'$`;|&()]*|~[^\s"'$`;|&()]*))\1/g);

  if (!pathRefs) return { valid: true };

  for (const ref of pathRefs) {
    const pathStr = ref.replace(/^["']/, "").replace(/["']$/, "").trim();
    if (!pathStr) continue;

    // Skip obvious non-filesystem references
    if (pathStr.startsWith("--")) continue;

    // Resolve relative paths
    let resolved;
    if (pathStr.startsWith("~")) {
      resolved = pathStr.replace(/^~/, os?.homedir?.() || "/tmp");
    } else if (pathStr.startsWith("/")) {
      resolved = pathStr;
    } else if (pathStr.startsWith("..")) {
      resolved = path.resolve(normalizedRoot, pathStr);
    } else {
      continue; // relative path without .. — resolves inside cwd
    }

    // Allow paths that stay within project root
    if (resolved.startsWith(normalizedRoot + "/") || resolved === normalizedRoot) continue;

    // Allow known safe external prefixes
    if (ALLOWED_EXTERNAL_PREFIXES.some(p => resolved.startsWith(p))) continue;

    return {
      valid: false,
      error: `Command targets path outside project directory: ${pathStr}`,
    };
  }

  return { valid: true };
}

/**
 * Validate a shell command for safety.
 *
 * @param {string} command - The command string to validate
 * @param {string} [projectRoot] - Optional project root for path-boundary enforcement
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateCommand(command, projectRoot) {
  const trimmed = command.trim();
  if (!trimmed) return { valid: false, error: "Empty command" };

  // Layer 1: Blacklist — reject explicitly dangerous patterns
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        error: `Command contains dangerous pattern: ${pattern}`,
      };
    }
  }

  // Layer 2: Path-boundary — reject escapes from project directory
  if (projectRoot) {
    const boundary = checkPathBoundary(trimmed, projectRoot);
    if (!boundary.valid) return boundary;
  }

  return { valid: true };
}
