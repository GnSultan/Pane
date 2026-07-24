/**
 * path-guard.mjs — IPC filesystem path validation
 *
 * Defense-in-depth layer for Electron IPC handlers that accept file paths or
 * project IDs from the renderer process. If the renderer is compromised (XSS
 * via markdown rendering, malicious dependency), these validators prevent
 * arbitrary filesystem read/write outside allowed directories.
 *
 * Allowed directories:
 *   - All registered project roots (from settings.json)
 *   - ~/.pane/ (app data: memory, session, checkpoints)
 */

import { readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";

const PANE_DIR = join(homedir(), ".pane");

/**
 * Read all known project roots from settings.
 * Combines project_roots array and project_states map values.
 * @returns {string[]} array of absolute path strings
 */
function getProjectRoots() {
  try {
    const raw = readFileSync(join(PANE_DIR, "settings.json"), "utf-8");
    const settings = JSON.parse(raw);
    const roots = new Set();

    if (Array.isArray(settings.project_roots)) {
      for (const r of settings.project_roots) {
        if (typeof r === "string" && r.trim()) roots.add(resolve(r));
      }
    }
    if (settings.project_states && typeof settings.project_states === "object") {
      for (const state of Object.values(settings.project_states)) {
        if (state && typeof state.root === "string" && state.root.trim()) {
          roots.add(resolve(state.root));
        }
      }
    }
    return [...roots];
  } catch {
    return [];
  }
}

/**
 * Check if a resolved path is within any of the allowed parent directories.
 * Uses path.relative() to correctly handle `..` segments after resolution.
 * @param {string} targetPath - already resolved to absolute
 * @param {string[]} parentPaths - allowed parent directories (resolved)
 * @returns {boolean}
 */
function isWithin(targetPath, parentPaths) {
  for (const parent of parentPaths) {
    const rel = relative(resolve(parent), targetPath);
    // If the relative path doesn't start with '..' and isn't an absolute path
    // (which would mean different drive on Windows), the target is within parent.
    if (!rel.startsWith("..") && !isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * Validate that a file path is within a known project root or ~/.pane/.
 * @param {string} targetPath - the path to validate (absolute or relative)
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateFilePath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, error: "Path is required." };
  }
  if (targetPath.includes("\0")) {
    return { ok: false, error: "Path contains null bytes." };
  }

  const resolved = resolve(targetPath);
  const roots = getProjectRoots();
  const allowed = [...roots, PANE_DIR];

  if (isWithin(resolved, allowed)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Path "${resolved}" is outside of allowed directories (project roots and ~/.pane/).`,
  };
}

/**
 * Validate a path for directory creation. Unlike validateFilePath, this allows
 * any path within the user's home directory since new project folders may be
 * created outside existing roots. Still blocks path traversal and null bytes.
 * @param {string} targetPath
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateDirectoryPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, error: "Directory path is required." };
  }
  if (targetPath.includes("\0")) {
    return { ok: false, error: "Path contains null bytes." };
  }

  const resolved = resolve(targetPath);
  const homeResolved = resolve(homedir());
  const rel = relative(homeResolved, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Directory "${resolved}" is outside of user home directory.`,
    };
  }
  return { ok: true };
}

/**
 * Validate a projectId for use in filesystem paths.
 * Rejects path traversal characters (.., /, \) and null bytes.
 * @param {string} projectId
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateProjectId(projectId) {
  if (!projectId || typeof projectId !== "string") {
    return { ok: false, error: "Project ID is required." };
  }
  if (projectId.includes("\0")) {
    return { ok: false, error: "Project ID contains null bytes." };
  }
  if (
    projectId.includes("..") ||
    projectId.includes("/") ||
    projectId.includes("\\")
  ) {
    return { ok: false, error: `Invalid project ID: "${projectId.slice(0, 50)}".` };
  }
  return { ok: true };
}
