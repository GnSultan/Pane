/**
 * Skill Registry — discover, load, validate, and compose agent skills.
 *
 * Skills are composable capability packages that specialize an agent for a
 * specific domain. A skill is a directory containing at minimum a SKILL.md
 * file with YAML frontmatter and an optional compose.json for compatibility
 * declarations.
 *
 * ## Skill package structure
 *
 *   skill-name/
 *   ├── SKILL.md          # Required: instructions + YAML frontmatter
 *   ├── compose.json      # Optional: compatibility declarations
 *   ├── playbook.md       # Optional: domain principles (merged into playbook)
 *   ├── tools.json        # Optional: MCP tool definitions
 *   ├── model-prefs.json  # Optional: model routing preferences
 *   ├── knowledge/        # Optional: reference docs loaded on demand
 *   └── verification/     # Optional: post-change verification scripts
 *
 * ## Discovery order (first wins on name conflict)
 *
 *   1. Project-local:  <project-root>/.pane/skills/
 *   2. User-global:    ~/.pane/skills/
 *   3. Pane built-in:  <Resources>/skills/ (packaged) or <pane-app>/skills/ (dev)
 *                      — see resolveBuiltinSkillsDir()
 *
 * ## Composition model
 *
 * Skills declare relationships via compose.json:
 *   - extends:    skills this one inherits from (principles are merged)
 *   - conflicts:  skills that cannot be active simultaneously
 *   - requires:   skills that must be active for this one to work
 *   - provides:   capability tags for dependency resolution
 *
 * ## Feedback loop
 *
 * Skills are not static. Pane's playbook engine observes skill usage and
 * refines domain-specific principles over time. The model profiler tracks
 * which models perform best with which skills. Skills get better the
 * more they're used — this is the Pane differentiator.
 *
 * @module skill-registry
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PANE_DIR = path.join(os.homedir(), ".pane");
const DEFAULT_GLOBAL_SKILLS_DIR = path.join(PANE_DIR, "skills");

// Resolve pane-app root: <pane-app>/src/main/skill-registry.mjs → <pane-app>
const PANE_APP_ROOT = path.resolve(__dirname, "..", "..");
const DEV_BUILTIN_SKILLS_DIR = path.join(PANE_APP_ROOT, "skills");

/**
 * Resolve the built-in skills directory.
 *
 * Packaged app: electron-builder ships skills/ via extraResources →
 *   <app>/Contents/Resources/skills — this is where it lives in the dmg
 *   (app.asar does not contain <root>/skills; the dev path does not exist
 *   there, and the builtin layer silently vanished in production before
 *   this check existed).
 * Development: <pane-app>/skills.
 *
 * Same pattern as model-paths.mjs resolveModelCache().
 *
 * @returns {string}
 */
export function resolveBuiltinSkillsDir() {
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "skills");
    try {
      if (fs.existsSync(bundled)) return bundled;
    } catch { /* unreadable — fall through to dev path */ }
  }
  return DEV_BUILTIN_SKILLS_DIR;
}

// Mutable so tests can redirect installs away from the real ~/.pane/skills.
let GLOBAL_SKILLS_DIR = DEFAULT_GLOBAL_SKILLS_DIR;

// ── Hard limits (adversarial-package defense) ───────────────────────────────
// Skills are installable from arbitrary GitHub repos by the agent. Nothing
// downstream assumes good faith: file sizes are capped at the boundaries
// where untrusted bytes enter (discovery scan, body load, resource read),
// and the in-memory caches are bounded so long sessions can't grow without
// limit.
const MAX_SKILL_MD_BYTES = 2 * 1024 * 1024;   // 2 MiB — SKILL.md is prose
const MAX_RESOURCE_BYTES = 256 * 1024;        // companion file → model context
const MAX_BODY_CACHE_ENTRIES = 64;

// Known skill subdirectories within a skill package
const SKILL_FILES = {
  instructions: "SKILL.md",
  compose: "compose.json",
  playbook: "playbook.md",
  tools: "tools.json",
  modelPrefs: "model-prefs.json",
  knowledge: "knowledge",
  verification: "verification",
};

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

// Map<cacheKey, SkillMetadata[]> keyed by projectRoot ("" for global-only) —
// populated by discoverAll(). A single shared cache would serve project A's
// scan results to project B (wrong paths, missed project-local skills) within
// the TTL, so each root gets its own entry.
const _discoveredCache = new Map();
const DISCOVERY_TTL_MS = 30_000; // re-scan every 30s max

// Map<projectId, Set<skillName>> — active skills per project
const _activeSkills = new Map();

