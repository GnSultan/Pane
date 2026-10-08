import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Adversarial suite for the skill infrastructure: package trust, path
// containment, shell-injection surface, resource-size limits, deterministic
// ordering, conflict enforcement, and packaged-runtime builtin resolution.
import {
  installSkill,
  removeSkill,
  loadSkill,
  findSkill,
  discoverAll,
  activateSkill,
  deactivateSkill,
  readSkillResource,
  invalidateDiscoveryCache,
  __test,
} from "../skill-registry.mjs";

let tmpRoot;
let projRoot;
let skillDir;
let fakeGlobalDir;

const BASE = `---
name: sectest
description: security test skill
tags: [sec]
---

# Sec Test

Body.
`;

function writeProjectSkill(content, extra = {}, name = "sectest") {
  const dir = path.join(projRoot, ".pane", "skills", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  for (const [rel, c] of Object.entries(extra)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, c);
  }
  invalidateDiscoveryCache();
  return dir;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pane-skill-sec-test-"));
  projRoot = path.join(tmpRoot, "proj");
  fakeGlobalDir = path.join(tmpRoot, "fake-global-skills");
  fs.mkdirSync(fakeGlobalDir, { recursive: true });
  __test.setGlobalSkillsDir(fakeGlobalDir);
});

afterEach(() => {
  deactivateSkill("sec-proj", "sectest");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  __test.setGlobalSkillsDir(path.join(os.homedir(), ".pane", "skills"));
  invalidateDiscoveryCache();
});

// ── 1. Skill-source parsing: shell-injection surface ────────────────────────
// pane_install_skill builds a git clone command from a model-supplied
// github:owner/repo/path string. Every component that reaches a command line
// or a path.join must be charset-validated — double quotes do not stop
// $(...) substitution, so "$(cmd)" in owner/repo is code execution.

describe("parseSkillSource (model-controlled skill sources)", () => {
  it("accepts a well-formed github: source", () => {
    const r = __test.parseSkillSource("github:owner/repo/path/to/skill");
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ kind: "github", owner: "owner", repo: "repo", skillPath: "path/to/skill" });
  });

  it("rejects command substitution in the owner", () => {
    const r = __test.parseSkillSource("github:$(touch /tmp/pwned)/repo/skill");
    expect(r.error).toMatch(/invalid/i);
  });

  it("rejects command substitution in the repo", () => {
    const r = __test.parseSkillSource("github:owner/$(id)/skill");
    expect(r.error).toMatch(/invalid/i);
  });

  it("rejects backtick injection in the path", () => {
    const r = __test.parseSkillSource("github:owner/repo/`touch /tmp/pwned`");
    expect(r.error).toMatch(/invalid/i);
  });

  it("rejects traversal segments in the skill path", () => {
    expect(__test.parseSkillSource("github:owner/repo/../skill").error).toMatch(/invalid|traversal/i);
    expect(__test.parseSkillSource("github:o/r/a/../../b").error).toMatch(/invalid|traversal/i);
  });

  it("rejects a github: source with fewer than owner/repo/path", () => {
    expect(__test.parseSkillSource("github:owner/repo").error).toBeTruthy();
    expect(__test.parseSkillSource("github:owner").error).toBeTruthy();
    expect(__test.parseSkillSource("github:").error).toBeTruthy();
  });

  it("classifies local paths separately", () => {
    const r = __test.parseSkillSource("/some/local/dir");
    expect(r).toMatchObject({ kind: "local", localPath: "/some/local/dir" });
  });
});

// ── 2. Skill-name validation: traversal writes ──────────────────────────────
// installSkill(renameTo) and removeSkill(name) both path.join the name onto
// the global skills dir. A ".."-bearing name writes/deletes outside it.

describe("validateSkillName", () => {
  it("accepts normal skill names", () => {
    for (const n of ["travelwise", "next-best-practices", "my.skill", "Skill_1", "a"]) {
      expect(__test.validateSkillName(n)).toBe(true);
    }
  });

  it("refuses traversal, absolute, and hidden names", () => {
    for (const n of ["..", "../evil", "../../.ssh", ".", ".hidden", "/abs", "a/b", "a\\b", "", " ".repeat(3), "x".repeat(200), "name;rm", "name with space$(x)"]) {
      expect(__test.validateSkillName(n)).toBe(false);
    }
  });
});

