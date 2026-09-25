/**
 * Pane MCP Gateway
 *
 * Constant-cost access to the full external tool surface. Three built-in
 * tools (mcp_search_tools / mcp_get_tool_schema / mcp_call_tool) let any
 * model reach every tool on every connected MCP server no matter how many
 * servers exist — the tools[] footprint stays 3 regardless of server count.
 *
 * Why this exists: OpenAI hard-caps tools[] at 128 entries (400
 * array_above_max_length, Sep 25 2026: 59 built-in + 410 MCP = 469 → every
 * request failed). Capping alone silently dropped whole servers. The gateway
 * makes the capped servers reachable: servers that fit the budget keep their
 * direct ext__ tools, the rest are reachable by exact name through
 * mcp_call_tool — identical wire behavior to a direct call, just one
 * indirection earlier.
 *
 * The pattern is ported from voice-relay's list_mcp_tools/mcp_call, which
 * proved the failure taxonomy (missing name / not-an-mcp-tool / not-in-index
 * / server-down) on the realtime voice path since Sep 1 2026.
 *
 * Dispatch architecture: tools[] is only an advertisement. Actual execution
 * goes through mcpClient.toolIndex, which holds every tool every connected
 * server reported — a tool missing from tools[] is still callable by name.
 * The gateway simply hands the executor a name the executor already knows
 * how to route.
 */

import { mcpClient } from "./mcp-client.mjs";

// ── Tool definitions (OpenAI function format, same shape as TOOL_DEFINITIONS) ──

export const MCP_GATEWAY_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "mcp_search_tools",
      description:
        "Search available MCP (external integration) tools by keyword across every connected server — " +
        "vercel, resend, notion, gmail, apple-calendar, figma, and any others. Returns matching tool names " +
        "with one-line descriptions, grouped by server. Use this FIRST whenever you need an external service " +
        "capability you don't see a direct tool for (deployments, emails, invoices, calendar, docs lookup…) — " +
        "many servers expose far more tools than fit in your tool list, and every one of them is callable " +
        "via mcp_call_tool. Search terms match tool names and descriptions (case-insensitive substring).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword or phrase to search for (e.g. 'deployment logs', 'invoice', 'send email', 'calendar event'). Matches tool names and descriptions.",
          },
          server: {
            type: "string",
            description:
              "Optional: restrict the search to one MCP server by name (e.g. 'vercel', 'resend').",
          },
          limit: {
            type: "integer",
            description:
              "Optional max results (default 30). Bounded so a broad query can't flood context.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_get_tool_schema",
      description:
        "Fetch the full JSON schema for one external MCP tool — its parameters, types, and description — " +
        "before calling it via mcp_call_tool. Use when a search hit looks right but the exact arguments " +
        "aren't clear from the one-line description. Returns the tool's complete input schema.",
      parameters: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description:
              "Exact namespaced tool name as returned by mcp_search_tools (e.g. 'ext__vercel__list_deployments').",
          },
        },
        required: ["tool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_call_tool",
      description:
        "Call any external MCP tool by exact namespaced name (ext__<server>__<tool>) with a JSON arguments " +
        "object. Wire-identical to calling the tool directly — use mcp_search_tools to find the name and " +
        "mcp_get_tool_schema to get its arguments if unsure. Prefer direct ext__ tools when they exist in " +
        "your tool list (one less indirection); use this gateway for tools not directly listed.",
      parameters: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description:
              "Exact namespaced tool name (e.g. 'ext__vercel__get_runtime_logs').",
          },
          args: {
            type: "object",
            description:
              "Arguments object for the tool, matching its schema (from mcp_get_tool_schema).",
          },
        },
        required: ["tool"],
      },
    },
  },
];

export const MCP_GATEWAY_TOOL_NAMES = new Set(
  MCP_GATEWAY_TOOL_DEFINITIONS.map((t) => t.function.name),
);

// ── Execution ──────────────────────────────────────────────────────────────

/** @param {string} s */
const clip = (s, n = 120) =>
  s == null ? "" : String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s);

