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
 *   3. Pane built-in:  <pane-app>/skills/
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
const GLOBAL_SKILLS_DIR = path.join(PANE_DIR, "skills");

// Resolve pane-app root: <pane-app>/src/main/skill-registry.mjs → <pane-app>
const PANE_APP_ROOT = path.resolve(__dirname, "..", "..");
const BUILTIN_SKILLS_DIR = path.join(PANE_APP_ROOT, "skills");

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

// Map<skillName, SkillMetadata> — populated by discoverAll()
let _discoveredCache = null;
let _discoveredAt = 0;
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

// Map<skillName, SkillBody> — loaded skill bodies (LRU-ish, small enough to keep)
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
 * @typedef {object} SkillBody
 * @property {string} instructions - SKILL.md body without frontmatter
 * @property {object|null} compose - Parsed compose.json or null
 * @property {string|null} playbook - playbook.md content or null
 * @property {object|null} tools - Parsed tools.json or null
 * @property {object|null} modelPrefs - Parsed model-prefs.json or null
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
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match?.[1]) {
    throw new Error("No YAML frontmatter found in SKILL.md");
  }
  const raw = match[1].trim();
  const body = content.slice(match[0].length).trim();

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

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(dir, entry.name);
    const skillFile = path.join(skillDir, SKILL_FILES.instructions);

    try {
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
      // No SKILL.md or invalid — skip silently unless it's a parse error
      if (err.code !== "ENOENT") {
        console.warn(`[skills] Error reading ${skillFile}: ${err.message}`);
      }
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
  // Use cache if fresh
  if (_discoveredCache && Date.now() - _discoveredAt < DISCOVERY_TTL_MS) {
    return _discoveredCache;
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

  // Layer 3: Pane built-in (lowest priority)
  const builtinSkills = scanDirectory(BUILTIN_SKILLS_DIR, "builtin");
  for (const skill of builtinSkills) {
    if (!seen.has(skill.name)) {
      seen.set(skill.name, skill);
      allSkills.push(skill);
    }
  }

  _discoveredCache = allSkills;
  _discoveredAt = Date.now();
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
  _discoveredCache = null;
  _discoveredAt = 0;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the full body of a skill by name.
 * Cached in memory after first load.
 *
 * @param {string} name - Skill name
 * @param {string} [projectRoot] - Project root for project-local resolution
 * @returns {SkillBody|null}
 */
export function loadSkill(name, projectRoot = null) {
  // Check cache
  const cacheKey = projectRoot ? `${projectRoot}::${name}` : name;
  if (_bodyCache.has(cacheKey)) return _bodyCache.get(cacheKey);

  const meta = findSkill(name, projectRoot);
  if (!meta) return null;

  const body = {};

  // Load SKILL.md body
  try {
    const content = fs.readFileSync(
      path.join(meta.path, SKILL_FILES.instructions),
      "utf-8",
    );
    const { body: instructions } = parseFrontmatter(content);
    body.instructions = instructions;
  } catch (err) {
    console.warn(`[skills] Failed to read SKILL.md for ${name}: ${err.message}`);
    return null;
  }

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

  _bodyCache.set(cacheKey, body);
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
 * @param {string} projectId
 * @param {string} skillName
 * @param {string} [projectRoot] - Project root for project-local skill resolution
 * @returns {{ success: boolean, error?: string, body?: SkillBody }}
 */
export function activateSkill(projectId, skillName, projectRoot = null) {
  const body = loadSkill(skillName, projectRoot);
  if (!body) {
    return { success: false, error: `Skill "${skillName}" not found. Use pane_list_skills to see available skills.` };
  }

  if (!_activeSkills.has(projectId)) {
    _activeSkills.set(projectId, new Set());
  }
  _activeSkills.get(projectId).add(skillName.toLowerCase());
  _notifyActiveSkillsChanged(projectId);

  return { success: true, body };
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
 * @param {string} sourceDir - Source skill directory (must contain SKILL.md)
 * @param {string} [renameTo] - Optional rename of the skill directory
 * @returns {{ success: boolean, error?: string, name?: string }}
 */
export function installSkill(sourceDir, renameTo = null) {
  // Verify source has SKILL.md
  const sourceSkillFile = path.join(sourceDir, SKILL_FILES.instructions);
  try {
    const content = fs.readFileSync(sourceSkillFile, "utf-8");
    const { frontmatter } = parseFrontmatter(content);
    const errors = validateFrontmatter(frontmatter);
    if (errors.length > 0) {
      return { success: false, error: `Invalid SKILL.md: ${errors.join(", ")}` };
    }

    const skillName = renameTo || frontmatter.name;
    const destDir = path.join(GLOBAL_SKILLS_DIR, skillName);

    // Recursive copy
    fs.cpSync(sourceDir, destDir, { recursive: true });

    // Invalidate cache
    invalidateDiscoveryCache();

    return { success: true, name: skillName };
  } catch (err) {
    return { success: false, error: `Failed to install skill: ${err.message}` };
  }
}

/**
 * Remove a skill from the global skills directory.
 * @param {string} skillName
 * @returns {{ success: boolean, error?: string }}
 */
export function removeSkill(skillName) {
  const skillDir = path.join(GLOBAL_SKILLS_DIR, skillName);
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    invalidateDiscoveryCache();
    // Also clear from body cache
    _bodyCache.delete(skillName);
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
  scanDirectory,
  GLOBAL_SKILLS_DIR,
  BUILTIN_SKILLS_DIR,
};
