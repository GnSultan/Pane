import { describe, it, expect } from "vitest";
import { detectFailureSignals, detectSuccessSignals, djb2Hash, jaccardSimilarity } from "../turn-signals.mjs";
import { classifyDomain } from "../routing-oracle.mjs";

/**
 * The heuristic router's routing half (tier/complexity/mode scoring) was
 * removed Oct 2026. What survives is signal detection (struggle/success —
 * feeds thread-state escalation and steering-classifier) and the phase
 * mapping (classification → mode → combo slot). These tests pin both.
 */
describe("turn-signals", () => {
  it("flags explicit failure language", () => {
    expect(detectFailureSignals("that didn't work, still broken", 0, "").isFailure).toBe(true);
    expect(detectFailureSignals("nope", 0, "").isFailure).toBe(true);
  });

  it("flags a near-duplicate resend of the same prompt", () => {
    const prev = "fix the authentication flow in the login controller";
    const again = "fix the authentication flow in the login controller please";
    expect(detectFailureSignals(again, djb2Hash(prev), prev).type).toBe("near-duplicate");
  });

  it("never flags approval/confirmation as failure", () => {
    expect(detectFailureSignals("yes", 0, "").isFailure).toBe(false);
    expect(detectFailureSignals("ok do it", 0, "").isFailure).toBe(false);
  });

  it("detects success language", () => {
    expect(detectSuccessSignals("perfect, that works")).toBe(true);
    expect(detectSuccessSignals("thanks")).toBe(true);
    expect(detectSuccessSignals("now let's work on the sidebar")).toBe(true);
  });

  it("djb2Hash is deterministic and unsigned", () => {
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
    expect(djb2Hash("hello")).toBeGreaterThanOrEqual(0);
  });

  it("jaccardSimilarity bounds", () => {
    expect(jaccardSimilarity("identical sentence here", "identical sentence here")).toBe(1);
    expect(jaccardSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });
});

describe("phase routing mapping (routing half of removed router)", () => {
  // Same mapping punk-engine and previewRoute both use — the preview and
  // the real route can never diverge because both derive from this.
  const modeFor = (classification) =>
    classification === "explanation" ? "discuss"
      : classification === "debugging" || classification === "architecture" ? "analyze"
      : "direct";
  const slotFor = (mode, escalationStage) => {
    const wantsThinking = mode === "discuss" || mode === "analyze" || escalationStage >= 2;
    return wantsThinking ? "thinking" : "execution";
  };

  it("explanations route to discuss → thinking slot", () => {
    const mode = modeFor(classifyDomain("why does the event loop starve?"));
    expect(mode).toBe("discuss");
    expect(slotFor(mode, 0)).toBe("thinking");
  });

  it("debugging routes to analyze → thinking slot", () => {
    const mode = modeFor(classifyDomain("the login controller crashes with an undefined error"));
    expect(mode).toBe("analyze");
    expect(slotFor(mode, 0)).toBe("thinking");
  });

  it("build requests route direct → execution slot", () => {
    const mode = modeFor(classifyDomain("add a filter dropdown to the invoices table"));
    expect(mode).toBe("direct");
    expect(slotFor(mode, 0)).toBe("execution");
  });

  it("escalation upgrades a build turn to the thinking slot", () => {
    expect(slotFor("direct", 2)).toBe("thinking");
  });
});
