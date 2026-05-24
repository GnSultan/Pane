import { describe, it, expect } from "vitest";
import {
  base64ToFloat32Array,
  selectTurns,
} from "../semantic-turn-selector.mjs";

// ── base64ToFloat32Array ─────────────────────────────────────────────────────

describe("base64ToFloat32Array", () => {
  it("converts a Float32Array to base64 and back", () => {
    const original = new Float32Array([0.1, 0.5, -0.3, 1.0, 0.0, -0.99]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(original.buffer)));
    const result = base64ToFloat32Array(b64);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(6);
    for (let i = 0; i < original.length; i++) {
      expect(result[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("returns null for null input", () => {
    expect(base64ToFloat32Array(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(base64ToFloat32Array("")).toBeNull();
  });

  it("handles negative values correctly", () => {
    const arr = new Float32Array([-0.5, 0.25, -1.0]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(arr.buffer)));
    const result = base64ToFloat32Array(b64);
    expect(result[0]).toBeCloseTo(-0.5, 5);
    expect(result[1]).toBeCloseTo(0.25, 5);
    expect(result[2]).toBeCloseTo(-1.0, 5);
  });
});

// ── selectTurns ──────────────────────────────────────────────────────────────

describe("selectTurns", () => {
  it("returns empty result for empty input", () => {
    const result = selectTurns([], 20000);
    expect(result).toEqual({
      includedTurnIndices: [],
      droppedTurnIndices: [],
      relevanceScores: [],
      tokensUsed: 0,
      totalTurns: 0,
    });
  });

  it("includes all TIER 1 (sliding_window) turns regardless of budget", () => {
    const scored = [
      { turnIndex: 0, score: Infinity, tier: "sliding_window", tokenCount: 100 },
      { turnIndex: 1, score: Infinity, tier: "sliding_window", tokenCount: 200 },
      { turnIndex: 2, score: 0.9, tier: "semantic_pool", tokenCount: 100 },
    ];
    const result = selectTurns(scored, 100, 1, 5);
    expect(result.includedTurnIndices).toContain(0);
    expect(result.includedTurnIndices).toContain(1);
  });

  it("selects TIER 2 turns by relevance when budget allows", () => {
    const scored = [
      { turnIndex: 0, score: Infinity, tier: "sliding_window", tokenCount: 100 },
      { turnIndex: 1, score: 0.9, tier: "semantic_pool", tokenCount: 50 },
      { turnIndex: 2, score: 0.5, tier: "semantic_pool", tokenCount: 50 },
    ];
    const result = selectTurns(scored, 300, 1, 5);
    expect(result.includedTurnIndices).toContain(0); // TIER 1
    expect(result.includedTurnIndices).toContain(1); // higher relevance
    expect(result.includedTurnIndices).toContain(2); // still fits budget
  });

  it("respects maxTier2Turns limit", () => {
    const scored = [
      { turnIndex: 0, score: Infinity, tier: "sliding_window", tokenCount: 100 },
      { turnIndex: 1, score: 0.9, tier: "semantic_pool", tokenCount: 50 },
      { turnIndex: 2, score: 0.8, tier: "semantic_pool", tokenCount: 50 },
      { turnIndex: 3, score: 0.7, tier: "semantic_pool", tokenCount: 50 },
      { turnIndex: 4, score: 0.6, tier: "semantic_pool", tokenCount: 50 },
    ];
    const result = selectTurns(scored, 500, 1, 2);
    expect(result.includedTurnIndices).toContain(0); // TIER 1
    expect(result.includedTurnIndices).toContain(1); // highest TIER 2
    expect(result.includedTurnIndices).toContain(2); // second highest TIER 2
    expect(result.includedTurnIndices).not.toContain(3); // exceeds maxTier2Turns
    expect(result.includedTurnIndices).not.toContain(4);
  });

  it("drops low-relevance TIER 2 turns when budget is tight", () => {
    const scored = [
      { turnIndex: 0, score: Infinity, tier: "sliding_window", tokenCount: 100 },
      { turnIndex: 1, score: 0.9, tier: "semantic_pool", tokenCount: 200 },
      { turnIndex: 2, score: 0.3, tier: "semantic_pool", tokenCount: 50 },
    ];
    const result = selectTurns(scored, 150, 1, 5);
    expect(result.includedTurnIndices).toContain(0); // TIER 1 always
    expect(result.includedTurnIndices).toContain(1); // high relevance fits (100 + 200 = 300 > 150? No, minTurns=1 means only include tier2 if it's among first minTurns)
    // Actually: tier2[0] is included due to minTurns, tier2[1] is checked against budget
    // tokensUsed after tier1 = 100, tier2[0] (turnIndex 1) = 100+200=300 > 150
    // But minTurns=1 includes first tier2 regardless of budget
    expect(result.includedTurnIndices).toContain(1); // minTurns guarantees first tier2
    expect(result.droppedTurnIndices).toContain(2); // low relevance dropped
  });

  it("meets minTurns requirement even if TIER 1 turns are few", () => {
    const scored = [
      { turnIndex: 0, score: Infinity, tier: "sliding_window", tokenCount: 100 },
      { turnIndex: 1, score: 0.9, tier: "semantic_pool", tokenCount: 500 },
      { turnIndex: 2, score: 0.8, tier: "semantic_pool", tokenCount: 500 },
    ];
    const result = selectTurns(scored, 100, 3, 5);
    // minTurns=3: TIER 1 = 1 turn, need 2 more from TIER 2
    // Both TIER 2 turns are included by minTurns even though budget is exceeded
    expect(result.includedTurnIndices.length).toBeGreaterThanOrEqual(3);
  });
});