// Notifier fired whenever a project's active-skill set changes (activate,
// deactivate, hydrate). Registered by main.mjs to push updates to the
// renderer; skill-registry itself stays electron-free.
let _onActiveSkillsChanged = null;
export function setOnActiveSkillsChanged(fn) {
  _onActiveSkillsChanged = fn;
}
function _notifyActiveSkillsChanged(projectId) {
  if (_onActiveSkillsChanged) {
    try {
      _onActiveSkillsChanged(projectId);
    } catch {
      // Notifier errors must never break skill activation
    }
    }
}

// Map<cacheKey, { body: SkillBody, mtimeMs: number }> — loaded skill bodies.
// Freshness is checked against the SKILL.md mtime on every read: reinstalling a
// skill (pane_install_skill, manual copy, external edit) changes the file, and a
// stale body must never be served for an activation. Discovery-cache
// invalidation alone does not reach this cache — the mtime check makes the two
// caches independently correct. Bounded at MAX_BODY_CACHE_ENTRIES (oldest
// insertion evicted) so a long session across many projects can't grow it
// without limit.
const _bodyCache = new Map();

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SkillMetadata
 * @property {string} name        - Unique skill identifier
 * @property {string} description - When to use this skill (for discovery listing)
 * @property {string} version     - Semver version
 * @property {string[]} tags      - Search/discovery tags
 * @property {string} path        - Absolute path to skill directory
 * @property {'global'|'project'|'builtin'} source - Where the skill was found
 * @property {string} [projectRoot] - Project root if source is 'project'
 */

/**
 * @typedef {object} SkillResource
 * @property {string} path - Relative path within the skill package (e.g. "references/voice.md")
 * @property {string} absolutePath - Absolute path on disk
 * @property {number} bytes - File size
 */

/**
 * @typedef {object} SkillBody
 * @property {string} instructions - SKILL.md body without frontmatter
 * @property {object|null} compose - Parsed compose.json or null
 * @property {string|null} playbook - playbook.md content or null
 * @property {object|null} tools - Parsed tools.json or null
 * @property {object|null} modelPrefs - Parsed model-prefs.json or null
 * @property {string} skillPath - Absolute path to the skill directory (for
 *   resolving relative companion resources like references/*.md)
 * @property {SkillResource[]} resources - Companion files (knowledge/, references/)
 */

/**
 * @typedef {object} ComposeDecl
 * @property {string} name
 * @property {string} version
 * @property {string[]} [extends]
 * @property {string[]} [conflicts]
 * @property {string[]} [requires]
 * @property {string[]} [provides]
 * @property {string[]} [tags]
 * @property {number} [priority]
 */

// ---------------------------------------------------------------------------
// YAML frontmatter parser (zero-dependency, handles the subset skills use)
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a SKILL.md string.
 * Returns { frontmatter: object, body: string }.
 * Throws if no valid frontmatter is found.
 */
