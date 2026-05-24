// ============================================================================
// Model Paths — resolves bundled vs downloaded model cache locations.
// ============================================================================
//
// Models ship pre-bundled in the app (extraResources → Resources/models/).
// In dev mode, they live at ./models/ in the project root (download via
// `npm run download-models`). Falls back to ~/.pane/brain/models/ if neither
// bundled location exists (legacy download-at-runtime behavior).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const USER_CACHE = path.join(os.homedir(), ".pane", "brain", "models");

/**
 * Resolve the model cache directory. Checks in order:
 *   1. Bundled in app (process.resourcesPath/models/) — production
 *   2. Project-local ./models/ — development
 *   3. User cache ~/.pane/brain/models/ — fallback
 *
 * @returns {{ cacheDir: string, bundled: boolean }}
 */
export function resolveModelCache() {
  // 1. Production: bundled in app resources
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "models");
    if (fs.existsSync(bundled)) {
      return { cacheDir: bundled, bundled: true };
    }
  }

  // 2. Dev: project-local models/ directory
  //    __dirname is src/main/ in dev, so ../../models/ gets to project root
  const devLocal = path.join(import.meta.dirname || __dirname, "../../models");
  if (fs.existsSync(devLocal)) {
    return { cacheDir: path.resolve(devLocal), bundled: true };
  }

  // 3. Fallback: user cache (will trigger download on first use)
  fs.mkdirSync(USER_CACHE, { recursive: true });
  return { cacheDir: USER_CACHE, bundled: false };
}
