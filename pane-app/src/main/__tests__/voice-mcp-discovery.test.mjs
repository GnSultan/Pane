import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { voiceRelay } from "../voice-relay.mjs";
import { mcpClient } from "../mcp-client.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Test fixtures ─────────────────────────────────────────────────────────
// mcpClient is a singleton over connections + a settings-derived config.
// We seed its internal state directly (connections/toolIndex mirror what
// connectAll() builds) so tests never spawn real MCP server processes.
// A tmp settings.json feeds the stubbed _loadConfig so getStatus()
// reflects fixture servers instead of the developer's real configuration.

function seedClient({ tools = {}, statuses = {} } = {}) {
  // toolIndex: name -> { name, serverName, originalName, description, inputSchema }
  mcpClient.toolIndex = new Map(
    Object.entries(tools).map(([name, desc]) => [
      name,
      {
        name,
        serverName: name.split("__")[1] ?? "unknown",
        originalName: name.split("__").slice(2).join("__"),
        description: desc,
        inputSchema: { type: "object", properties: {} },
      },
    ]),
  );
  // connections: name -> { initialized, tools } (shape used by getStatus)
  mcpClient.connections = new Map(
    Object.entries(statuses).map(([server, toolCount]) => [
      server,
      { initialized: true, tools: new Array(toolCount) },
    ]),
  );
}

let fixture = null;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pane-mcp-test-"));
  const settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcp_servers: {
        "apple-calendar": { enabled: true },
        notion: { enabled: true },
        figma: { enabled: false },
      },
    }),
  );
  fixture = { tmp, settingsPath, realLoadConfig: mcpClient._loadConfig };
  // SETTINGS_PATH is module-const; stub the loader for hermetic tests.
  // Read through the mutable fixture — tests may repoint settingsPath.
  mcpClient._loadConfig = () => {
    try {
      return JSON.parse(fs.readFileSync(fixture.settingsPath, "utf8")).mcp_servers;
    } catch {
      return {};
    }
  };
});

afterEach(() => {
  if (fixture?.realLoadConfig) mcpClient._loadConfig = fixture.realLoadConfig;
  if (fixture?.tmp) fs.rmSync(fixture.tmp, { recursive: true, force: true });
  fixture = null;
});

// ── 1. Discovery from the voice relay ────────────────────────────────────

