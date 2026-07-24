#!/usr/bin/env node

/**
 * Pane Skills CLI — manage agent skills from the command line.
 *
 * Usage:
 *   node scripts/skills-cli.mjs list                    # List installed skills
 *   node scripts/skills-cli.mjs info <name>             # Show skill details
 *   node scripts/skills-cli.mjs install <path|url>      # Install a skill
 *   node scripts/skills-cli.mjs remove <name>           # Remove a skill
 *   node scripts/skills-cli.mjs discover                # Discover available community skills
 *   node scripts/skills-cli.mjs create <name>           # Scaffold a new skill
 *
 * Skills are directories with a SKILL.md file. They can be installed from:
 *   - A local directory path
 *   - A GitHub repo URL (e.g., github:vercel-labs/agent-skills/skills/frontend-design)
 *
 * Installed skills go to ~/.pane/skills/ (global) or .pane/skills/ (project-local).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANE_DIR = path.join(os.homedir(), ".pane");
const GLOBAL_SKILLS_DIR = path.join(PANE_DIR, "skills");

// Dynamically import the skill registry
async function getRegistry() {
  return await import("../src/main/skill-registry.mjs");
}

// ── Helpers ──────────────────────────────────────────────────────────────

function usage() {
  console.log(`Pane Skills CLI

Usage:
  node scripts/skills-cli.mjs list                    List installed skills
  node scripts/skills-cli.mjs info <name>             Show skill details
  node scripts/skills-cli.mjs install <path|url>      Install a skill
  node scripts/skills-cli.mjs remove <name>           Remove a skill
  node scripts/skills-cli.mjs create <name>           Scaffold a new skill

Examples:
  node scripts/skills-cli.mjs list
  node scripts/skills-cli.mjs info debugger
  node scripts/skills-cli.mjs install ./my-skill
  node scripts/skills-cli.mjs install github:vercel-labs/agent-skills/skills/frontend-design
  node scripts/skills-cli.mjs remove my-skill
  node scripts/skills-cli.mjs create my-new-skill`);
}

function log(msg) {
  console.log(msg);
}

function error(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────────────

async function cmdList() {
  const { listInstalledSkills } = await getRegistry();
  const skills = listInstalledSkills();

  if (skills.length === 0) {
    log("No skills installed.");
    log("");
    log("Install a skill with: node scripts/skills-cli.mjs install <path>");
    log("Create a new skill with: node scripts/skills-cli.mjs create <name>");
    return;
  }

  log(`Installed skills (${skills.length}):`);
  log("");
  for (const skill of skills) {
    const sourceLabel = skill.source === "project" ? " [project]" : skill.source === "builtin" ? " [built-in]" : " [global]";
    const tagStr = skill.tags.length > 0 ? ` (${skill.tags.join(", ")})` : "";
    log(`  ${skill.name} v${skill.version}${sourceLabel}${tagStr}`);
    log(`    ${skill.description}`);
    log(`    Path: ${skill.path}`);
    log("");
  }
}

async function cmdInfo(name) {
  const { findSkill, loadSkill } = await getRegistry();
  const meta = findSkill(name);
  if (!meta) {
    error(`Skill "${name}" not found.`);
  }

  log(`Skill: ${meta.name}`);
  log(`Version: ${meta.version}`);
  log(`Source: ${meta.source}`);
  log(`Path: ${meta.path}`);
  log(`Tags: ${meta.tags.join(", ") || "none"}`);
  log("");
  log(`Description: ${meta.description}`);
  log("");

  const body = loadSkill(name);
  if (!body) {
    log("(Could not load skill body)");
    return;
  }

  log("─── Instructions ───");
  log(body.instructions.slice(0, 2000));
  if (body.instructions.length > 2000) {
    log(`... (${body.instructions.length - 2000} more characters)`);
  }
  log("");

  if (body.compose) {
    log("─── Composition ───");
    log(JSON.stringify(body.compose, null, 2));
    log("");
  }

  if (body.playbook) {
    log("─── Domain Principles ───");
    log(body.playbook);
    log("");
  }

  if (body.tools) {
    log("─── Bundled Tools ───");
    log(JSON.stringify(body.tools, null, 2));
    log("");
  }
}

async function cmdInstall(source) {
  if (!source) error("Source path or URL is required.");

  const { installSkill, ensureGlobalSkillsDir } = await getRegistry();

  // Handle github: URLs
  if (source.startsWith("github:")) {
    const githubPath = source.slice(7); // github:owner/repo/path/to/skill
    const parts = githubPath.split("/");
    if (parts.length < 3) {
      error("GitHub path must be: github:owner/repo/path/to/skill");
    }

    const owner = parts[0];
    const repo = parts[1];
    const skillPath = parts.slice(2).join("/");
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    const tmpDir = path.join(os.tmpdir(), `pane-skill-${repo}-${Date.now()}`);
    log(`Cloning ${repoUrl}...`);

    try {
      execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, {
        stdio: "pipe",
        timeout: 30000,
      });
    } catch (err) {
      error(`Failed to clone: ${err.message}`);
    }

    const skillDir = path.join(tmpDir, skillPath);
    if (!fs.existsSync(skillDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      error(`Skill path "${skillPath}" not found in repo.`);
    }

    const skillName = parts[parts.length - 1];
    ensureGlobalSkillsDir();
    const result = installSkill(skillDir, skillName);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (result.success) {
      log(`Installed "${result.name}" from ${source}`);
    } else {
      error(result.error);
    }
    return;
  }

  // Local directory
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    error(`Path "${resolved}" does not exist.`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    error(`Path "${resolved}" is not a directory.`);
  }

  ensureGlobalSkillsDir();
  const result = installSkill(resolved);
  if (result.success) {
    log(`Installed "${result.name}" from ${resolved}`);
  } else {
    error(result.error);
  }
}

async function cmdRemove(name) {
  if (!name) error("Skill name is required.");
  const { removeSkill } = await getRegistry();
  const result = removeSkill(name);
  if (result.success) {
    log(`Removed skill "${name}".`);
  } else {
    error(result.error);
  }
}

async function cmdCreate(name) {
  if (!name) error("Skill name is required.");

  const dir = path.resolve(name);
  if (fs.existsSync(dir)) {
    error(`Directory "${dir}" already exists.`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const skillMd = `---
name: ${name}
description: [Brief description of what this skill does and when to use it]
version: 0.1.0
tags: []
---

# ${name}

## When to use this skill
[Describe the situations where this skill should be activated]

## Methodology

### 1. [Step one]
[Description]

### 2. [Step two]
[Description]

## Anti-patterns
- [What to avoid]
- [Common mistakes]

## Output
[What the agent should produce after using this skill]

## Principles
- [Core beliefs that guide this skill]
`;

  const composeJson = JSON.stringify({
    name,
    version: "0.1.0",
    extends: [],
    conflicts: [],
    requires: [],
    provides: [name],
    tags: [],
    priority: 5,
  }, null, 2) + "\n";

  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd);
  fs.writeFileSync(path.join(dir, "compose.json"), composeJson);
  fs.writeFileSync(path.join(dir, "playbook.md"), `## ${name} Principles\n\n(Add domain principles here — they'll be merged into the project playbook when this skill is active.)\n`);

  log(`Created skill scaffold at "${dir}":`);
  log(`  ${dir}/SKILL.md`);
  log(`  ${dir}/compose.json`);
  log(`  ${dir}/playbook.md`);
  log("");
  log("Edit SKILL.md to define your skill's instructions.");
  log(`Install it with: node scripts/skills-cli.mjs install ${dir}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "list":
    await cmdList();
    break;
  case "info":
    await cmdInfo(args[1]);
    break;
  case "install":
    await cmdInstall(args[1]);
    break;
  case "remove":
    await cmdRemove(args[1]);
    break;
  case "create":
    await cmdCreate(args[1]);
    break;
  case "discover":
    log("Community skill discovery coming soon. Check skills.sh for available skills.");
    log("To install a community skill: node scripts/skills-cli.mjs install github:<owner>/<repo>/<path>");
    break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
