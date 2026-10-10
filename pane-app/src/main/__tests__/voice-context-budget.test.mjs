import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { orchestrateContext } from "../context-orchestrator.mjs";

/**
 * Voice context budget (Sep 2026). The live voice session drifted to an
 * American accent while the 600-char preview held British — same model,
 * same voice, same accent instructions. The differentiator was blob size:
 * large realtime instructions measurably dilute accent adherence (OpenAI
 * dev forum reports corroborate; instructions delivery itself was proven
 * intact via session echo + token accounting). The skills listing alone
 * was 63% of the blob, and the voice tool whitelist has no activate_skill
 * — the voice layer could never act on it.
 *
 * These tests pin the contract: the voice backend gets the shared brain
 * (identity, about, playbook, peer awareness) but never the skills
 * catalog; every other backend keeps it.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("orchestrateContext — voice backend budget", () => {
  it("excludes the skills listing for the voice backend", () => {
    const ctx = orchestrateContext("pane", { projectRoot: ROOT, backend: "voice" });
    expect(ctx.full).not.toContain("## Available Skills");
  });

  it("keeps the skills listing for other backends", () => {
    const ctx = orchestrateContext("pane", { projectRoot: ROOT, backend: "http" });
    expect(ctx.full).toContain("## Available Skills");
  });

  it("keeps the shared brain sections in the voice blob", () => {
    const ctx = orchestrateContext("pane", { projectRoot: ROOT, backend: "voice" });
    // What voice DOES need: timezone anchor, playbook, peer awareness.
    expect(ctx.full).toContain("Local timezone");
    expect(ctx.full.length).toBeGreaterThan(1000); // not accidentally empty
  });

  it("voice blob stays under the accent-dilution budget (8k chars)", () => {
    // 8k is headroom over the observed ~6.5k: identity + about + playbook +
    // peer lines + role block + accent lead/tail. If a new layer pushes
    // past this, it must justify itself against accent adherence —
    // either compact it or move it to an on-demand tool.
    const ctx = orchestrateContext("pane", { projectRoot: ROOT, backend: "voice" });
    expect(ctx.full.length).toBeLessThan(8000);
  });
});