/**
 * Execute a gateway tool call. Routed from tool-executor's executeTool before
 * the built-in switch — gateway names never collide with ext__ or built-ins.
 * @param {string} toolName one of the MCP_GATEWAY_TOOL_NAMES
 * @param {object} args parsed arguments
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export async function executeMcpGatewayTool(toolName, args) {
  const statuses = mcpClient.getStatus();

  if (toolName === "mcp_search_tools") {
    const query = (args?.query ?? "").trim().toLowerCase();
    const serverFilter = (args?.server ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(args?.limit) || 30, 1), 100);
    if (!query) {
      return {
        success: false,
        error: "No search query given. Pass 'query' (e.g. 'deployment logs', 'send email').",
      };
    }
    const tools = mcpClient.getExternalTools();
    if (!tools.length) {
      const lines = statuses.map((s) => `${s.name}: ${s.status}`);
      return {
        success: true,
        output: lines.length
          ? `MCP servers configured but none exposed tools — states: ${lines.join("; ")}. See Settings → MCP.`
          : "No MCP servers configured at all (see Settings → MCP).",
      };
    }
    // Search names AND descriptions — the user's mental model ("find
    // something about invoices") matches descriptions more than names.
    // Multi-word queries are token-based (every term must appear somewhere
    // in name+description). Each term tries both singular and plural forms
    // (naive trailing-s): "deployment logs" matches "deployments" in a
    // name/description, and "list deployments" matches "deployment" —
    // cheap stemming beats failing the search.
    const terms = query.split(/\s+/).filter(Boolean);
    const stem = (term) =>
      term.endsWith("s") && term.length > 3 ? term.slice(0, -1) : term;
    const termMatches = (haystack, term) => {
      const forms = term.endsWith("s") && term.length > 3
        ? [term, term.slice(0, -1)]
        : [term, term + "s"];
      return forms.some((f) => haystack.includes(f));
    };
    const hits = [];
    for (const t of tools) {
      const name = t.function.name;
      const server = name.split("__")[1] ?? "unknown";
      if (serverFilter && server !== serverFilter && !server.includes(serverFilter)) {
        continue;
      }
      const haystack = (name + " " + (t.function.description || "")).toLowerCase();
      if (terms.every((term) => termMatches(haystack, term))) {
        hits.push({ name, server, description: t.function.description });
      }
    }
    if (!hits.length) {
      const serverList = [...new Set(tools.map((t) => t.function.name.split("__")[1]))]
        .sort()
        .join(", ");
      return {
        success: true,
        output:
          `No MCP tools matching '${args.query}'${serverFilter ? ` on server '${args.server}'` : ""}. ` +
          `Connected servers: ${serverList}. Try a broader term, or another server name.`,
      };
    }
    const shown = hits.slice(0, limit);
    const byServer = new Map();
    for (const h of shown) {
      if (!byServer.has(h.server)) byServer.set(h.server, []);
      byServer.get(h.server).push(h);
    }
    const out = [...byServer.keys()].sort().map((s) => {
      const list = byServer
        .get(s)
        .map((h) => `  - ${h.name}: ${clip(h.description)}`)
        .join("\n");
      return `${s}:\n${list}`;
    });
    const more =
      hits.length > shown.length ? `\n(${hits.length - shown.length} more matches not shown — refine the query or raise 'limit'.)` : "";
    return {
      success: true,
      output: `${shown.length} of ${hits.length} matches:\n\n${out.join("\n\n")}${more}`,
    };
  }

  if (toolName === "mcp_get_tool_schema") {
    const target = (args?.tool ?? "").trim();
    if (!target) {
      return {
        success: false,
        error: "No tool name given. Pass 'tool' (e.g. 'ext__vercel__list_deployments') — use mcp_search_tools to find names.",
      };
    }
    const all = mcpClient.getExternalTools();
    const exact = all.find((t) => t.function.name === target);
    if (exact) {
      return {
        success: true,
        output: JSON.stringify(
          {
            name: exact.function.name,
            description: exact.function.description,
            parameters: exact.function.parameters,
          },
          null,
          2,
        ),
      };
    }
    // Not exact: nearest matches so the next call succeeds.
    const lower = target.toLowerCase();
    const near = all
      .filter(
        (t) =>
          t.function.name.toLowerCase().includes(lower) ||
          lower.includes(t.function.name.toLowerCase()),
      )
      .slice(0, 5)
      .map((t) => t.function.name);
    return {
      success: false,
      error: near.length
        ? `Unknown tool '${target}'. Closest: ${near.join(", ")}. Call mcp_search_tools if none of these is right.`
        : `Unknown tool '${target}'. Call mcp_search_tools to find the correct name.`,
    };
  }

  if (toolName === "mcp_call_tool") {
    const target = (args?.tool ?? "").trim();
    if (!target) {
      return {
        success: false,
        error:
          "No tool name given. Call mcp_search_tools first and pass an exact name as 'tool'.",
      };
    }
    if (!mcpClient.isExternalTool(target)) {
      // Not ext__-shaped at all — suggest the real name space.
      const near = mcpClient
        .getExternalTools()
        .map((t) => t.function.name)
        .filter((n) => {
          const s = target.toLowerCase();
          return n.toLowerCase().includes(s) || s.includes(n.toLowerCase());
        })
        .slice(0, 3);
      return {
        success: false,
        error: near.length
          ? `'${target}' is not an MCP tool. Closest: ${near.join(", ")}. Call mcp_search_tools for the full list.`
          : `'${target}' is not an MCP tool. External tool names start with 'ext__' (e.g. ext__notion__API-post-search). Call mcp_search_tools.`,
      };
    }
    const known = mcpClient.getExternalTools().map((t) => t.function.name);
    if (!known.includes(target)) {
      // ext__-shaped but not in the index: server lost connection after
      // discovery, or the name is close but wrong. Both need different
      // next actions, so distinguish them.
      const serverSegment = target.slice(0, target.lastIndexOf("__") + 2);
      const near = known
        .filter((n) => n.toLowerCase().startsWith(serverSegment.toLowerCase()))
        .slice(0, 3);
      const statusLine = statuses.map((s) => `${s.name}=${s.status}`).join(" ");
      return {
        success: false,
        error: near.length
          ? `Tool '${target}' is not currently available (server states: ${statusLine}). Closest: ${near.join(", ")}.`
          : `Tool '${target}' is not currently available (server states: ${statusLine}). Call mcp_search_tools to see what is connected.`,
      };
    }
    // Hand off to the same dispatch path direct ext__ calls use —
    // identical wire behavior, calendar augmentation, everything.
    return mcpClient.callTool(target, args?.args ?? {});
  }

  return {
    success: false,
    error: `Unknown gateway tool: ${toolName}`,
  };
}
