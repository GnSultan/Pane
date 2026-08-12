/**
 * MCP Client — connects Pane to external MCP servers (Figma, GitHub, etc.).
 *
 * Each configured server runs as a child process communicating over stdio
 * using JSON-RPC 2.0 (same protocol Pane's old server used, but reversed:
 * Pane is now the CLIENT connecting TO external servers).
 *
 * Lifecycle:
 *   1. User adds a server config in Profile → MCP Servers
 *   2. McpClientManager connects on next model turn (lazy — only when needed)
 *   3. On connect: initialize handshake → tools/list discovery
 *   4. Discovered tools are merged into the model's tool set
 *   5. When the model calls an external tool, McpClientManager routes it
 *
 * Config format (in ~/.pane/settings.json under "mcp_servers"):
 *   {
 *     "figma": {
 *       "command": "npx",
 *       "args": ["-y", "figma-developer-mcp", "--stdio"],
 *       "env": { "FIGMA_API_KEY": "fig_..." },
 *       "enabled": true
 *     }
 *   }
 *
 * Safety: all tool names from external servers are namespaced with the
 * server name to avoid collisions with Pane's built-in tools.
 * e.g. figma's "get_file" → "ext__figma__get_file"
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const PANE_DIR = path.join(os.homedir(), ".pane");
const SETTINGS_PATH = path.join(PANE_DIR, "settings.json");

/** Namespace prefix for external tools — prevents collisions with built-ins. */
const EXT_PREFIX = "ext__";

/** Timeout for server initialization handshake. */
const INIT_TIMEOUT_MS = 15_000;

/** Timeout for a single tool call to an external server. */
const CALL_TIMEOUT_MS = 30_000;

/** Timeout for tool list discovery. */
const LIST_TIMEOUT_MS = 10_000;

// ─── Types (JSDoc) ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} McpServerConfig
 * @property {string} command - The executable to run (e.g. "npx", "node")
 * @property {string[]} [args] - Arguments to pass to the command
 * @property {Record<string, string>} [env] - Environment variables for the process
 * @property {boolean} [enabled] - Whether this server is active (default true)
 */

/**
 * @typedef {Object} McpTool
 * @property {string} name - The namespaced tool name (ext__server__toolname)
 * @property {string} originalName - The tool name as the server reports it
 * @property {string} serverName - Which server owns this tool
 * @property {string} description - Tool description from the server
 * @property {object} inputSchema - JSON Schema for the tool's parameters
 */

/**
 * @typedef {Object} McpConnection
 * @property {string} name - Server name
 * @property {import("node:child_process").ChildProcess} proc - The child process
 * @property {readline.Interface} rl - readline over stdout
 * @property {Map<string, { resolve: Function, reject: Function }>} pending - Pending JSON-RPC requests
 * @property {boolean} initialized - Whether the handshake completed
 * @property {McpTool[]} tools - Discovered tools
 * @property {number} requestId - Next JSON-RPC request ID
 */

// ─── Singleton Manager ─────────────────────────────────────────────────────

class McpClientManager {
  constructor() {
    /** @type {Map<string, McpConnection>} */
    this.connections = new Map();
    /** @type {Map<string, McpTool>} toolIndex — namespaced name → tool */
    this.toolIndex = new Map();
    this._configCache = null;
    this._configCacheAt = 0;
  }

  // ── Config loading ──────────────────────────────────────────────────────

