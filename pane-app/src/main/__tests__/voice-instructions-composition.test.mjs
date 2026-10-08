import { describe, it, expect } from "vitest";
import {
  buildMcpCatalog,
  VOICE_TOOLS,
} from "../voice-relay.mjs";

// Accent dilution fix (Aug 2026): the live session sounded American while
// the preview sounded British. Root cause: the 260-line MCP catalog was
// baked into session instructions (53% of a 42k-char blob), drowning the
// <1% accent block — large realtime instruction files are documented to
// lose adherence several turns in. Fix: catalog removed from instructions,
// discovery moved to an on-demand list_mcp_tools tool.
describe("voice instructions composition (accent dilution)", () => {
  it("exposes list_mcp_tools as a callable tool", () => {
    const names = VOICE_TOOLS.map((t) => t.name);
    expect(names).toContain("list_mcp_tools");
    const lmt = VOICE_TOOLS.find((t) => t.name === "list_mcp_tools");
    expect(lmt.parameters.type).toBe("object");
  });

  it("mcp_call still present — capability unchanged", () => {
    const names = VOICE_TOOLS.map((t) => t.name);
    expect(names).toContain("mcp_call");
  });

  it("instruction guidance points to list_mcp_tools, not a baked catalog", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../voice-relay.mjs", import.meta.url), "utf8");
    expect(src).toContain("Call list_mcp_tools to see the exact names");
    // The old baked-catalog composition must NOT return.
    expect(src).not.toContain('instructions + "\\n\\n## Connected MCP tools\\n"');
  });

  it("buildMcpCatalog still exported for the on-demand tool and tests", () => {
    expect(typeof buildMcpCatalog).toBe("function");
  });
});
