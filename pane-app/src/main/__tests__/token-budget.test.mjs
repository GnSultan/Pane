import { describe, it, expect } from "vitest";
import {
  classifyContent,
  estimateTokens,
  getModelLimit,
  getDefaultOutputBudget,
  RATIOS,
} from "../token-budget.mjs";

// ── classifyContent ──────────────────────────────────────────────────────────

describe("classifyContent", () => {
  it("returns 'compact' for empty or short text", () => {
    expect(classifyContent("")).toBe("compact");
    expect(classifyContent(null)).toBe("compact");
    expect(classifyContent("short")).toBe("compact");
    expect(classifyContent("a".repeat(19))).toBe("compact");
  });

  it("returns 'json' for JSON-heavy text", () => {
    const json = JSON.stringify({ name: "test", value: 42, items: [1, 2, 3] }, null, 2);
    expect(classifyContent(json)).toBe("json");
  });

  it("returns 'code' for code-heavy text", () => {
    const code = `function hello() {\n  const x = 1;\n  return x;\n}`;
    expect(classifyContent(code)).toBe("code");
  });

  it("returns 'markdown' for markdown-heavy text", () => {
    const md = `# Title\n\n## Section\n\n**bold** text with *italic* and \`code\``;
    expect(classifyContent(md)).toBe("markdown");
  });

  it("returns 'prose' for plain English text", () => {
    const prose = "The quick brown fox jumps over the lazy dog. This is a regular English sentence that should be classified as prose rather than code or markdown.";
    expect(classifyContent(prose)).toBe("prose");
  });
});

// ── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it("estimates prose tokens correctly", () => {
    // prose ratio is 3.7 chars/token
    const prose = "This is a moderately long English sentence used for testing token estimation accuracy across different content types.";
    const expected = Math.ceil(prose.length / RATIOS.prose);
    expect(estimateTokens(prose)).toBe(expected);
  });

  it("estimates code tokens correctly", () => {
    const code = "function hello() {\n  const x = 1;\n  return x;\n}";
    const expected = Math.ceil(code.length / RATIOS.code);
    expect(estimateTokens(code)).toBe(expected);
  });

  it("estimates JSON tokens correctly", () => {
    const json = JSON.stringify({ name: "test", items: [1, 2, 3] });
    const expected = Math.ceil(json.length / RATIOS.json);
    expect(estimateTokens(json)).toBe(expected);
  });

  it("estimates compact tokens correctly", () => {
    const compact = "short text";
    const expected = Math.ceil(compact.length / RATIOS.compact);
    expect(estimateTokens(compact)).toBe(expected);
  });
});

// ── getModelLimit ────────────────────────────────────────────────────────────

describe("getModelLimit", () => {
  it("returns correct limit for model with Claude provider heuristic", () => {
    const limit = getModelLimit("claude-sonnet-4-20250514");
    // Falls through to provider heuristic: includes "claude" → 1000000
    expect(limit).toBe(1000000);
  });

  it("uses exact match for fully-qualified model names", () => {
    const limit = getModelLimit("claude-sonnet-4-6");
    expect(limit).toBe(1000000);
  });

  it("uses provider heuristic for model families", () => {
    const limit = getModelLimit("deepseek-coder");
    // No exact or prefix match in MODEL_CONTEXT_LIMITS.
    // Falls through to provider heuristic: includes("deepseek") → 1M.
    expect(limit).toBe(1000000);
  });

  it("falls back to 128k for unknown model", () => {
    const limit = getModelLimit("unknown-model-xyz");
    expect(limit).toBe(128000);
  });
});

// ── getDefaultOutputBudget ───────────────────────────────────────────────────

describe("getDefaultOutputBudget", () => {
  it("returns budget for known model", () => {
    // "deepseek" family returns 8192 (conservative fallback for budget estimation)
    const budget = getDefaultOutputBudget("deepseek-v4-flash");
    expect(budget).toBe(8192);
  });

  it("falls back to 8192 for unknown models", () => {
    const budget = getDefaultOutputBudget("unknown-model");
    expect(budget).toBe(8192);
  });
});