function parseFrontmatter(content) {
  // Strip a UTF-8 BOM — editors emit it, and it would otherwise break the
  // opening `---` match and reject the whole SKILL.md.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match?.[1]) {
    throw new Error("No YAML frontmatter found in SKILL.md");
  }
  const raw = match[1].trim();
  const body = text.slice(match[0].length).trim();

  // Minimal YAML parser — handles the simple key: value and key: [array] subset
  const frontmatter = {};
  const lines = raw.split("\n");
  let currentKey = null;
  let currentArray = null;

  for (const line of lines) {
    // Array item (continuation of previous key)
    if (currentArray !== null && /^\s*-\s+(.+)/.test(line)) {
      currentArray.push(line.match(/^\s*-\s+(.+)/)[1].trim());
      continue;
    }

    // Key: value or key: [inline array]
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/);
    if (kvMatch) {
      currentArray = null;
      const key = kvMatch[1];
      let value = kvMatch[2].trim();

      // Inline array: [item1, item2]
      if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        frontmatter[key] = inner
          ? inner.split(",").map((s) => s.trim().replace(/^['"](.*)['"]$/, "$1"))
          : [];
        currentArray = frontmatter[key];
      } else {
        // Strip quotes
        frontmatter[key] = value.replace(/^['"](.*)['"]$/, "$1");
      }
    }
    // else: empty line or continuation line — skip
  }

  return { frontmatter, body };
}

/**
 * Validate a skill name used as a path component (install rename, remove,
 * global directory name). Refuses traversal (".."), absolute-looking names,
 * separators, hidden names, shell metacharacters, and overlong strings.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function validateSkillName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !name.endsWith(".") // blocks ".." and "foo.." edge cases explicitly
  );
}

// Charset for owner/repo/path components of a github: skill source. Same
// class as validateSkillName minus the leading-alpha requirement (repo
// folders like "01-skill" are legal). Shell metacharacters, whitespace,
// separators, and traversal segments are all excluded by construction —
// whatever passes here is safe to interpolate into a command line even
// though the clone runs argv-mode (no shell) anyway.
const GITHUB_COMPONENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse and validate a model-supplied skill source (pane_install_skill).
 * Returns a discriminated result; every component that reaches a path or a
 * child process is charset-validated here, at the boundary, before use.
 *
 *   github:owner/repo/path/to/skill  →  { kind: "github", owner, repo, skillPath }
 *   /local/dir or relative/dir       →  { kind: "local", localPath }
 *   anything else                    →  { error }
 *
 * @param {string} raw
 * @returns {{ kind?: "github"|"local", owner?: string, repo?: string, skillPath?: string, localPath?: string, error?: string }}
 */
export function parseSkillSource(raw) {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) return { error: "Skill source is empty. Use github:owner/repo/path/to/skill or a local directory path." };

  if (url.startsWith("github:")) {
    const parts = url.slice("github:".length).split("/");
    if (parts.length < 3 || parts.some((p) => !p)) {
      return { error: "GitHub path must be: github:owner/repo/path/to/skill" };
    }
    const [owner, repo, ...rest] = parts;
    if (!GITHUB_COMPONENT_RE.test(owner)) {
      return { error: `Invalid GitHub owner "${owner}" — allowed: letters, digits, ".", "_", "-" (no shell syntax, no traversal).` };
    }
    if (!GITHUB_COMPONENT_RE.test(repo)) {
      return { error: `Invalid GitHub repo "${repo}" — allowed: letters, digits, ".", "_", "-" (no shell syntax, no traversal).` };
    }
    for (const seg of rest) {
      if (seg === "." || seg === ".." || !GITHUB_COMPONENT_RE.test(seg)) {
        return { error: `Invalid path segment "${seg}" in skill path — no traversal (".."), no shell syntax, no separators.` };
      }
    }
    return { kind: "github", owner, repo, skillPath: rest.join("/") };
  }

  // Local path — must not be a URL scheme we don't support
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    return { error: `Unsupported skill source "${url}". Use github:owner/repo/path/to/skill or a local directory path.` };
  }
  return { kind: "local", localPath: url };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a SKILL.md's frontmatter. Returns array of error strings (empty = valid).
 */
function validateFrontmatter(fm) {
  const errors = [];
  if (!fm.name || typeof fm.name !== "string") {
    errors.push("Missing or invalid 'name' in frontmatter");
  }
  if (!fm.description || typeof fm.description !== "string") {
    errors.push("Missing or invalid 'description' in frontmatter");
  }
  return errors;
}

/**
 * Validate compose.json. Returns array of error strings (empty = valid).
 */
function validateCompose(compose) {
  const errors = [];
  if (!compose || typeof compose !== "object") return ["compose.json is not a valid object"];
  if (!compose.name || typeof compose.name !== "string") {
    errors.push("compose.json missing 'name'");
  }
  for (const field of ["extends", "conflicts", "requires", "provides", "tags"]) {
    if (compose[field] !== undefined && !Array.isArray(compose[field])) {
      errors.push(`compose.json '${field}' must be an array`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan a single directory for skill subdirectories containing SKILL.md.
 *
 * @param {string} dir - Directory to scan
 * @param {'global'|'project'|'builtin'} source - Skill source label
 * @param {string} [projectRoot] - Project root for project-local skills
 * @returns {SkillMetadata[]}
 */
function scanDirectory(dir, source, projectRoot = null) {
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills; // Directory doesn't exist — not an error
  }

  // Deterministic order regardless of filesystem readdir behavior.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(dir, entry.name);
    const skillFile = path.join(skillDir, SKILL_FILES.instructions);

    try {
      // Size guard BEFORE the read: an adversarial package must not be able
      // to force a multi-gigabyte read through discovery.
      let size = 0;
      try {
        size = fs.statSync(skillFile).size;
      } catch (statErr) {
        if (statErr.code === "ENOENT") continue; // no SKILL.md — skip silently
        throw statErr;
      }
      if (size > MAX_SKILL_MD_BYTES) {
        console.warn(
          `[skills] Skipping ${skillDir}: SKILL.md is ${size} bytes (limit ${MAX_SKILL_MD_BYTES})`,
        );
        continue;
      }

      const content = fs.readFileSync(skillFile, "utf-8");
      const { frontmatter } = parseFrontmatter(content);
      const errors = validateFrontmatter(frontmatter);
      if (errors.length > 0) {
        console.warn(`[skills] Skipping ${skillDir}: ${errors.join(", ")}`);
        continue;
      }

      skills.push({
        name: frontmatter.name,
        description: frontmatter.description,
        version: frontmatter.version || "0.0.0",
        tags: frontmatter.tags || [],
        path: skillDir,
        source,
        ...(projectRoot ? { projectRoot } : {}),
      });
    } catch (err) {
      // Invalid frontmatter etc. — skip with a warning (ENOENT handled above)
      console.warn(`[skills] Error reading ${skillFile}: ${err.message}`);
    }
  }

  return skills;
}

/**
 * Discover all available skills across all sources.
 * Results are cached for DISCOVERY_TTL_MS to avoid repeated disk scans.
 *
 * Discovery order (first wins on name conflict):
 *   1. Project-local (projectRoot)
 *   2. User-global (~/.pane/skills/)
 *   3. Pane built-in (<pane-app>/skills/)
 *
 * @param {string} [projectRoot] - Optional project root for project-local skills
 * @returns {SkillMetadata[]}
 */
export function discoverAll(projectRoot = null) {
  const cacheKey = projectRoot || "";
  const cached = _discoveredCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.skills;
  }

  const seen = new Map(); // name → SkillMetadata
  const allSkills = [];

  // Layer 1: Project-local (highest priority — first in wins)
  if (projectRoot) {
    const projectSkillsDir = path.join(projectRoot, ".pane", "skills");
    const projectSkills = scanDirectory(projectSkillsDir, "project", projectRoot);
    for (const skill of projectSkills) {
      seen.set(skill.name, skill);
      allSkills.push(skill);
    }
  }

  // Layer 2: User-global
  const globalSkills = scanDirectory(GLOBAL_SKILLS_DIR, "global");
  for (const skill of globalSkills) {
    if (!seen.has(skill.name)) {
      seen.set(skill.name, skill);
      allSkills.push(skill);
    }
  }

  // Layer 3: Pane built-in (lowest priority) — resolves to the packaged
  // resources dir in production, <pane-app>/skills in development.
  const builtinSkills = scanDirectory(resolveBuiltinSkillsDir(), "builtin");
  for (const skill of builtinSkills) {
    if (!seen.has(skill.name)) {
      seen.set(skill.name, skill);
      allSkills.push(skill);
    }
  }

  _discoveredCache.set(cacheKey, { at: Date.now(), skills: allSkills });
  return allSkills;
}

/**
 * Find a skill by name (case-insensitive). Returns SkillMetadata or null.
 */
export function findSkill(name, projectRoot = null) {
  const skills = discoverAll(projectRoot);
  const lower = name.toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === lower) || null;
}

/**
 * Invalidate the discovery cache (e.g., after installing/removing a skill).
 */
export function invalidateDiscoveryCache() {
  _discoveredCache.clear();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// Companion-resource directories that may be routed from SKILL.md with
// relative paths ("Read references/voice.md"). These are routing instructions,
// not imports — the agent resolves them against the skill root.
const RESOURCE_DIRS = ["knowledge", "references"];

/**
 * Recursively list companion resource files under a skill directory.
 * Only files are listed; hidden files are skipped. Returns relative paths
 * (POSIX-style, relative to the skill root) so they match how SKILL.md
 * routes them.
 *
 * @param {string} skillDir
 * @returns {SkillResource[]}
 */
function collectResources(skillDir) {
  /** @type {SkillResource[]} */
  const out = [];
  for (const dirName of RESOURCE_DIRS) {
    const root = path.join(skillDir, dirName);
    const walk = (relDir, absDir) => {
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return; // unreadable or absent — skip
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(absDir, e.name);
        const rel = `${relDir}/${e.name}`;
        if (e.isDirectory()) walk(rel, abs);
        else if (e.isFile()) {
          try {
            out.push({ path: rel, absolutePath: abs, bytes: fs.statSync(abs).size });
          } catch { /* file vanished mid-walk — skip */ }
        }
      }
    };
    walk(dirName, root);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read a companion resource file from a skill package, resolved against the
 * skill root. Two containment checks, both required:
 *
 *   1. Lexical — the resolved path string must sit under the skill root.
 *   2. Realpath — the file's real location (symlinks resolved) must also sit
 *      under the skill root's real location. Without this, a skill shipped by
 *      an untrusted repo can bundle `references/creds -> ~/.ssh/id_rsa` and
 *      route "Read references/creds": the path string is contained, the read
 *      is not.
 *
 * Oversized files are truncated with a visible marker rather than refused —
 * a big reference file is usually legitimate, and the agent stays functional
 * either way.
 *
 * @param {string} skillName
 * @param {string} relativePath - e.g. "references/voice.md"
 * @param {string} [projectRoot]
 * @returns {{ success: boolean, error?: string, content?: string, absolutePath?: string, truncated?: boolean }}
 */
export function readSkillResource(skillName, relativePath, projectRoot = null) {
  const meta = findSkill(skillName, projectRoot);
  if (!meta) {
    return { success: false, error: `Skill "${skillName}" not found.` };
  }

  // 1. Lexical containment
  const abs = path.resolve(meta.path, relativePath);
  if (!abs.startsWith(meta.path + path.sep)) {
    return { success: false, error: `Refusing to read outside skill directory: ${relativePath}` };
  }

  // 2. Realpath containment — symlinks resolved on both sides
  try {
    const realSkillRoot = fs.realpathSync(meta.path);
    const realTarget = fs.realpathSync(abs);
    if (!realTarget.startsWith(realSkillRoot + path.sep)) {
      return {
        success: false,
        error: `Refusing to read outside skill directory: "${relativePath}" resolves (symlink) outside the skill root.`,
      };
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        success: false,
        error: `Resource "${relativePath}" could not be read from skill "${skillName}" (ENOENT). Check pane_skill_info for the skill's resource list — the file may be missing from this install.`,
      };
    }
    return {
      success: false,
      error: `Resource "${relativePath}" could not be read from skill "${skillName}" (${err.code || err.message}). Check pane_skill_info for the skill's resource list.`,
    };
  }

  try {
    let content = fs.readFileSync(abs, "utf-8");
    let truncated = false;
    if (Buffer.byteLength(content, "utf-8") > MAX_RESOURCE_BYTES) {
      content = Buffer.from(content, "utf-8").subarray(0, MAX_RESOURCE_BYTES).toString("utf-8");
      content += `\n\n[...resource truncated at ${MAX_RESOURCE_BYTES} bytes — read the file directly with a file-read tool if you need the rest]`;
      truncated = true;
    }
    return { success: true, content, absolutePath: abs, truncated };
  } catch (err) {
    return {
      success: false,
      error: `Resource "${relativePath}" could not be read from skill "${skillName}" (${err.code || err.message}). Check pane_skill_info for the skill's resource list — the file may be missing from this install.`,
    };
  }
}

/**
 * Load the full body of a skill by name.
 * Cached in memory, with freshness checked against the SKILL.md mtime so a
 * reinstall or in-place edit is always picked up.
 *
 * @param {string} name - Skill name
 * @param {string} [projectRoot] - Project root for project-local resolution
 * @returns {SkillBody|null}
 */
export function loadSkill(name, projectRoot = null) {
  const cacheKey = projectRoot ? `${projectRoot}::${name}` : name;

  const meta = findSkill(name, projectRoot);
  if (!meta) {
    // Skill removed: drop any stale cache entry so a later reinstall starts clean.
    _bodyCache.delete(cacheKey);
    return null;
  }

  // Cache is only trusted while the SKILL.md on disk is unchanged — a
  // reinstall (pane_install_skill, manual copy) or in-place edit bumps the
  // mtime and forces a reload from disk.
  const skillFile = path.join(meta.path, SKILL_FILES.instructions);
  let mtimeMs = 0;
  try {
    const st = fs.statSync(skillFile);
    if (st.size > MAX_SKILL_MD_BYTES) {
      console.warn(
        `[skills] Refusing to load ${name}: SKILL.md is ${st.size} bytes (limit ${MAX_SKILL_MD_BYTES})`,
      );
      return null;
    }
    mtimeMs = st.mtimeMs;
  } catch {
    // stat failed — fall through; the read below surfaces the real error
  }

  const cached = _bodyCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.body;
  }
  _bodyCache.delete(cacheKey);

  const body = { skillPath: meta.path };

  // Load SKILL.md body
  try {
    const content = fs.readFileSync(skillFile, "utf-8");
    const { body: instructions } = parseFrontmatter(content);
    body.instructions = instructions;
  } catch (err) {
    console.warn(`[skills] Failed to read SKILL.md for ${name}: ${err.message}`);
    return null;
  }

  // Companion resources (knowledge/, references/)
  body.resources = collectResources(meta.path);

  // Load compose.json
  try {
    const composeRaw = fs.readFileSync(
      path.join(meta.path, SKILL_FILES.compose),
      "utf-8",
    );
    body.compose = JSON.parse(composeRaw);
  } catch {
    body.compose = null;
  }

  // Load playbook.md
  try {
    body.playbook = fs.readFileSync(
      path.join(meta.path, SKILL_FILES.playbook),
      "utf-8",
    ).trim();
  } catch {
    body.playbook = null;
  }

  // Load tools.json
  try {
    body.tools = JSON.parse(
      fs.readFileSync(path.join(meta.path, SKILL_FILES.tools), "utf-8"),
    );
  } catch {
    body.tools = null;
  }

  // Load model-prefs.json
  try {
    body.modelPrefs = JSON.parse(
      fs.readFileSync(path.join(meta.path, SKILL_FILES.modelPrefs), "utf-8"),
    );
  } catch {
    body.modelPrefs = null;
  }

  // Bound the cache — oldest insertion evicted first (Map preserves order).
  if (_bodyCache.size >= MAX_BODY_CACHE_ENTRIES) {
    const oldest = _bodyCache.keys().next().value;
    _bodyCache.delete(oldest);
  }
  _bodyCache.set(cacheKey, { body, mtimeMs });
  return body;
}

// ---------------------------------------------------------------------------
// Composition validation
// ---------------------------------------------------------------------------

/**
 * Validate that a set of skill names are compatible.
 * Checks conflicts and requirements across all active skills.
 *
 * @param {string[]} skillNames - Names of skills to check
 * @param {string} [projectRoot]
 * @returns {{ valid: boolean, conflicts: string[], missingRequirements: string[] }}
 */
export function validateComposition(skillNames, projectRoot = null) {
  const conflicts = [];
  const missingRequirements = [];
  const loaded = [];

  for (const name of skillNames) {
    const body = loadSkill(name, projectRoot);
    if (!body) continue;
    loaded.push({ name, compose: body.compose || {} });
  }

  // Check conflicts: for each skill, check if any other active skill is in its conflicts list
  const activeNames = new Set(skillNames.map((n) => n.toLowerCase()));
  for (const { name, compose } of loaded) {
    for (const conflict of compose.conflicts || []) {
      if (activeNames.has(conflict.toLowerCase())) {
        conflicts.push(`${name} conflicts with ${conflict}`);
      }
    }
  }

  // Check requirements: for each skill, check all requires are active
  const provided = new Set();
  for (const { compose } of loaded) {
    for (const p of compose.provides || []) {
      provided.add(p.toLowerCase());
    }
  }
  for (const { name, compose } of loaded) {
    for (const req of compose.requires || []) {
      const reqLower = req.toLowerCase();
      if (!activeNames.has(reqLower) && !provided.has(reqLower)) {
        missingRequirements.push(`${name} requires ${req} (not active)`);
      }
    }
  }

  return {
    valid: conflicts.length === 0 && missingRequirements.length === 0,
    conflicts,
    missingRequirements,
  };
}

// ---------------------------------------------------------------------------
// Active skills per project
// ---------------------------------------------------------------------------

/**
 * Get the set of active skill names for a project.
 * @param {string} projectId
 * @returns {Set<string>}
 */
export function getActiveSkills(projectId) {
  return _activeSkills.get(projectId) || new Set();
}

/**
 * Hydrate active skills from persistent state (state.json) into the
 * in-memory registry. Called on cold start by context-orchestrator.
 * Idempotent — repeated calls with the same names are a no-op.
 *
 * @param {string} projectId
 * @param {string[]} skillNames
 */
export function hydrateActiveSkills(projectId, skillNames) {
  if (!skillNames || skillNames.length === 0) return;
  const existing = _activeSkills.get(projectId);
  // If already populated (e.g., model already activated skills this session),
  // don't overwrite — the in-memory state is more current than disk.
  if (existing && existing.size > 0) return;

  const set = new Set(skillNames.map((n) => n.toLowerCase()));
  _activeSkills.set(projectId, set);
  _notifyActiveSkillsChanged(projectId);
}

/**
 * Activate a skill for a project.
 * Compose conflicts are enforced (documented in compose.json and surfaced by
 * pane_skill_info: "skills that cannot be active simultaneously") — the
 * activation is refused and nothing is added to the active set. Missing
 * requirements do NOT block activation; they come back as `warnings` so the
 * caller can surface them (a partial stack is often intentional).
 *
 * @param {string} projectId
 * @param {string} skillName
 * @param {string} [projectRoot] - Project root for project-local skill resolution
 * @returns {{ success: boolean, error?: string, warnings?: string[], body?: SkillBody }}
 */
export function activateSkill(projectId, skillName, projectRoot = null) {
  const body = loadSkill(skillName, projectRoot);
  if (!body) {
    return { success: false, error: `Skill "${skillName}" not found. Use pane_list_skills to see available skills.` };
  }

  // Enforce compose conflicts against the currently active set (this skill
  // included). validateComposition loads bodies again, but they're cached.
  const existing = _activeSkills.get(projectId) || new Set();
  const candidate = new Set([...existing, skillName.toLowerCase()]);
  const composition = validateComposition([...candidate], projectRoot);
  if (composition.conflicts.length > 0) {
    return {
      success: false,
      error: `Cannot activate "${skillName}": ${composition.conflicts.join("; ")}. Deactivate the conflicting skill first (deactivate_skill).`,
    };
  }

  if (!existing.size) _activeSkills.set(projectId, existing);
  existing.add(skillName.toLowerCase());
  _notifyActiveSkillsChanged(projectId);

  return {
    success: true,
    body,
    warnings: composition.missingRequirements,
  };
}

/**
 * Deactivate a skill for a project.
 * @param {string} projectId
 * @param {string} skillName
 */
export function deactivateSkill(projectId, skillName) {
  const skills = _activeSkills.get(projectId);
  if (skills) {
    const before = skills.size;
    skills.delete(skillName.toLowerCase());
    if (skills.size !== before) _notifyActiveSkillsChanged(projectId);
  }
}

/**
 * Deactivate all skills for a project.
 * @param {string} projectId
 */
export function clearActiveSkills(projectId) {
  _activeSkills.delete(projectId);
}

/**
 * Get the full compiled context for all active skills in a project.
 * Returns null if no skills are active.
 *
 * @param {string} projectId
 * @param {string} [projectRoot]
 * @returns {string|null} Compiled skill context for system prompt injection
 */
export function getActiveSkillContext(projectId, projectRoot = null) {
  const activeNames = getActiveSkills(projectId);
  if (activeNames.size === 0) return null;

  const sections = [];

  for (const name of activeNames) {
    const body = loadSkill(name, projectRoot);
    if (!body?.instructions) continue;

    // Inject at reasonable length — skill instructions can be large but
    // we trust the skill author. Cap at 3000 chars per skill defensively.
    const instructions = body.instructions.length > 3000
      ? body.instructions.slice(0, 3000) + "\n\n[...skill truncated for context — use pane_skill_info for full content]"
      : body.instructions;

    let block = `## Active Skill: ${name}\n\n${instructions}`;

    // Include domain principles (playbook) if present — capped like instructions
    // above. Uncapped, a few active skills with sizeable playbooks compound every
    // turn (skills don't auto-deactivate) and can push the system prompt well
    // past what the guardrail's flat overhead assumption expects.
    if (body.playbook) {
      const playbook = body.playbook.length > 3000
        ? body.playbook.slice(0, 3000) + "\n\n[...playbook truncated for context — use pane_skill_info for full content]"
        : body.playbook;
      block += `\n\n### Domain Principles for ${name}\n\n${playbook}`;
    }

    sections.push(block);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Get merged playbook from all active skills. Used by the playbook engine
 * to inject domain principles during reflection. Returns null if no active
 * skills have playbooks.
 *
 * @param {string} projectId
 * @param {string} [projectRoot]
 * @returns {string|null}
 */
export function getActiveSkillPlaybooks(projectId, projectRoot = null) {
  const activeNames = getActiveSkills(projectId);
  if (activeNames.size === 0) return null;

  const playbooks = [];
  for (const name of activeNames) {
    const body = loadSkill(name, projectRoot);
    if (body?.playbook) {
      playbooks.push(`## Skill: ${name}\n\n${body.playbook}`);
    }
  }

  return playbooks.length > 0 ? playbooks.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// Listing (for the model's skill discovery prompt)
// ---------------------------------------------------------------------------

/**
 * Build a compact listing of all discovered skills for injection into the
 * system prompt. The model sees names + descriptions only — full instructions
 * stay out of context until a skill is activated.
 *
 * @param {string} [projectRoot]
 * @returns {string|null}
 */
export function buildSkillListing(projectRoot = null) {
  const skills = discoverAll(projectRoot);
  if (skills.length === 0) return null;

  const lines = skills.map((s) => {
    const tagStr = s.tags.length > 0 ? ` [${s.tags.slice(0, 3).join(", ")}]` : "";
    return `- **${s.name}**${tagStr}: ${s.description}`;
  });

  return (
    "## Available Skills\n\n" +
    "Use `activate_skill` to load a skill when the task would benefit from " +
    "specialized instructions. Skills are composable capability packages — " +
    "they give you domain expertise on demand.\n\n" +
    lines.join("\n") +
    "\n\nUse `pane_list_skills` to see more details about a specific skill."
  );
}

// ---------------------------------------------------------------------------
// Installation helpers (for CLI)
// ---------------------------------------------------------------------------

/**
 * Create the global skills directory if it doesn't exist.
 */
export function ensureGlobalSkillsDir() {
  fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
}

/**
 * Install a skill from a source directory into the global skills directory.
 * Simple copy — no git/npm resolution yet.
 *
 * Trust boundary: `renameTo` and the frontmatter name both become path
 * components under ~/.pane/skills and are validated with validateSkillName
 * (no traversal, no separators, no shell syntax). compose.json, when present,
 * must parse. Oversized SKILL.md is refused.
 *
 * @param {string} sourceDir - Source skill directory (must contain SKILL.md)
 * @param {string} [renameTo] - Optional rename of the skill directory
 * @returns {{ success: boolean, error?: string, name?: string }}
 */
export function installSkill(sourceDir, renameTo = null) {
  // Verify source has SKILL.md
  const sourceSkillFile = path.join(sourceDir, SKILL_FILES.instructions);
  try {
    // Names become path components under the global skills dir — validate
    // before any join, and refuse anything that could escape it.
    if (renameTo !== null && !validateSkillName(renameTo)) {
      return { success: false, error: `Invalid skill name "${renameTo}" — use letters, digits, ".", "_", "-"; no traversal, separators, or shell syntax.` };
    }

    let size = 0;
    try {
      size = fs.statSync(sourceSkillFile).size;
    } catch (statErr) {
      return { success: false, error: `Failed to install skill: source has no readable SKILL.md (${statErr.code || statErr.message})` };
    }
    if (size > MAX_SKILL_MD_BYTES) {
      return { success: false, error: `Failed to install skill: SKILL.md is too large (${size} bytes, limit ${MAX_SKILL_MD_BYTES}).` };
    }

    const content = fs.readFileSync(sourceSkillFile, "utf-8");
    const { frontmatter } = parseFrontmatter(content);
    const errors = validateFrontmatter(frontmatter);
    if (errors.length > 0) {
      return { success: false, error: `Invalid SKILL.md: ${errors.join(", ")}` };
    }
    if (!validateSkillName(frontmatter.name)) {
      return { success: false, error: `Invalid skill name "${frontmatter.name}" in SKILL.md frontmatter — use letters, digits, ".", "_", "-" (no traversal, separators, or shell syntax).` };
    }

    // compose.json is optional, but a present-but-unparseable one is a broken
    // package: refuse at the boundary instead of silently degrading to null.
    const composePath = path.join(sourceDir, SKILL_FILES.compose);
    try {
      fs.accessSync(composePath);
      const compose = JSON.parse(fs.readFileSync(composePath, "utf-8"));
      const composeErrors = validateCompose(compose);
      if (composeErrors.length > 0) {
        return { success: false, error: `Invalid compose.json: ${composeErrors.join(", ")}` };
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        return { success: false, error: `Invalid compose.json: ${err.message}` };
      }
    }

    const skillName = renameTo || frontmatter.name;
    const destDir = path.join(GLOBAL_SKILLS_DIR, skillName);

    // Recursive copy
    fs.cpSync(sourceDir, destDir, { recursive: true });

    // Invalidate cache — both the discovery (metadata) cache and any cached
    // body for this skill (global form and every project-scoped form; a
    // project-local skill of the same name is untouched and keeps its entry).
    invalidateDiscoveryCache();
    _bodyCache.delete(skillName);
    for (const key of [..._bodyCache.keys()]) {
      if (key.endsWith(`::${skillName}`)) _bodyCache.delete(key);
    }

    return { success: true, name: skillName };
  } catch (err) {
    return { success: false, error: `Failed to install skill: ${err.message}` };
  }
}

/**
 * Remove a skill from the global skills directory. Never touches
 * project-local or built-in skills. The name is validated (validateSkillName)
 * and the resolved destination re-checked for containment — this function
 * recursively deletes, so it must never be able to point outside the global
 * skills dir.
 *
 * @param {string} skillName
 * @returns {{ success: boolean, error?: string }}
 */
export function removeSkill(skillName) {
  if (!validateSkillName(skillName)) {
    return { success: false, error: `Invalid skill name "${skillName}" — refusing to remove.` };
  }
  const skillDir = path.join(GLOBAL_SKILLS_DIR, skillName);
  if (!skillDir.startsWith(GLOBAL_SKILLS_DIR + path.sep)) {
    return { success: false, error: `Refusing to remove a directory outside the global skills dir: ${skillName}` };
  }
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    invalidateDiscoveryCache();
    // Clear cached bodies under every key form this skill may have been
    // loaded with (bare name, and "<projectRoot>::<name>" project-scoped).
    _bodyCache.delete(skillName);
    for (const key of [..._bodyCache.keys()]) {
      if (key.endsWith(`::${skillName}`)) _bodyCache.delete(key);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: `Failed to remove skill: ${err.message}` };
  }
}

/**
 * List all installed skills with their metadata.
 * @param {string} [projectRoot]
 * @returns {SkillMetadata[]}
 */
export function listInstalledSkills(projectRoot = null) {
  return discoverAll(projectRoot);
}

// ---------------------------------------------------------------------------
// Export for testing
// ---------------------------------------------------------------------------

export const __test = {
  parseFrontmatter,
  validateFrontmatter,
  validateCompose,
  validateSkillName,
  parseSkillSource,
  scanDirectory,
  resolveBuiltinSkillsDir,
  bodyCacheSize: () => _bodyCache.size,
  MAX_SKILL_MD_BYTES,
  MAX_RESOURCE_BYTES,
  MAX_BODY_CACHE_ENTRIES,
  get GLOBAL_SKILLS_DIR() { return GLOBAL_SKILLS_DIR; },
  setGlobalSkillsDir(dir) {
    GLOBAL_SKILLS_DIR = dir;
    invalidateDiscoveryCache();
    _bodyCache.clear();
  },
  BUILTIN_SKILLS_DIR: DEV_BUILTIN_SKILLS_DIR,
};