describe("installSkill traversal containment", () => {
  it("refuses a renameTo that escapes the global skills dir and writes nothing", () => {
    const src = writeProjectSkill(BASE);
    const outside = path.join(tmpRoot, "escaped");
    fs.mkdirSync(outside, { recursive: true });

    const before = fs.readdirSync(outside);
    const r = installSkill(src, "../../" + path.basename(outside) + "/evil");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/name/i);
    expect(fs.readdirSync(outside)).toEqual(before); // nothing written outside
  });

  it("refuses a renameTo that is just traversal", () => {
    const src = writeProjectSkill(BASE);
    expect(installSkill(src, "..").success).toBe(false);
    expect(installSkill(src, ".").success).toBe(false);
  });

  it("refuses to install when the frontmatter name itself is a traversal", () => {
    const src = writeProjectSkill(`---\nname: ../../evil\ndescription: bad\n---\n\nbody\n`);
    const r = installSkill(src, null);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/name/i);
  });

  it("refuses to install an unparseable compose.json", () => {
    const src = writeProjectSkill(BASE, { "compose.json": "{not json" });
    const r = installSkill(src, "sectest");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/compose/i);
  });
});

describe("removeSkill traversal containment", () => {
  it("refuses a traversal name and deletes nothing", () => {
    const victim = path.join(tmpRoot, "victim");
    fs.mkdirSync(path.join(victim, "keep"), { recursive: true });
    fs.writeFileSync(path.join(victim, "keep", "f.txt"), "keep me");

    const r = removeSkill("../victim");
    expect(r.success).toBe(false);
    expect(fs.existsSync(path.join(victim, "keep", "f.txt"))).toBe(true);
  });

  it("removes a legitimately installed global skill", () => {
    const src = writeProjectSkill(BASE);
    expect(installSkill(src, "sectest").success).toBe(true);
    invalidateDiscoveryCache();
    expect(findSkill("sectest")).not.toBeNull();
    expect(removeSkill("sectest").success).toBe(true);
    invalidateDiscoveryCache();
    expect(findSkill("sectest")).toBeNull();
  });
});

// ── 3. Symlink containment in companion-resource reads ─────────────────────
// The lexical prefix check passes for a symlink whose *path* sits inside the
// skill root but whose *target* is outside it. A skill installed from an
// untrusted repo can route "Read references/creds" at a symlink to
// ~/.ssh/id_rsa. Containment must be checked on the real path.

describe("readSkillResource symlink containment", () => {
  it("refuses a symlink that escapes the skill root", () => {
    const secret = path.join(tmpRoot, "secret.txt");
    fs.writeFileSync(secret, "private key material");
    writeProjectSkill(BASE);

    const linkDir = path.join(skillDir ?? (skillDir = path.join(projRoot, ".pane", "skills", "sectest")), "references");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(secret, path.join(linkDir, "creds"));

    const r = readSkillResource("sectest", "references/creds", projRoot);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside the skill directory|symlink/i);
  });

  it("still reads a real file after the symlink guard exists", () => {
    writeProjectSkill(BASE, { "references/real.md": "# Real" });
    const r = readSkillResource("sectest", "references/real.md", projRoot);
    expect(r.success).toBe(true);
    expect(r.content).toContain("# Real");
  });
});

// ── 4. Resource size cap ────────────────────────────────────────────────────
// A companion file inside an untrusted skill package can be arbitrarily
// large; reading it whole funnels megabytes straight into the conversation.

describe("readSkillResource size cap", () => {
  it("truncates an oversized resource with a visible marker", () => {
    const big = "x".repeat(600 * 1024);
    writeProjectSkill(BASE, { "references/big.txt": big });

    const r = readSkillResource("sectest", "references/big.txt", projRoot);
    expect(r.success).toBe(true);
    expect(r.content.length).toBeLessThan(600 * 1024);
    expect(r.content).toMatch(/truncated/i);
  });
});

// ── 5. Oversized SKILL.md ───────────────────────────────────────────────────
// Discovery scans every directory and reads every SKILL.md fully. An
// adversarial package (installed from any repo) must not be able to force
// multi-hundred-MB reads.

describe("oversized SKILL.md", () => {
  it("is skipped at discovery instead of read in full", () => {
    const huge = "---\nname: huge\ndescription: big\n---\n\n" + "y".repeat(3 * 1024 * 1024);
    writeProjectSkill(huge, {}, "huge");
    const skills = discoverAll(projRoot).filter((s) => s.name === "huge");
    expect(skills).toHaveLength(0);
  });

  it("is refused at install", () => {
    const huge = "---\nname: huge\ndescription: big\n---\n\n" + "y".repeat(3 * 1024 * 1024);
    const src = writeProjectSkill(huge, {}, "huge");
    const r = installSkill(src, "huge");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/large|size/i);
  });
});

// ── 6. BOM tolerance ────────────────────────────────────────────────────────
// Editors save UTF-8 with a BOM; a BOM-prefixed SKILL.md used to fail
// frontmatter parsing entirely.

describe("BOM-prefixed SKILL.md", () => {
  it("parses frontmatter after a UTF-8 BOM", () => {
    const { frontmatter, body } = __test.parseFrontmatter("\uFEFF" + BASE);
    expect(frontmatter.name).toBe("sectest");
    expect(body).toContain("Sec Test");
  });
});

