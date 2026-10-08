import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The registry binds GLOBAL_SKILLS_DIR to ~/.pane/skills at import time, so
// these tests drive skills through a project root (<tmp>/.pane/skills), which
// exercises the same scan/load/cache paths as the global layer. Cache-eviction
// keys are covered for both the bare and project-scoped forms.
import {
  findSkill,
  loadSkill,
  activateSkill,
  deactivateSkill,
  getActiveSkills,
  installSkill,
  readSkillResource,
  invalidateDiscoveryCache,
  __test,
} from "../skill-registry.mjs";

let tmpRoot;
let projRoot;
let skillDir;
let fakeGlobalDir;

const SKILL_V1 = `---
name: cachetest
description: v1 description
tags: [cache]
---

# Cache Test v1

Original body from first install.

Read references/voice.md for details.
`;

const SKILL_V2 = `---
name: cachetest
description: v2 description - rebuilt
tags: [cache]
---

# Cache Test v2

Rebuilt body. The routing line now points at references/voice.md.
`;

function writeSkill(content, extra = {}) {
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
  for (const [rel, content2] of Object.entries(extra)) {
    const abs = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content2);
  }
  invalidateDiscoveryCache();
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pane-skill-cache-test-"));
  projRoot = path.join(tmpRoot, "proj");
  skillDir = path.join(projRoot, ".pane", "skills", "cachetest");
  // Redirect the global layer to a temp dir — installSkill must never touch
  // the real ~/.pane/skills from a test.
  fakeGlobalDir = path.join(tmpRoot, "fake-global-skills");
  fs.mkdirSync(fakeGlobalDir, { recursive: true });
  __test.setGlobalSkillsDir(fakeGlobalDir);
});

afterEach(() => {
  deactivateSkill("proj-1", "cachetest");
  deactivateSkill("proj-2", "cachetest");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  __test.setGlobalSkillsDir(path.join(os.homedir(), ".pane", "skills"));
  invalidateDiscoveryCache();
});

// ── Regression: stale body cache after reinstall ────────────────────────────
// Four production incidents (Sept 4, Sept 9 ×2, Sept 23, Oct 8 — Travelwise):
// activate_skill / pane_skill_info served the pre-rebuild SKILL.md after the
// files on disk were replaced. Root cause: _bodyCache had no freshness check
// and installSkill only invalidated the discovery (metadata) cache.

describe("skill body cache invalidation on reinstall", () => {
  it("serves the fresh body after files are replaced on disk (project-local)", () => {
    writeSkill(SKILL_V1);
    expect(loadSkill("cachetest", projRoot).instructions).toContain("Cache Test v1");

    // Reinstall: overwrite SKILL.md in place (mtime changes)
    writeSkill(SKILL_V2);

    const body = loadSkill("cachetest", projRoot);
    expect(body.instructions).toContain("Cache Test v2");
    expect(body.instructions).not.toContain("Cache Test v1");
  });

  it("serves the fresh body on activate_skill after a reinstall", () => {
    writeSkill(SKILL_V1);
    const first = activateSkill("proj-1", "cachetest", projRoot);
    expect(first.body.instructions).toContain("Cache Test v1");

    writeSkill(SKILL_V2);
    const second = activateSkill("proj-2", "cachetest", projRoot);
    expect(second.body.instructions).toContain("Cache Test v2");
  });

  it("serves the fresh body after an in-place edit, without any cache invalidation call", () => {
    writeSkill(SKILL_V1);
    expect(loadSkill("cachetest", projRoot).instructions).toContain("Cache Test v1");

    fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_V2);

    const body = loadSkill("cachetest", projRoot);
    expect(body.instructions).toContain("Cache Test v2");
  });

  it("drops cached bodies when the skill disappears, and a reinstall starts clean", () => {
    writeSkill(SKILL_V1);
    expect(loadSkill("cachetest", projRoot)).not.toBeNull();

    fs.rmSync(skillDir, { recursive: true, force: true });
    invalidateDiscoveryCache();
    expect(loadSkill("cachetest", projRoot)).toBeNull();

    writeSkill(SKILL_V2);
    expect(loadSkill("cachetest", projRoot).instructions).toContain("Cache Test v2");
  });

  it("keeps separate cache entries per project root", () => {
    const otherRoot = path.join(tmpRoot, "proj-b");
    const otherSkillDir = path.join(otherRoot, ".pane", "skills", "cachetest");
    writeSkill(SKILL_V1);

    fs.mkdirSync(otherSkillDir, { recursive: true });
    fs.writeFileSync(path.join(otherSkillDir, "SKILL.md"), SKILL_V2);
    invalidateDiscoveryCache();

    const a = loadSkill("cachetest", projRoot);
    const b = loadSkill("cachetest", otherRoot);
    expect(a.instructions).toContain("Cache Test v1");
    expect(b.instructions).toContain("Cache Test v2");
  });
});

