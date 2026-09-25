import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the MCP client singleton BEFORE the gateway module imports it —
// the gateway must be testable without spawning real servers.
vi.mock("../mcp-client.mjs", () => {
  const tools = [
    { type: "function", function: { name: "ext__vercel__list_deployments", description: "List deployments under the authenticated user or team. If a deployment hasn't finished uploading", parameters: {} } },
    { type: "function", function: { name: "ext__vercel__get_runtime_logs", description: "Get runtime logs for a project or deployment. Runtime logs show application output", parameters: {} } },
    { type: "function", function: { name: "ext__resend__send-email", description: "Send a single transactional email to one or more recipients immediately", parameters: {} } },
    { type: "function", function: { name: "ext__notion__API-post-search", description: "Search by title", parameters: {} } },
  ];
  return {
    mcpClient: {
      getExternalTools: () => tools,
      getStatus: () => [
        { name: "vercel", toolCount: 2, status: "connected" },
        { name: "resend", toolCount: 1, status: "connected" },
        { name: "notion", toolCount: 1, status: "connected" },
        { name: "broken-server", toolCount: 0, status: "failed" },
      ],
      isExternalTool: (name) => name.startsWith("ext__"),
      callTool: vi.fn(async (name, args) => ({
        success: true,
        output: `called ${name} ${JSON.stringify(args)}`,
      })),
    },
  };
});

import {
  MCP_GATEWAY_TOOL_DEFINITIONS,
  MCP_GATEWAY_TOOL_NAMES,
  executeMcpGatewayTool,
} from "../mcp-gateway.mjs";
import { mcpClient } from "../mcp-client.mjs";

const REAL_SERVERS = {
  vercel: 212,
  resend: 105,
};

describe("MCP gateway tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defines exactly the 3 gateway tools with valid schemas", () => {
    expect(MCP_GATEWAY_TOOL_DEFINITIONS.length).toBe(3);
    for (const t of MCP_GATEWAY_TOOL_DEFINITIONS) {
      expect(t.type).toBe("function");
      expect(t.function.name).toMatch(/^mcp_/);
      expect(Array.isArray(t.function.parameters.required)).toBe(true);
      expect(typeof t.function.description).toBe("string");
    }
    expect([...MCP_GATEWAY_TOOL_NAMES]).toEqual(
      expect.arrayContaining([
        "mcp_search_tools",
        "mcp_get_tool_schema",
        "mcp_call_tool",
      ]),
    );
  });

  it("mcp_search_tools matches names AND descriptions, grouped by server", async () => {
    // AND over terms: "deployment logs" requires both tokens, so only
    // get_runtime_logs matches (its description has "deployment", its name
    // has "logs"). list_deployments has no "log" token anywhere.
    const r = await executeMcpGatewayTool("mcp_search_tools", { query: "deployment logs" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("ext__vercel__get_runtime_logs");
    expect(r.output).toContain("vercel:");
    expect(r.output).not.toContain("ext__resend__");
    // Single term "deployments" finds the name via plural/singular stem
    const r2 = await executeMcpGatewayTool("mcp_search_tools", { query: "deployments" });
    expect(r2.success).toBe(true);
    expect(r2.output).toContain("ext__vercel__list_deployments");
  });

  it("mcp_search_tools server filter restricts to one server", async () => {
    const r = await executeMcpGatewayTool("mcp_search_tools", {
      query: "email",
      server: "resend",
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain("ext__resend__send-email");
    expect(r.output).not.toContain("ext__vercel__");
  });

  it("mcp_search_tools with no matches explains and lists servers", async () => {
    const r = await executeMcpGatewayTool("mcp_search_tools", { query: "kubernetes helm chart" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("No MCP tools matching");
    // Server list is alphabetical — notion, resend, vercel
    expect(r.output).toContain("notion, resend, vercel");
  });

  it("mcp_search_tools with empty query fails with guidance", async () => {
    const r = await executeMcpGatewayTool("mcp_search_tools", {});
    expect(r.success).toBe(false);
    expect(r.error).toContain("No search query given");
  });

  it("mcp_get_tool_schema returns the full schema", async () => {
    const r = await executeMcpGatewayTool("mcp_get_tool_schema", {
      tool: "ext__vercel__get_runtime_logs",
    });
    expect(r.success).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.name).toBe("ext__vercel__get_runtime_logs");
    expect(parsed.description).toContain("runtime logs");
    expect(parsed.parameters).toEqual({});
  });

  it("mcp_get_tool_schema suggests near matches on unknown name", async () => {
    const r = await executeMcpGatewayTool("mcp_get_tool_schema", {
      tool: "ext__vercel__list_deployments_typo",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Closest");
    expect(r.error).toContain("ext__vercel__list_deployments");
  });

  it("mcp_call_tool dispatches to mcpClient.callTool with args", async () => {
    const r = await executeMcpGatewayTool("mcp_call_tool", {
      tool: "ext__resend__send-email",
      args: { to: "a@b.com" },
    });
    expect(r.success).toBe(true);
    expect(mcpClient.callTool).toHaveBeenCalledWith(
      "ext__resend__send-email",
      { to: "a@b.com" },
    );
  });

  it("mcp_call_tool failure taxonomy: missing name / not-an-mcp-tool / not-in-index", async () => {
    // 1. missing
    const missing = await executeMcpGatewayTool("mcp_call_tool", {});
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("No tool name given");
    // 2. not ext__-shaped
    const notMcp = await executeMcpGatewayTool("mcp_call_tool", { tool: "run_shell_command" });
    expect(notMcp.success).toBe(false);
    expect(notMcp.error).toContain("not an MCP tool");
    // 3. ext__-shaped but not in index
    const notKnown = await executeMcpGatewayTool("mcp_call_tool", {
      tool: "ext__vercel__nope_never_existed",
    });
    expect(notKnown.success).toBe(false);
    expect(notKnown.error).toContain("not currently available");
    expect(notKnown.error).toContain("vercel=connected");
  });

  it("unknown gateway tool name errors cleanly", async () => {
    const r = await executeMcpGatewayTool("mcp_nonsense", {});
    expect(r.success).toBe(false);
    expect(r.error).toContain("Unknown gateway tool");
  });
});
