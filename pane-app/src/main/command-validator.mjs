/**
 * Command Validator — shared shell command safety gate.
 *
 * Single source of truth for command validation used by both:
 * - tool-executor.mjs (HTTP backend path → cmd-worker)
 * - http-backend.mjs (HTTP backend path → execSync)
 *
 * Two-layer validation:
 * 1. Blacklist: reject explicitly dangerous patterns (rm -rf /, mkfs, etc.)
 * 2. Path-boundary: when projectRoot is given, reject commands that write
 *    outside the project directory (catch-all for escapes).
 *
 * Read-only commands (ls, cat, find, grep, etc.) are never blocked by the
 * path-boundary check — they can reference any file path without risk.
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
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/, // Fork bomb
  /curl\s+.*\|\s*(?:ba)?sh\b/, // curl pipe to shell
  /wget\s+.*\|\s*(?:ba)?sh\b/, // wget pipe to shell
  /git\s+clone\s+.*\s+\/(etc|dev|proc|sys|tmp)\b/, // git clone into system paths
  // Block writes to system devices EXCEPT harmless ones
  // Allowed: /dev/null, /dev/zero, /dev/random, /dev/urandom, /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/
  />\s*\/dev\/(?!null|zero|random|urandom|stdin|stdout|stderr|fd\/)/,
  // Redirect to home root (overwrite ~/.bashrc, etc.)
  />\s*~(?:\/|$)/,
];

// Path prefixes allowed even when outside projectRoot (defense-in-depth for writes)
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

// ── Write-intent detection ──────────────────────────────────────────────
// Commands that modify the filesystem. Used to gate path-boundary checking:
// read-only commands (ls, cat, find, grep) can safely reference any path,
// only write commands need to be constrained to the project directory.

const WRITE_COMMAND_PATTERNS = [
  /\brm\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\brmdir\b/,
  /\btouch\b/, /\bdd\b/, /\bchmod\b/, /\bchown\b/, /\bchgrp\b/,
  /\bln\b/, /\btar\b/, /\bzip\b/, /\bgzip\b/, /\bbzip2\b/, /\bxz\b/,
  /\binstall\b/, /\btruncate\b/, /\bmkfs\b/, /\bmkswap\b/, /\bfallocate\b/,
  /\bsetfacl\b/, /\bsetfattr\b/,
  // tee with a non-option argument (writes to file vs just `cmd | tee`)
  /\btee\s+(?![-\|])/,
  // sed/awk in-place edit
  /\bsed\s+.*-i\b/, /\bawk\s+.*-i\b/,
];

/**
 * Check whether a command has write intent — modifies the filesystem.
 * Strips quoted strings first to avoid false positives from echo "> file", etc.
 * Also strips file descriptor redirects (2>&1, N<&M, etc.) which are read-only.
 */
export function hasWriteIntent(command) {
  // Strip quoted strings to avoid false matches inside echo/printf
  let unquoted = command.replace(/(["'])(?:(?!\1).)*\1/g, '""');
  // Strip file descriptor redirects (N>&M, N<&M, N>&-, N<&-) — these are read-only fd duplication
  unquoted = unquoted.replace(/\b\d*[<>]&[\d-]+\b/g, "");
  // Also strip <(process substitution) and >(process substitution) — not file writes
  unquoted = unquoted.replace(/[<>]\(/g, "");
  // Redirects are the primary write-intent signal
  if (/>[>]?/.test(unquoted)) return true;
  // Check write commands
  return WRITE_COMMAND_PATTERNS.some(pattern => pattern.test(unquoted));
}

/**
 * Extract write-target paths from redirect operators (>, >>, N>, N>>).
 *
 * These are the ONLY paths that a command can modify through redirects.
 * All other paths in the command are reads (arguments to ls, cat, find, etc.)
 * and should never be blocked — reading outside the project is harmless.
 *
 * For write commands (cp, mv, rm, etc.), parsing positional arguments to
 * determine which is the target is unreliable. Those commands are blocked at
 * the blacklist layer for extreme cases and allowed for project-local use.
 * The redirect-target check catches the most common false-positive pattern:
 * `find ~/Library/Logs -name "*.crash" 2>/dev/null` — the write target
 * is /dev/null (allowed), not ~/Library/Logs (read-only).
 */
function extractWriteTargets(command) {
  const targets = [];
  // Match: N>path, N> path, > path, N>>path, N>> path, >> path
  // Shell allows optional whitespace between redirect operator and path
  const redirectPattern = /(\b\d+)?>>?\s*(\S+)/g;
  let match;
  while ((match = redirectPattern.exec(command)) !== null) {
    // Skip file descriptor redirects (N>&M, N<&M) — already stripped in hasWriteIntent
    // Skip process substitutions (>())
    const target = match[2];
    if (target.startsWith("&") || target.startsWith("(")) continue;
    targets.push(target);
  }
  return targets;
}

/**
 * Check that a command with write intent doesn't escape the project directory.
 *
 * Only validates paths that are ACTUALLY written to (redirect targets like
 * > /some/path). Read-only paths (arguments to ls, cat, find, grep) are
 * never blocked — they can reference any path without risk.
 *
 * Two layers of protection:
 * 1. DANGEROUS_COMMAND_PATTERNS (blacklist) catches extreme escapes like rm -rf /
 * 2. This function catches redirect writes targeting outside projectRoot
 */
function checkPathBoundary(command, projectRoot) {
  if (!projectRoot) return { valid: true };

  // Gate: skip path-boundary for read-only commands
  if (!hasWriteIntent(command)) return { valid: true };

  const normalizedRoot = projectRoot.replace(/\/+$/, "");

  // Only extract write targets (redirect targets), not all paths
  const writeTargets = extractWriteTargets(command);
  if (writeTargets.length === 0) return { valid: true };

  for (const target of writeTargets) {
    // Skip obvious non-filesystem references
    if (target.startsWith("--") || target.startsWith("&")) continue;

    // Resolve paths
    let resolved;
    if (target.startsWith("~")) {
      resolved = target.replace(/^~/, os?.homedir?.() || "/tmp");
    } else if (target.startsWith("/")) {
      resolved = target;
    } else {
      continue; // relative path — resolves inside cwd
    }

    // Allow paths that stay within project root
    if (resolved.startsWith(normalizedRoot + "/") || resolved === normalizedRoot) continue;

    // Allow known safe external prefixes
    if (ALLOWED_EXTERNAL_PREFIXES.some(p => resolved.startsWith(p))) continue;

    return {
      valid: false,
      error: `Command redirects to path outside project directory: ${target}`,
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