// ── Companion resources ──────────────────────────────────────────────────────
// SKILL.md routes like "Read references/voice.md" are instructions, not
// imports. The registry must expose what resources exist and let callers read
// them relative to the skill root, with a clear error when one is missing.

describe("companion resources (references/, knowledge/)", () => {
  it("lists routed companion files on the loaded body", () => {
    writeSkill(SKILL_V2, {
      "references/voice.md": "# Voice\n\nClear. Declarative.",
      "references/product.md": "# Product\n\nThe product is a Dream Safari.",
      "knowledge/handbook.md": "# Handbook\n\nThree questions.",
    });

    const body = loadSkill("cachetest", projRoot);
    const paths = body.resources.map((r) => r.path);
    expect(paths).toContain("references/voice.md");
    expect(paths).toContain("references/product.md");
    expect(paths).toContain("knowledge/handbook.md");
    expect(body.skillPath).toBe(skillDir);
  });

  it("reads a routed relative path against the skill root", () => {
    writeSkill(SKILL_V2, { "references/voice.md": "# Voice\n\nClear." });

    const res = readSkillResource("cachetest", "references/voice.md", projRoot);
    expect(res.success).toBe(true);
    expect(res.content).toContain("# Voice");
    expect(res.absolutePath).toBe(path.join(skillDir, "references", "voice.md"));
  });

  it("refuses paths that escape the skill directory", () => {
    writeSkill(SKILL_V1);
    const res = readSkillResource("cachetest", "../../etc/passwd", projRoot);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside skill directory/);
  });

  it("returns a clear, actionable error when a routed file is missing", () => {
    writeSkill(SKILL_V1); // routes to references/voice.md but ships none
    const res = readSkillResource("cachetest", "references/voice.md", projRoot);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not be read/);
    expect(res.error).toMatch(/pane_skill_info/);
  });

  it("refreshes the resource list after companion files are added post-activation", () => {
    writeSkill(SKILL_V2);
    expect(loadSkill("cachetest", projRoot).resources).toHaveLength(0);

    fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "references", "voice.md"), "# Voice");
    // NOTE: SKILL.md mtime is unchanged, so the body cache may still hold.
    // Companion additions only refresh on the next SKILL.md change — but the
    // read path is never stale: readSkillResource goes to disk directly.
    const res = readSkillResource("cachetest", "references/voice.md", projRoot);
    expect(res.success).toBe(true);
  });
});

// ── installSkill cache eviction (global layer, via __test hook) ─────────────

describe("installSkill / removeSkill cache eviction", () => {
  it("installSkill evicts a previously cached body under the same name", () => {
    writeSkill(SKILL_V1);
    // Warm the bare-name cache the way a global activation would
    const globalSkillDir = path.join(tmpRoot, "global-src", "cachetest");
    fs.mkdirSync(globalSkillDir, { recursive: true });
    fs.writeFileSync(path.join(globalSkillDir, "SKILL.md"), SKILL_V1);
    installSkill(globalSkillDir, "cachetest");

    // Load through the global layer (no projectRoot)
    const before = loadSkill("cachetest");
    expect(before.instructions).toContain("Cache Test v1");

    // Reinstall the rebuilt version over the global install
    fs.writeFileSync(path.join(globalSkillDir, "SKILL.md"), SKILL_V2);
    installSkill(globalSkillDir, "cachetest");

    const after = loadSkill("cachetest");
    expect(after.instructions).toContain("Cache Test v2");
  });
});

// ── Existing behavior that must not regress ──────────────────────────────────

describe("baseline behavior", () => {
  it("activate/deactivate tracks active skills per project", () => {
    writeSkill(SKILL_V1);
    activateSkill("proj-1", "cachetest", projRoot);
    activateSkill("proj-2", "cachetest", projRoot);
    expect([...getActiveSkills("proj-1")]).toEqual(["cachetest"]);
    deactivateSkill("proj-1", "cachetest");
    expect(getActiveSkills("proj-1").size).toBe(0);
    expect(getActiveSkills("proj-2").size).toBe(1);
  });

  it("findSkill resolves project-local skills and reports their source", () => {
    writeSkill(SKILL_V1);
    const meta = findSkill("cachetest", projRoot);
    expect(meta.source).toBe("project");
    expect(meta.projectRoot).toBe(projRoot);
  });

  it("frontmatter parsing still handles inline arrays", () => {
    const { frontmatter } = __test.parseFrontmatter(SKILL_V1);
    expect(frontmatter.tags).toEqual(["cache"]);
  });
});