// ── 7. Deterministic ordering ───────────────────────────────────────────────
describe("deterministic discovery order", () => {
  it("lists skills sorted by name within a layer", () => {
    writeProjectSkill(BASE, {}, "zeta");
    writeProjectSkill(BASE, {}, "alpha");
    writeProjectSkill(BASE, {}, "Mid");
    const names = discoverAll(projRoot).filter((s) => s.source === "project").map((s) => s.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });
});

// ── 8. Compose conflict enforcement ────────────────────────────────────────
// compose.json documents "conflicts: skills that cannot be active
// simultaneously" — but activateSkill never checked it.

describe("compose conflict enforcement", () => {
  const A = `---\nname: cona\ndescription: a\ntags: []\n---\n\nA body\n`;
  const B = `---\nname: conb\ndescription: b\ntags: []\n---\n\nB body\n`;

  function writeCompose(name, compose) {
    writeProjectSkill(
      name === "cona" ? A : B,
      { "compose.json": JSON.stringify(compose) },
      name,
    );
  }

  it("refuses to activate a skill that conflicts with an active one", () => {
    writeCompose("cona", { name: "cona", conflicts: ["conb"] });
    writeCompose("conb", { name: "conb" });
    expect(activateSkill("sec-proj", "cona", projRoot).success).toBe(true);
    const r = activateSkill("sec-proj", "conb", projRoot);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/conflict/i);
    // The conflicting skill must NOT have been added to the active set
    deactivateSkill("sec-proj", "cona");
  });

  it("warns (does not fail) when a requirement is not active", () => {
    writeCompose("cona", { name: "cona", requires: ["missing-skill"] });
    const r = activateSkill("sec-proj", "cona", projRoot);
    expect(r.success).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/missing-skill/);
    deactivateSkill("sec-proj", "cona");
  });
});

// ── 9. Body-cache bound ─────────────────────────────────────────────────────
describe("body cache bound", () => {
  it("evicts the oldest entry beyond the cap", () => {
    for (let i = 0; i < __test.MAX_BODY_CACHE_ENTRIES + 10; i++) {
      writeProjectSkill(
        `---\nname: skill-${String(i).padStart(3, "0")}\ndescription: d ${i}\n---\n\nbody ${i}\n`,
        {},
        `skill-${String(i).padStart(3, "0")}`,
      );
      loadSkill(`skill-${String(i).padStart(3, "0")}`, projRoot);
    }
    expect(__test.bodyCacheSize()).toBeLessThanOrEqual(__test.MAX_BODY_CACHE_ENTRIES);
  });
});

// ── 10. Packaged-runtime builtin resolution ─────────────────────────────────
// electron-builder does not ship <pane-app>/skills/ inside app.asar, so the
// old <root>/skills builtin path resolved to a directory that only exists in
// development. Resolution must check the packaged resources dir the way
// model-paths.mjs does for models.

describe("builtin skills directory resolution", () => {
  it("prefers process.resourcesPath/skills when present (packaged layout)", () => {
    const fakeResources = path.join(tmpRoot, "Resources");
    fs.mkdirSync(path.join(fakeResources, "skills", "packed-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeResources, "skills", "packed-skill", "SKILL.md"),
      "---\nname: packed-skill\ndescription: ships in the dmg\n---\n\nbody\n",
    );
    const prev = process.resourcesPath;
    process.resourcesPath = fakeResources;
    try {
      expect(__test.resolveBuiltinSkillsDir()).toBe(path.join(fakeResources, "skills"));
    } finally {
      if (prev === undefined) delete process.resourcesPath;
      else process.resourcesPath = prev;
    }
  });
});

// ── 11. Tool surface: schemas for every agent route ─────────────────────────
describe("skill tool schemas (http backend exposure)", () => {
  it("defines all agent-facing skill tools with required params", async () => {
    const { getBuiltinToolDefinitions } = await import("../http-backend.mjs");
    const byName = new Map(getBuiltinToolDefinitions().map((t) => [t.function.name, t.function]));
    for (const name of [
      "pane_list_skills",
      "pane_skill_info",
      "pane_read_skill_resource",
      "activate_skill",
      "deactivate_skill",
      "pane_install_skill",
      "pane_uninstall_skill",
    ]) {
      expect(byName.get(name), `missing schema for ${name}`).toBeTruthy();
    }
    // `required` must include the params the tool-executor branches on — a
    // missing required marker means providers may omit them.
    expect(byName.get("pane_read_skill_resource").parameters.required).toEqual(["name", "path"]);
    expect(byName.get("pane_skill_info").parameters.required).toEqual(["name"]);
    expect(byName.get("activate_skill").parameters.required).toEqual(["name"]);
    expect(byName.get("deactivate_skill").parameters.required).toEqual(["name"]);
    expect(byName.get("pane_uninstall_skill").parameters.required).toEqual(["name"]);
    expect(byName.get("pane_install_skill").parameters.required).toEqual(["url"]);
  });
});
