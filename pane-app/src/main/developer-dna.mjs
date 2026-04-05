/**
 * Developer DNA — condensed behavioral identity for the model.
 *
 * Instead of injecting scattered profile files (rules.md, philosophy.md,
 * anti-patterns.json, identity.json, preferences.json) into every system
 * prompt as separate token-heavy layers, we compile them into a single
 * ~100-150 token DNA string that captures the essence of how the model
 * should behave.
 *
 * The DNA is compiled once (on project load or profile change), cached to
 * disk, and injected as a single frozen layer. It replaces all separate
 * behavioral injections.
 *
 * Why this works better:
 * - ~120 tokens vs ~1,300 tokens (90% reduction)
 * - Written as identity ("you are"), not rules ("don't do") — models
 *   internalize identity better than rule lists
 * - Compiled from the user's actual profile, not hardcoded
 * - The arbiter enforces compliance — the DNA sets the standard,
 *   the arbiter checks the work
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PANE_DIR = path.join(os.homedir(), ".pane");
const PROFILE_DIR = path.join(PANE_DIR, "profile");
const DNA_CACHE_PATH = path.join(PROFILE_DIR, "compiled-dna.txt");

/**
 * Read a profile file safely. Returns empty string if missing.
 */
function readProfileFile(filename) {
  try {
    return fs.readFileSync(path.join(PROFILE_DIR, filename), "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Read a JSON profile file safely. Returns null if missing/invalid.
 */
function readProfileJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, filename), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Compile the Developer DNA from profile files.
 *
 * Reads: identity.json, philosophy.md, rules.md
 * Ignores: anti-patterns.json (noise), preferences.json (too specific),
 *          profile-export.md (derivative), style.json (UI-only)
 *
 * @returns {string} Condensed DNA string (~120 tokens)
 */
export function compileDNA() {
  const identity = readProfileJson("identity.json");
  const philosophy = readProfileFile("philosophy.md");
  const rules = readProfileFile("rules.md");

  const parts = [];

  // ── Identity: who is the user ──────────────────────────────────────────
  if (identity?.name) {
    const role = identity.role ? ` — ${identity.role}` : "";
    parts.push(`Working with ${identity.name}${role}.`);
  }

  // ── Values: distilled from philosophy.md ───────────────────────────────
  // Extract the core values, not the full text
  if (philosophy) {
    const values = [];
    if (/start with the problem/i.test(philosophy)) values.push("start with the problem");
    if (/real people/i.test(philosophy)) values.push("build for real people");
    if (/authenticity/i.test(philosophy)) values.push("authenticity over performance");
    if (/specific and honest/i.test(philosophy)) values.push("specific and honest over polished");
    if (/consistency compounds/i.test(philosophy)) values.push("consistency compounds");
    if (values.length > 0) {
      parts.push(`Values: ${values.join(", ")}.`);
    }
  }

  // ── Standards: distilled from rules.md ─────────────────────────────────
  // Extract universal coding standards, skip project-specific details
  if (rules) {
    const standards = [];
    if (/suppress|@ts-nocheck|@ts-ignore|as any/i.test(rules)) {
      standards.push("fix root causes, never suppress errors");
    }
    if (/start simple/i.test(rules)) {
      standards.push("start simple, add complexity only when proven necessary");
    }
    if (/already decided|build on it/i.test(rules)) {
      standards.push("build on existing decisions — don't re-derive");
    }
    if (/think before|step by step/i.test(rules)) {
      standards.push("think step by step before acting");
    }
    if (/direct|no filler|corporate speak/i.test(rules)) {
      standards.push("direct communication, no filler");
    }
    if (/conventional commit/i.test(rules)) {
      standards.push("conventional commits: type(scope): behavior-focused outcome");
    }
    if (standards.length > 0) {
      parts.push(standards.join(". ") + ".");
    }
  }

  // ── Enforcement notice ─────────────────────────────────────────────────
  parts.push("Pane's quality gates enforce these standards at write time.");

  const dna = parts.join(" ");

  // Cache to disk
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(DNA_CACHE_PATH, dna, "utf-8");
  } catch {}

  return dna;
}

/**
 * Get the compiled DNA, using cache if available.
 * Recompiles if cache is older than profile files.
 *
 * @returns {string}
 */
export function getDNA() {
  // Check cache freshness
  try {
    const cacheStat = fs.statSync(DNA_CACHE_PATH);
    const profileFiles = ["identity.json", "philosophy.md", "rules.md"];
    let newestProfile = 0;
    for (const f of profileFiles) {
      try {
        const stat = fs.statSync(path.join(PROFILE_DIR, f));
        if (stat.mtimeMs > newestProfile) newestProfile = stat.mtimeMs;
      } catch {}
    }

    // Cache is fresh if it's newer than all profile files
    if (cacheStat.mtimeMs > newestProfile) {
      return fs.readFileSync(DNA_CACHE_PATH, "utf-8").trim();
    }
  } catch {}

  // Cache missing or stale — recompile
  return compileDNA();
}

/**
 * Read user-authored rules that should always be injected regardless of
 * backend type. These are the user's own constraints — project-specific
 * or universal — that no backend knows about natively.
 *
 * Only includes rules that are actionable behavioral guidance.
 * Skips: implementation details, fixed bugs, project-specific UI decisions.
 *
 * @returns {string[]} Array of rule strings
 */
export function getUserRules() {
  const rules = readProfileFile("rules.md");
  if (!rules) return [];

  return rules
    .split("\n")
    .map(line => line.replace(/^[-*]\s*/, "").trim())
    .filter(line => {
      if (!line || line.length < 10) return false;
      // Skip implementation-specific details
      if (/tauri-commands|\.tsx?:|\.mjs:|IPC|electron/i.test(line)) return false;
      return true;
    });
}