  /**
   * Load MCP server configs from settings.json.
   * Cached for 10 seconds to avoid disk reads on every turn.
   * @returns {Record<string, McpServerConfig>}
   */
  _loadConfig() {
    const now = Date.now();
    if (this._configCache && now - this._configCacheAt < 10_000) {
      return this._configCache;
    }
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      const settings = JSON.parse(raw);
      this._configCache = settings.mcp_servers || {};
    } catch {
      this._configCache = {};
    }
    this._configCacheAt = now;
    return this._configCache;
  }

  /** Invalidate the config cache (called when settings change). */
  invalidateConfig() {
    this._configCache = null;
    this._configCacheAt = 0;
  }

  /**
   * Get the list of enabled server names.
   * @returns {string[]}
   */
  _getEnabledServers() {
    const config = this._loadConfig();
    return Object.entries(config)
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(([name]) => name);
  }

  // ── Connection management ───────────────────────────────────────────────

  /**
   * Connect to a single MCP server.
   * Spawns the process, performs handshake, discovers tools.
   * @param {string} name - Server name
   * @param {McpServerConfig} cfg - Server config
   * @returns {Promise<McpConnection|null>}
   */
  async connect(name, cfg) {
    if (this.connections.has(name)) {
      return this.connections.get(name);
    }

    const proc = spawn(cfg.command, cfg.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(cfg.env || {}) },
      cwd: PANE_DIR,
    });

    const rl = readline.createInterface({ input: proc.stdout, terminal: false });
    /** @type {McpConnection} */
    const conn = {
      name,
      proc,
      rl,
      pending: new Map(),
      initialized: false,
      tools: [],
      requestId: 0,
    };

    // Wire up message handler
    rl.on("line", (line) => this._handleMessage(conn, line));

    proc.on("error", (err) => {
      console.error(`[mcp-client] Server "${name}" process error: ${err.message}`);
      this._rejectAll(conn, new Error(`Process error: ${err.message}`));
    });

    proc.on("exit", (code) => {
      console.log(`[mcp-client] Server "${name}" exited with code ${code}`);
      this._rejectAll(conn, new Error(`Server exited (code ${code})`));
      this.connections.delete(name);
      this._rebuildToolIndex();
    });

    proc.stderr?.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn(`[mcp-client] "${name}" stderr: ${msg.slice(0, 200)}`);
    });

    // Wait for stdout to be writable
    if (!proc.stdin.writable) {
      console.error(`[mcp-client] Server "${name}" stdin not writable`);
      return null;
    }

    // Perform handshake
    try {
      await this._sendRequest(conn, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "Pane", version: "0.4.169" },
      }, INIT_TIMEOUT_MS);

      // Send initialized notification (no response expected)
      this._sendNotification(conn, "notifications/initialized", {});

      // Discover tools
      const toolsResult = await this._sendRequest(conn, "tools/list", {}, LIST_TIMEOUT_MS);
      const tools = (toolsResult?.tools || []).map((t) => ({
        name: this._namespaceToolName(name, t.name),
        originalName: t.name,
        serverName: name,
        description: t.description || `Tool from ${name}`,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      }));

      conn.tools = tools;
      conn.initialized = true;
      this.connections.set(name, conn);
      this._rebuildToolIndex();

      console.log(`[mcp-client] Connected to "${name}": ${tools.length} tools discovered`);
      return conn;
    } catch (err) {
      console.error(`[mcp-client] Failed to connect to "${name}": ${err.message}`);
      try { proc.kill("SIGTERM"); } catch (killErr) { console.warn(`[mcp-client] Error killing failed "${name}": ${killErr.message}`); }
      return null;
    }
  }

  /**
   * Ensure all enabled servers are connected. Called before each model turn.
   * Connections are persistent — already-connected servers are skipped.
   * @returns {Promise<void>}
   */
  async ensureConnected() {
    const config = this._loadConfig();
    const enabled = this._getEnabledServers();

    // Disconnect any servers that were disabled or removed
    for (const name of this.connections.keys()) {
      if (!enabled.includes(name)) {
        this.disconnect(name);
      }
    }

    // Connect any missing servers (parallel)
    const toConnect = enabled.filter((n) => !this.connections.has(n));
    if (toConnect.length > 0) {
      await Promise.allSettled(
        toConnect.map((n) => this.connect(n, config[n]))
      );
    }
  }

  /**
   * Disconnect from a specific server.
   * @param {string} name
   */
  disconnect(name) {
    const conn = this.connections.get(name);
    if (!conn) return;
    this._rejectAll(conn, new Error("Disconnecting"));
    try { conn.proc.kill("SIGTERM"); } catch (err) { console.warn(`[mcp-client] Error killing "${name}": ${err.message}`); }
    this.connections.delete(name);
    this._rebuildToolIndex();
    console.log(`[mcp-client] Disconnected from "${name}"`);
  }

  /** Disconnect all servers (on app shutdown). */
  disconnectAll() {
    for (const name of this.connections.keys()) {
      this.disconnect(name);
    }
  }

  // ── Tool discovery ──────────────────────────────────────────────────────

  /**
   * Get all discovered tools from all connected servers, formatted for the
   * model's tool list (OpenAI function format).
   * @returns {Array<{ type: "function", function: { name: string, description: string, parameters: object } }>}
   */
  getExternalTools() {
    const tools = [];
    for (const tool of this.toolIndex.values()) {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    }
    return tools;
  }

  /**
   * Check if a tool name belongs to an external MCP server.
   * @param {string} toolName
   * @returns {boolean}
   */
  isExternalTool(toolName) {
    return toolName.startsWith(EXT_PREFIX);
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  /**
   * Call a tool on an external MCP server.
   * @param {string} namespacedName - The full namespaced tool name (ext__server__tool)
   * @param {object} input - Tool arguments
   * @returns {Promise<{ success: boolean, output?: string, error?: string }>}
   */
  async callTool(namespacedName, input) {
    const tool = this.toolIndex.get(namespacedName);
    if (!tool) {
      return { success: false, error: `Unknown external tool: ${namespacedName}` };
    }

    const conn = this.connections.get(tool.serverName);
    if (!conn || !conn.initialized) {
      return { success: false, error: `MCP server "${tool.serverName}" not connected` };
    }

    try {
      const result = await this._sendRequest(
        conn,
        "tools/call",
        { name: tool.originalName, arguments: input || {} },
        CALL_TIMEOUT_MS,
      );

      // MCP tools return content blocks — extract text
      const content = result?.content || [];
      const textParts = content
        .filter((c) => c.type === "text")
        .map((c) => c.text);
      const output = textParts.join("\n") || JSON.stringify(result);

      const isError = result?.isError === true;
      return {
        success: !isError,
        output: isError ? undefined : output,
        error: isError ? output : undefined,
      };
    } catch (err) {
      return { success: false, error: `MCP call failed: ${err.message}` };
    }
  }

  /**
   * Get a summary of connected servers and their tool counts (for UI).
   * @returns {Array<{ name: string, toolCount: number, status: string }>}
   */
  getStatus() {
    const config = this._loadConfig();
    /** @type {Array<{ name: string, toolCount: number, status: string }>} */
    const statuses = [];
    for (const [name, cfg] of Object.entries(config)) {
      const conn = this.connections.get(name);
      if (cfg.enabled === false) {
        statuses.push({ name, toolCount: 0, status: "disabled" });
      } else if (conn) {
        statuses.push({ name, toolCount: conn.tools.length, status: "connected" });
      } else {
        statuses.push({ name, toolCount: 0, status: "disconnected" });
      }
    }
    return statuses;
  }

  // ─── Internal: JSON-RPC over stdio ───────────────────────────────────────

  /**
   * Send a JSON-RPC request and await the response.
   * @param {McpConnection} conn
   * @param {string} method
   * @param {object} params
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  _sendRequest(conn, method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = String(++conn.requestId);
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      conn.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      try {
        conn.proc.stdin.write(msg + "\n");
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(new Error(`Failed to write to server stdin: ${err.message}`));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @param {McpConnection} conn
   * @param {string} method
   * @param {object} params
   */
  _sendNotification(conn, method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    try {
      conn.proc.stdin.write(msg + "\n");
    } catch (err) {
      console.warn(`[mcp-client] Failed to send notification "${method}": ${err.message}`);
    }
  }

  /**
   * Handle a line of output from a server's stdout (JSON-RPC response).
   * @param {McpConnection} conn
   * @param {string} line
   */
  _handleMessage(conn, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not JSON — likely a log line from the server, ignore
      return;
    }

    // Response to a request we sent
    if (msg.id !== undefined && conn.pending.has(msg.id)) {
      const pending = conn.pending.get(msg.id);
      conn.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || "Unknown MCP error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-initiated notification or request — log for now
    if (msg.method) {
      console.log(`[mcp-client] "${conn.name}" notification: ${msg.method}`);
    }
  }

  /** Reject all pending requests for a connection (on disconnect/error). */
  _rejectAll(conn, err) {
    for (const [, { reject }] of conn.pending) {
      reject(err);
    }
    conn.pending.clear();
  }

  /** Rebuild the flat tool index from all connections. */
  _rebuildToolIndex() {
    this.toolIndex.clear();
    for (const conn of this.connections.values()) {
      for (const tool of conn.tools) {
        this.toolIndex.set(tool.name, tool);
      }
    }
  }

  /**
   * Create a namespaced tool name to avoid collisions.
   * "figma" + "get_file" → "ext__figma__get_file"
   * @param {string} serverName
   * @param {string} toolName
   * @returns {string}
   */
  _namespaceToolName(serverName, toolName) {
    return `${EXT_PREFIX}${serverName}__${toolName}`;
  }

  /**
   * Parse a namespaced tool name back into server + original name.
   * @param {string} namespacedName
   * @returns {{ server: string, tool: string } | null}
   */
  _parseToolName(namespacedName) {
    if (!namespacedName.startsWith(EXT_PREFIX)) return null;
    const rest = namespacedName.slice(EXT_PREFIX.length);
    const sep = rest.indexOf("__");
    if (sep === -1) return null;
    return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
  }
}

// ─── Export singleton ──────────────────────────────────────────────────────

export const mcpClient = new McpClientManager();
