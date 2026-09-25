import { describe, it, expect } from "vitest";
import {
  capToolsForProvider,
  OPENAI_TOOLS_CAP,
} from "../http-backend.mjs";

// Real-world shape (Sep 25 2026): 59 built-in Pane tools + 410 external MCP
// tools (vercel 212, resend 105, portfolio 27, notion 24, gmail 15,
// apple-calendar 13, zai-vision 8, figma 2, context7 2, fetch 1,
// sequential-thinking 1) = 469 — the exact number in OpenAI's rejection:
//   "Invalid 'tools': array too long. Expected an array with maximum length
//    128, but got an array with length 469 instead." (array_above_max_length)
const SERVERS = {
  "apple-calendar": 13,
  "context7": 2,
  fetch: 1,
  figma: 2,
  gmail: 15,
  notion: 24,
  portfolio: 27,
  resend: 105,
  "sequential-thinking": 1,
  vercel: 212,
  "zai-vision": 8,
};

function makeTools(builtInCount, servers = SERVERS) {
  const builtIns = Array.from({ length: builtInCount }, (_, i) => ({
    type: "function",
    function: { name: `built_in_${i}`, description: "core tool" },
  }));
  const externals = [];
  for (const [server, count] of Object.entries(servers)) {
    for (let i = 0; i < count; i++) {
      externals.push({
        type: "function",
        function: {
          name: `ext__${server}__tool_${i}`,
          description: `${server} tool`,
        },
      });
    }
  }
  return { builtIns, externals, all: [...builtIns, ...externals] };
}

describe("capToolsForProvider", () => {
  it("returns the list untouched when under the cap", () => {
    const { all } = makeTools(59, { figma: 2, fetch: 1 });
    const result = capToolsForProvider(all, OPENAI_TOOLS_CAP);
    expect(result.tools).toBe(all); // same reference — no copy, no notice
    expect(result.notice).toBeNull();
  });

  it("reproduces the Sep 25 failure: 469 tools capped to 128 with whole servers dropped", () => {
    const { builtIns, externals, all } = makeTools(59);
    expect(all.length).toBe(469); // guard the arithmetic itself

    const result = capToolsForProvider(all, OPENAI_TOOLS_CAP, (n) => `kept ${n}`);

    expect(result.tools.length).toBeLessThanOrEqual(OPENAI_TOOLS_CAP);
    // Whole-server drops can't land exactly on the cap. Budget walk (69
    // external slots, servers ascending): apple-calendar 13, context7 2,
    // fetch 1, figma 2, gmail 15, notion 24 = 57 used; portfolio (27 > 12)
    // drops; sequential-thinking 1 + zai-vision 8 fit the remainder = 66
    // externals kept → 59 + 66 = 125 total.
    expect(result.tools.length).toBe(125);

    // Every built-in survives — the core loop is never degraded
    for (const b of builtIns) {
      expect(result.tools).toContain(b);
    }

    // Whole servers kept or dropped — never split
    const names = new Set(result.tools.map((t) => t.function.name));
    for (const [server, count] of Object.entries(SERVERS)) {
      let kept = 0;
      for (let i = 0; i < count; i++) {
        if (names.has(`ext__${server}__tool_${i}`)) kept++;
      }
      expect([0, count]).toContain(kept);
    }

    // Small servers first: calendar, gmail, notion (Aslam's actual daily
    // integrations) survive; only the tool-count monsters drop.
    // 128 - 59 = 69 external budget:
    //   apple-calendar 13 + context7 2 + fetch 1 + figma 2 + gmail 15 +
    //   notion 24 = 57 fit; portfolio (27) overflows → dropped with the
    //   monsters (resend 105, sequential-thinking 1, vercel 212, zai-vision 8).
    expect(names.has("ext__gmail__tool_0")).toBe(true);
    expect(names.has("ext__notion__tool_0")).toBe(true);
    expect(names.has("ext__apple-calendar__tool_0")).toBe(true);
    expect(
      [...names].some((n) => n.startsWith("ext__vercel__")),
    ).toBe(false);
    expect(
      [...names].some((n) => n.startsWith("ext__portfolio__")),
    ).toBe(false);

    // Notice names the dropped servers and states the limit
    expect(result.notice).toContain("kept 66");
    expect(result.notice).toContain("128");
    expect(result.notice).toContain("vercel");
    expect(result.notice).toContain("resend");
    expect(result.notice).toContain("portfolio");
  });

  it("keeps smaller servers when the budget allows them", () => {
    // Budget: 128 - 59 built-ins = 69 externals. figma(2)+fetch(1)+
    // context7(2)+sequential-thinking(1)+gmail(15)+notion(24) = 45 ≤ 69 —
    // alphabetically-late servers fit and survive.
    const { all } = makeTools(59, {
      figma: 2,
      fetch: 1,
      gmail: 15,
      notion: 24,
      resend: 105,
      "sequential-thinking": 1,
      vercel: 212,
    });
    const result = capToolsForProvider(all, OPENAI_TOOLS_CAP);
    const names = new Set(result.tools.map((t) => t.function.name));
    expect(result.tools.length).toBeLessThanOrEqual(128);
    expect(names.has("ext__gmail__tool_0")).toBe(true);
    expect(names.has("ext__vercel__tool_0")).toBe(false);
  });

  it("is deterministic regardless of external connection order", () => {
    // toolIndex Map order is connection-timing-dependent — the helper must
    // produce the same server set no matter the input order. Built-ins keep
    // their original (static TOOL_DEFINITIONS) order; only externals are
    // reordered by the cap into alphabetical server order.
    const { builtIns, externals } = makeTools(59);
    const reversed = [...builtIns, ...[...externals].reverse()];
    const a = capToolsForProvider([...builtIns, ...externals], OPENAI_TOOLS_CAP);
    const b = capToolsForProvider(reversed, OPENAI_TOOLS_CAP);
    expect(new Set(b.tools.map((t) => t.function.name))).toEqual(
      new Set(a.tools.map((t) => t.function.name)),
    );
    // And externals within the kept set are in stable alphabetical order
    const keptNames = b.tools
      .map((t) => t.function.name)
      .filter((n) => n.startsWith("ext__"));
    expect(keptNames).toEqual([...keptNames].sort());
  });

  it("degrades to slicing built-ins when they alone exceed the cap", () => {
    const { builtIns } = makeTools(200, {});
    const result = capToolsForProvider(builtIns, 128, () => "");
    expect(result.tools.length).toBe(128);
    expect(result.notice).toContain("exceed the provider's 128-tool limit");
  });

  it("matches the exact error signature the heal branch matches on", () => {
    // The 400 handler matches: array_above_max_length OR
    // (array too long AND 'tools'). Pin the real provider message so a
    // provider-side wording change can't silently reopen the hole.
    const plainBody =
      '{"error":{"message":"Invalid \'tools\': array too long. Expected an array with maximum length 128, but got an array with length 469 instead.","type":"invalid_request_error","param":"tools","code":"array_above_max_length"}}';
    expect(plainBody.includes("array_above_max_length")).toBe(true);
    expect(
      plainBody.includes("array too long") &&
        plainBody.includes("'tools'"),
    ).toBe(true);
    // And the heal's max-length extraction
    const maxMatch = plainBody.match(/maximum length (\d+)/);
    expect(maxMatch?.[1]).toBe("128");
  });
});
