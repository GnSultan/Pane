import { describe, it, expect } from "vitest";
import { detectTurns, classifyTier, FRESH_DEPTH } from "../conversation-lifecycle.mjs";

// ── detectTurns ──────────────────────────────────────────────────────────────

describe("detectTurns", () => {
  it("returns empty array for empty messages", () => {
    expect(detectTurns([])).toEqual([]);
  });

  it("detects a single user+assistant turn", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ start: 0, end: 1, turnIndex: 0 });
  });

  it("detects a turn with tool calls between user and assistant", () => {
    const messages = [
      { role: "user", content: "Run a command" },
      { role: "tool", name: "run_shell", content: "output" },
      { role: "tool", name: "read_file", content: "file content" },
      { role: "assistant", content: "Done" },
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ start: 0, end: 3, turnIndex: 0 });
  });

  it("detects multiple consecutive turns", () => {
    const messages = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Second answer" },
      { role: "user", content: "Third question" },
      { role: "assistant", content: "Third answer" },
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(3);
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[1].turnIndex).toBe(1);
    expect(turns[2].turnIndex).toBe(2);
  });

  it("handles system messages at the start as a turn boundary", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const turns = detectTurns(messages);
    // detectTurns treats system + user as separate turn starters
    // System starts turn 0 (indices 0-0), User starts turn 1 (indices 1-2)
    expect(turns).toHaveLength(2);
    expect(turns[0].start).toBe(0);
    expect(turns[0].end).toBe(0);
    expect(turns[1].start).toBe(1);
    expect(turns[1].end).toBe(2);
  });

  it("supports getting correct start/end indices", () => {
    const messages = [
      { role: "user", content: "A" },
      { role: "tool", content: "result1" },
      { role: "assistant", content: "Answer A" },
      { role: "user", content: "B" },
      { role: "assistant", content: "Answer B" },
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].start).toBe(0);
    expect(turns[0].end).toBe(2);
    expect(turns[1].start).toBe(3);
    expect(turns[1].end).toBe(4);
  });
});

// ── classifyTier ──────────────────────────────────────────────────────────────

describe("classifyTier", () => {
  it("classifies most recent turns as fresh", () => {
    expect(classifyTier(0)).toBe("fresh");
    expect(classifyTier(FRESH_DEPTH - 1)).toBe("fresh");
  });

  it("classifies boundary turn correctly", () => {
    if (FRESH_DEPTH > 0) {
      // turn at FRESH_DEPTH index from end is RECENT
      expect(classifyTier(FRESH_DEPTH)).toBe("recent");
    }
  });

  it("classifies old turns as archival", () => {
    expect(classifyTier(20)).toBe("archival");
    expect(classifyTier(100)).toBe("archival");
  });

  it("classifies recent-but-not-fresh turns correctly", () => {
    // RECENT_DEPTH = FRESH_DEPTH + 7
    // So a turn at FRESH_DEPTH + 3 is recent, at FRESH_DEPTH + 7 is archival
    const recentMidPoint = FRESH_DEPTH + 3;
    expect(classifyTier(recentMidPoint)).toBe("recent");

    const archivalBoundary = FRESH_DEPTH + 7;
    expect(classifyTier(archivalBoundary)).toBe("archival");
  });
});