describe("voice list_mcp_tools (discovery)", () => {
  it("returns calendar tools grouped by server with descriptions", async () => {
    seedClient({
      tools: {
        "ext__apple-calendar__calendar_list_events": "List calendar events in a time window.",
        "ext__apple-calendar__calendar_create_event": "Create a new event.",
        "ext__notion__API-post-search": "Search by title.",
      },
      statuses: { "apple-calendar": 2, notion: 1 },
    });
    const res = await voiceRelay.runTool("proj1", "/tmp", "list_mcp_tools", {});
    expect(res.success).toBe(true);
    expect(res.output).toContain("apple-calendar:");
    expect(res.output).toContain("ext__apple-calendar__calendar_list_events");
    expect(res.output).toContain("List calendar events in a time window.");
    expect(res.output).toContain("ext__notion__API-post-search");
  });

  it("server filter narrows discovery to that server only", async () => {
    seedClient({
      tools: {
        "ext__apple-calendar__calendar_list_events": "List events.",
        "ext__notion__API-post-search": "Search.",
      },
      statuses: { "apple-calendar": 1, notion: 1 },
    });
    const res = await voiceRelay.runTool("proj1", "/tmp", "list_mcp_tools", {
      server: "calendar",
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("ext__apple-calendar__calendar_list_events");
    expect(res.output).not.toContain("ext__notion__API-post-search");
  });

  it("explains WHY discovery is empty: disabled and disconnected servers named", async () => {
    seedClient({ tools: {}, statuses: {} }); // nothing connected
    const res = await voiceRelay.runTool("proj1", "/tmp", "list_mcp_tools", {});
    expect(res.success).toBe(true);
    // apple-calendar/notion are enabled in config but have no live
    // connection → "disconnected"; figma is disabled in config.
    expect(res.output).toContain("apple-calendar: disconnected");
    expect(res.output).toContain("notion: disconnected");
    expect(res.output).toContain("figma: disabled");
  });

  it("names not-exposing servers when a filter matches a disconnected one", async () => {
    seedClient({
      tools: { "ext__notion__API-post-search": "Search." },
      statuses: { notion: 1 },
    });
    const res = await voiceRelay.runTool("proj1", "/tmp", "list_mcp_tools", {
      server: "apple-calendar",
    });
    expect(res.success).toBe(true);
    expect(res.output).toContain("No MCP tools matching 'apple-calendar'");
    expect(res.output).toContain("apple-calendar (disconnected)");
  });

  it("returns precise environment guidance when nothing is configured", async () => {
    fixture.settingsPath = path.join(fixture.tmp, "missing.json"); // loader hits catch → {}
    seedClient({ tools: {}, statuses: {} });
    const res = await voiceRelay.runTool("proj1", "/tmp", "list_mcp_tools", {});
    expect(res.success).toBe(true);
    expect(res.output).toContain("No MCP servers configured");
    expect(res.output).toContain("Settings → MCP");
  });
});

// ── 2. Missing / malformed tool calls ─────────────────────────────────────

describe("voice mcp_call error taxonomy", () => {
  beforeEach(() => {
    seedClient({
      tools: {
        "ext__apple-calendar__calendar_list_events": "List events.",
        "ext__apple-calendar__calendar_create_event": "Create event.",
      },
      statuses: { "apple-calendar": 2 },
    });
  });

  it("blank tool name → tells the model to run discovery first", async () => {
    const res = await voiceRelay.runTool("proj1", "/tmp", "mcp_call", { args: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain("list_mcp_tools");
  });

  it("non-ext name → nearest matches offered", async () => {
    const res = await voiceRelay.runTool("proj1", "/tmp", "mcp_call", {
      tool: "calendar_list_events",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Closest:");
    expect(res.error).toContain("ext__apple-calendar__calendar_list_events");
  });

  it("ext__-shaped but unknown → server states surfaced", async () => {
    const res = await voiceRelay.runTool("proj1", "/tmp", "mcp_call", {
      tool: "ext__apple-calendar__calendar_delete_everything",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Server states:");
    expect(res.error).toContain("apple-calendar=connected");
  });

  it("whitelist still rejects unknown internal tools precisely", async () => {
    const res = await voiceRelay.runTool("proj1", "/tmp", "run_shell_command", {});
    expect(res.success).toBe(false);
    expect(res.error).toContain("not available to voice");
  });
});

// ── 3. Successful calendar discovery → basic call ─────────────────────────

describe("voice mcp_call happy path (calendar)", () => {
  it("executes a calendar tool end-to-end through the executor", async () => {
    seedClient({
      tools: {
        "ext__apple-calendar__calendar_list_events": "List events.",
      },
      statuses: { "apple-calendar": 1 },
    });
    // Stub the single downstream hop: the executor's ext-tool branch calls
    // mcpClient.callTool — the relay's executor routing is what we test.
    const origCallTool = mcpClient.callTool;
    const calls = [];
    mcpClient.callTool = async (name, input) => {
      calls.push({ name, input });
      return { success: true, output: "Sep 2, 09:00 — Standup (Home)" };
    };
    try {
      const res = await voiceRelay.runTool("proj1", "/tmp", "mcp_call", {
        tool: "ext__apple-calendar__calendar_list_events",
        args: { start_iso: "2026-09-02T00:00:00Z", end_iso: "2026-09-03T00:00:00Z" },
      });
      expect(res.success).toBe(true);
      expect(res.output).toContain("Standup");
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("ext__apple-calendar__calendar_list_events");
      expect(calls[0].input.start_iso).toBe("2026-09-02T00:00:00Z");
    } finally {
      mcpClient.callTool = origCallTool;
    }
  });
});

// ── 4. Contract guard: renderer dispatcher vs main VOICE_TOOLS ────────────

describe("renderer/main tool contract (drift regression)", () => {
  it("VOICE_TOOLS routes every tool the session offers via voice_tool_call", async () => {
    const fsx = await import("node:fs");
    const src = fsx.readFileSync(
      new URL("../../renderer/hooks/useRealtimeVoice.ts", import.meta.url),
      "utf8",
    );
    // The drift that broke discovery: a hardcoded local-only list. The
    // dispatcher must default-route to main instead of rejecting.
    expect(src).not.toContain("unknown function ${name}");
    expect(src).toContain("voice_tool_call");
  });

  it("VOICE_TOOLS and the relay whitelist stay in sync for knowledge tools", async () => {
    const fsx = await import("node:fs");
    const src = fsx.readFileSync(
      new URL("../voice-relay.mjs", import.meta.url),
      "utf8",
    );
    expect(src).toContain('name: "list_mcp_tools"');
    expect(src).toContain('name: "mcp_call"');
    expect(src).toContain('name: "agent_threads"');
    // Discovery instructions must not point at the deleted catalog section.
    expect(src).not.toContain("under 'Connected MCP tools'");
  });
});
