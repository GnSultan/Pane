/**
 * Live test of the voice MCP gateway — no audio session needed.
 * Exercises VoiceRelay.runTool("mcp_call") against a real MCP server,
 * exactly as the renderer would invoke it.
 */
import { VoiceRelay, VOICE_TOOLS, buildMcpCatalog } from "../src/main/voice-relay.mjs";
import { mcpClient } from "../src/main/mcp-client.mjs";

// The app calls preconnect() (fire-and-forget) at launch; standalone test
// must await the real connection — npx server spawn takes seconds.
await mcpClient.ensureConnected();
console.log("MCP connections:", [...mcpClient.connections.keys()].length);

const relay = new VoiceRelay();

// 1. mcp_call schema present
const mcpTool = VOICE_TOOLS.find((t) => t.name === "mcp_call");
console.log(mcpTool ? "✓ mcp_call schema in VOICE_TOOLS" : "✗ mcp_call missing from VOICE_TOOLS");

console.log("MCP tools indexed:", mcpClient.toolIndex.size);

// 3. Catalog builds
const catalog = buildMcpCatalog();
console.log("catalog lines:", catalog ? catalog.split("\n").length : 0);
if (catalog) console.log(catalog.split("\n").slice(0, 6).join("\n"));

// 4. Gateway validation — rejects non-ext names
const bad = await relay.runTool("test-proj", "/tmp", "mcp_call", { tool: "pane_recall", args: {} });
console.log("reject non-MCP name:", bad.success === false ? "✓" : "✗", JSON.stringify(bad).slice(0, 120));

// 5. Real gateway call — read-only calendar health
const good = await relay.runTool("test-proj", "/tmp", "mcp_call", {
  tool: "ext__apple-calendar__calendar_health",
  args: {},
});
console.log(
  "calendar_health via mcp_call:",
  good.success ? "✓" : "✗",
  JSON.stringify(good).slice(0, 300),
);

process.exit(0);
