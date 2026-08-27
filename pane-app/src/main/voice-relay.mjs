/**
 * Voice Relay — OpenAI Realtime session broker for the always-on voice layer.
 *
 * Architecture (decided Aug 2026 — see project memory "voice architecture pivot"):
 *   - The voice assistant is a RELAY, not an implementer. It converses with the
 *     user, shares the same brain (identity, about, playbook, knowledge tools)
 *     as the main agent, and delegates execution via delegate_task which fires
 *     into the real agent pipeline (sendToPunk) from the renderer.
 *   - The OpenAI API key NEVER enters the renderer. This module mints a
 *     short-lived ephemeral token (~1 min TTL) via /v1/realtime/client_secrets
 *     and the renderer opens the WebRTC session with only that token.
 *   - Knowledge tools (pane_recall, read_file, ...) execute here in the main
 *     process through the SAME ToolExecutor the agent uses — read-only subset.
 *
 * Nothing here streams audio. WebRTC carries audio renderer↔OpenAI directly;
 * this process only brokers tokens and executes tool calls.
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { ToolExecutor } from "./tool-executor.mjs";
import { mcpClient } from "./mcp-client.mjs";
import { orchestrateContext } from "./context-orchestrator.mjs";
import { getAccessToken as getOpenAIAccessToken } from "./openai-oauth.mjs";
import { readActivities } from "./intents.mjs";
import {
  journalExchange,
  recallConversations,
  distillCompanionMemory,
  getCompanionBlock,
} from "./companion-memory.mjs";

const { fetch } = globalThis;

const OPENAI_REALTIME_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const REALTIME_MODEL = "gpt-realtime-2.1";
// Verified against the live realtime-conversations guide (Aug 2026):
// current realtime voice options. marin/cedar recommended by OpenAI.
export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
];
const DEFAULT_VOICE = "marin";

// OpenAI voices are persona presets, not accent variants — there is no
// native British voice (confirmed against live docs + OpenAI forum, Aug 2026).
// Accent is steered instead via session instructions on gpt-realtime, which
// shifts delivery while keeping the chosen voice's timbre.
const ACCENT_INSTRUCTIONS = {
  none: "",
  british:
    "Speak with a natural British RP accent at all times. Non-rhotic: drop the r in 'water', 'hard', 'letter' unless a vowel follows. " +
    "Long broad a in 'can't', 'dance', 'example', 'ask'. British vowels: 'schedule' as SHED-yool, 'lieutenant' as lef-TEN-ant. " +
    "Understated, even pace — never caricature or stage-British.",
};

/** Read the user's chosen voice + accent from settings.json (voice_settings). */
async function readVoiceSetting() {
  try {
    const content = await fs.readFile(path.join(os.homedir(), ".pane", "settings.json"), "utf-8");
    const settings = JSON.parse(content);
    const v = settings?.voice_settings?.voice;
    const a = settings?.voice_settings?.accent;
    return {
      voice: REALTIME_VOICES.includes(v) ? v : DEFAULT_VOICE,
      accent: a === "british" ? "british" : "none",
    };
  } catch {
    return { voice: DEFAULT_VOICE, accent: "none" };
  }
}

// Read-only tools the voice assistant may execute through the shared ToolExecutor.
// No writes, no shell, no git mutations — voice observes and converses, never implements.
const VOICE_TOOL_WHITELIST = new Set([
  "pane_recall",
  "pane_recall_all",
  "pane_brief",
  "pane_knowledge_graph",
  "pane_find_symbol",
  "pane_find_references",
  "pane_get_project_map",
  "pane_get_recent_changes",
  "pane_get_session_state",
  "pane_read_journal",
  "read_file",
  "pane_read_files",
  "glob",
  "grep_search",
  "pane_project_context",
  "pane_check_intents",
  "pane_profile",
  "web_fetch",
  "google_web_search",
  "pane_lens_findings",
  "pane_cross_project",
]);

/**
 * Compact MCP tool catalog for the voice model's instructions — name plus
 * first line of description per tool, grouped by server. Full schemas stay
 * out of context; the model references tools by exact name via mcp_call.
 * Bounded to 150 lines so a huge MCP surface can't blow up instructions.
 */
export function buildMcpCatalog() {
  try {
    const tools = mcpClient.getExternalTools();
    if (!tools.length) return "";
    const byServer = new Map();
    for (const t of tools) {
      // name is "ext__server__tool" — split off the server segment.
      const parts = t.function.name.split("__");
      const server = parts[1] ?? "unknown";
      if (!byServer.has(server)) byServer.set(server, []);
      byServer.get(server).push(t);
    }
    // Deterministic order — iteration used to follow Map insertion order,
    // which is connection-timing-dependent. With more tools than the line
    // cap, whole servers at the tail (apple-calendar) silently vanished
    // from the model's instructions. Alphabetical order is stable and
    // puts the truncation point in a predictable place.
    const servers = [...byServer.keys()].sort();
    const MAX_LINES = 260;
    const lines = [];
    let truncated = 0;
    for (const server of servers) {
      lines.push(`${server}:`);
      for (const t of byServer.get(server)) {
        const first = (t.function.description || "").split("\n")[0].slice(0, 70);
        if (lines.length >= MAX_LINES) {
          truncated++;
          continue;
        }
        lines.push(`  - ${t.function.name} — ${first}`);
      }
    }
    if (truncated > 0) {
      lines.push(`  (+${truncated} tools omitted — line budget reached)`);
    }
    return lines.join("\n");
  } catch (err) {
    console.warn("[voice] MCP catalog build failed:", err?.message || err);
    return "";
  }
}

// Realtime function-tool schemas exposed to the voice model (flattened
// Realtime shape: { type, name, description, parameters } — no .function nest).
export const VOICE_TOOLS = [
  {
    type: "function",
    name: "delegate_task",
    description:
      "Hand a fully-formed instruction to the coding agent so it starts working. " +
      "Call this when the user says to go ahead, build it, do it, fix it, or otherwise " +
      "signals execution. The agent runs with full tools (edit files, run commands). " +
      "Assemble everything discussed — the agent does NOT hear this conversation, " +
      "so the instruction must be complete and self-contained.",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "Complete, self-contained instruction for the agent. Include all context the agent needs.",
        },
        phase: {
          type: "string",
          enum: ["think", "build"],
          description: "'think' explores/plans (thinking model), 'build' executes (execution model). Default 'build'.",
        },
      },
      required: ["instruction"],
    },
  },
  {
    type: "function",
    name: "get_agent_status",
    description:
      "Check whether the coding agent is currently running and what it is doing. " +
      "Use when the user asks how it's going, what's happening, or whether it finished.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "run_knowledge_tool",
    description:
      "Execute a read-only Pane knowledge tool to look something up. Available: " +
      "pane_recall (search project memory), pane_brief (project brief), read_file, " +
      "pane_find_symbol, pane_get_project_map, pane_get_recent_changes, grep_search, " +
      "glob, pane_knowledge_graph, pane_profile, web_fetch, google_web_search.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Tool name from the allowed list, e.g. 'pane_recall'.",
        },
        args: {
          type: "object",
          description: "Arguments object for the tool, e.g. { query: 'auth refactor' }.",
        },
      },
      required: ["tool"],
    },
  },
  {
    type: "function",
    name: "mcp_call",
    description:
      "Call an external tool from Pane's MCP servers (Calendar, Notion, Gmail, " +
      "Figma, Resend, Vercel, …). The exact tool names are listed in your " +
      "instructions under 'Connected MCP tools'. Use them directly for real-world " +
      "actions: check/add calendar events, search or update Notion, search mail, " +
      "send email, manage projects. Never invent a tool name — pick from the list.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "Exact tool name from the MCP list, e.g. 'ext__apple-calendar__calendar_list_events'.",
        },
        args: {
          type: "object",
          description: "Arguments object matching the tool's parameters.",
        },
      },
      required: ["tool"],
    },
  },
  {
    type: "function",
    name: "workspace_state",
    description:
      "Snapshot of Pane's workspace, on demand. Use when the user asks about " +
      "threads, projects, activity, or anything 'how many / what's running'. " +
      "Returns: thread list with per-thread agent status and last activity, " +
      "message counts, peer threads on the current project.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "look_at_screen",
    description:
      "Capture the Pane window and SEE it. Call when the user references " +
      "something visible ('this file', 'that error', 'the layout', 'what am I " +
      "looking at') or asks for visual judgment. The screenshot enters the " +
      "conversation as an image you can inspect. Costs tokens — call when " +
      "warranted, not reflexively.",
    parameters: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          enum: ["low", "high"],
          description: "'low' for layout/structure questions, 'high' for reading small text. Default 'low'.",
        },
      },
    },
  },
  {
    type: "function",
    name: "recall_conversation",
    description:
      "Search the exact record of past voice conversations with Aslam — your own " +
      "memory of talking together, not project memory. Exact keyword match over " +
      "every spoken exchange, newest first. Use when he references something you " +
      "discussed before ('remember when I said...', 'that thing from last week') " +
      "and your distilled memory doesn't cover it, or when you need the precise " +
      "words/context. Project facts live in project memory (pane_recall), not here.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Distinctive words from the conversation. e.g. 'voice orb glow colors'",
        },
        days_back: {
          type: "number",
          "description": "Optional: only search the last N days.",
        },
      },
      required: ["query"],
    },
  },
];

/**
 * Voice system instructions — built ON TOP of the shared brain context.
 * The relay role is layered after orchestrateContext() output so voice
 * literally reads the same identity/about/playbook as the agent.
 */
function buildVoiceInstructions(sharedContext, agentStatusLine) {
  return (
    sharedContext +
    "\n\n## Your role — the voice layer\n\n" +
    "You are the conversational voice of Pane. The user talks to you in real time; " +
    "a separate coding agent does the actual work. You share the agent's brain — " +
    "the identity, project context, and playbook above are yours too — but you have " +
    "NO ability to edit files or run commands yourself.\n\n" +
    "Your job:\n" +
    "- Listen, discuss, answer questions about the project using the knowledge tools.\n" +
    "- Help the user think through what they want before committing to building it.\n" +
    "- Workspace awareness: a [workspace] line is injected into your context as " +
    "things change (thread count, running agents, open file). For deeper detail " +
    "call workspace_state — it returns every thread with names, activity, and " +
    "message counts. When the user asks 'how many threads', 'what's running', " +
    "'what was I doing in X' — call workspace_state, don't guess.\n" +
    "- Sight: you can see the Pane window. When the user references something " +
    "visible ('this file', 'that error', 'the layout') call look_at_screen and " +
    "the screenshot enters the conversation. Use it when warranted — every " +
    "glance costs image tokens.\n" +
    "- When the user signals execution — \"okay let's do it\", \"go ahead\", \"build that\" — " +
    "assemble the complete instruction and call delegate_task. Natural conversation, " +
    "no confirmation ritual: if the user told you to do it, delegate.\n\n" +
    "Delegation rules:\n" +
    "- The agent cannot hear this conversation. Your instruction must carry ALL of it: " +
    "goal, constraints, files discussed, decisions made.\n" +
    "- If the user's ask is ambiguous about scope, ask one clarifying question — " +
    "then delegate. Don't interrogate.\n" +
    "- After delegating, tell the user the agent is on it, and keep watching. " +
    "You can relay corrections mid-run: just include them in a new delegate_task call.\n" +
    "- Speaking style: match Aslam — direct, no filler, no corporate tone.\n\n" +
    "You also have your own memory of past conversations with Aslam (injected " +
    "above when it exists) and the recall_conversation tool to search the exact " +
    "record of what was said before. If he references something from days ago, " +
    "search for it — never guess and never pretend to remember what you can't " +
    "find.\n\n" +
    "External world access (mcp_call):\n" +
    "- Connected MCP tools are listed under 'Connected MCP tools' in your context. " +
    "They are real integrations — calendar, Notion, Gmail, Figma, Resend, Vercel " +
    "and more. When the user asks about tomorrow's schedule, a Notion page, an " +
    "email, or asks you to send/create/update anything in those services: pick " +
    "the matching tool and call it via mcp_call with exact name and arguments.\n" +
    "- Prefer read tools to answer questions; use write tools when asked to act. " +
    "For destructive actions (delete, send, spend) confirm intent first — the " +
    "user is speaking casually, so one quick confirm beats an irreversible mistake.\n" +
    "- If a needed tool isn't in the list, say so plainly — never fabricate a " +
    "tool name or invent results.\n\n" +
    `Current agent status: ${agentStatusLine}`
  );
}

export class VoiceRelay {
  constructor() {
    this.paneDir = path.join(os.homedir(), ".pane");
    this.executors = new Map(); // projectId -> ToolExecutor (read-only use)
  }

  /**
   * Read the OpenAI API key from settings.json. Empty string when unset —
   * callers treat that as "voice unavailable" and never surface the key itself.
   */
  async getApiKey() {
    let settings = null;
    try {
      const content = await fs.readFile(this.paneDir + "/settings.json", "utf-8");
      settings = JSON.parse(content);
    } catch (err) {
      // Parse/read failures are NOT "no key" — they mean settings.json is
      // unreadable (concurrent write, corruption). Surface the real cause
      // so intermittent failures are diagnosable instead of masked.
      console.error("[voice] settings.json unreadable:", err?.message);
    }
    // API key wins; ChatGPT OAuth is the fallback — both are accepted by
    // api.openai.com for realtime client_secrets (verified live Aug 2026:
    // OAuth token mints ek_ tokens and opens working WebRTC sessions).
    const apiKey = settings?.http_api_keys?.openai || "";
    if (apiKey) return apiKey;
    try {
      const oauth = await getOpenAIAccessToken();
      if (oauth) return oauth;
    } catch (err) {
      console.warn("[voice] OpenAI OAuth fallback failed:", err?.message || err);
    }
    return "";
  }

  /**
   * Mint an ephemeral Realtime token. The standard key stays here in main;
   * the renderer receives only the short-lived client secret.
   *
   * @param {string} projectId
   * @param {string|null} projectRoot
   * @param {string} agentStatusLine - one-line summary of agent activity for instructions
   * @returns {Promise<{ ok: true, token: string, instructions: string, tools: object[] } |
   *                     { ok: false, error: string }>}
   */
  /**
   * Build a workspace snapshot: threads (projects), their last activity,
   * peer threads sharing the current project root, and message counts.
   *
   * Sources (verified live, Aug 2026):
   *   - settings.json project_states — the renderer's persisted thread
   *     registry (name, root). 24 threads at time of writing.
   *   - intents.mjs readActivities — NDJSON activity records (2h TTL).
   *   - pane.db messages — real persisted conversation history.
   * Legacy paths deliberately NOT used: state_blobs editor/project (no
   * current writers), state dirs' project.json (months stale),
   * conversations table (orphaned migration artifact).
   */
  async buildWorkspaceSnapshot(currentProjectId) {
    // Thread registry
    const threads = [];
    try {
      const content = await fs.readFile(this.paneDir + "/settings.json", "utf-8");
      const settings = JSON.parse(content);
      const states = settings?.project_states || {};
      const now = Date.now();
      for (const [id, st] of Object.entries(states)) {
        const acts = readActivities(id);
        const last = acts.length ? acts[acts.length - 1] : null;
        const ageMin = last ? Math.round((now - last.ts) / 60000) : null;
        threads.push({
          id,
          name: st?.name || id,
          root: st?.root || null,
          // Active = activity within the last 15 minutes
          active: last ? now - last.ts < 15 * 60 * 1000 : false,
          lastActivityAgoMin: ageMin,
          lastActivity:
            last?.activityType === "turn_start" && last?.detail
              ? String(last.detail).slice(0, 120)
              : last
                ? `${last.tool || last.activityType}${last.file ? ` (${last.file})` : ""}`
                : null,
        });
      }
    } catch (err) {
      console.warn("[voice] workspace snapshot: settings.json unreadable:", err?.message);
    }
    threads.sort((a, b) => (b.lastActivityAgoMin ?? Infinity) - (a.lastActivityAgoMin ?? Infinity));

    // Message counts per thread — best-effort; pane.db may be uninitialized
    // in this process (it belongs to the main pipeline). Never fatal.
    let messageCounts = null;
    try {
      const { getPaneDb } = await import("./pane-db.mjs");
      const db = getPaneDb();
      const rows = db.prepare("SELECT project_id, COUNT(*) AS cnt FROM messages GROUP BY project_id").all();
      messageCounts = {};
      for (const r of rows) messageCounts[r.project_id] = r.cnt;
    } catch {
      // Uninitialized in this process — counts omitted, not fabricated.
    }

    // Peers: other threads on the same project root right now
    let peers = null;
    try {
      const mine = threads.find((t) => t.id === currentProjectId);
      if (mine?.root) {
        peers = threads
          .filter((t) => t.id !== currentProjectId && t.root === mine.root)
          .map((t) => ({ name: t.name, active: t.active, lastActivity: t.lastActivity, lastActivityAgoMin: t.lastActivityAsortMin ?? t.lastActivityAgoMin }));
      }
    } catch {
      /* peers omitted */
    }

    const activeCount = threads.filter((t) => t.active).length;
    return {
      totalThreads: threads.length,
      activeThreads: activeCount,
      threads: threads.slice(0, 12), // bound: top 12 by recency
      peersOnThisProject: peers,
      messageCounts,
    };
  }

  /**
   * Capture the Pane window as PNG and return a data URI for the Realtime
   * input_image content part. Pull-based: invoked only when the model calls
   * look_at_screen. Resize keeps tokens bounded — full-res window capture
   * would balloon every glance into hundreds of image tokens.
   */
  async captureScreen(detail = "low") {
    const { BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith("file://"),
    );
    if (!win) {
      return { ok: false, error: "No Pane window available to capture." };
    }
    try {
      const image = await win.webContents.capturePage();
      const maxW = detail === "high" ? 1600 : 1100;
      const origW = image.getSize().width;
      // Resize when wider than target — nativeImage.resize is the cheap path
      // (no canvas, no deps). detail "high" keeps more text readable.
      const final = origW > maxW ? image.resize({ width: maxW }) : image;
      return {
        ok: true,
        image: final.toDataURL(),
        width: final.getSize().width,
      };
    } catch (err) {
      return { ok: false, error: `Screen capture failed: ${err?.message || err}` };
    }
  }

  async mintToken(projectId, projectRoot, agentStatusLine = "idle") {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { ok: false, error: "No OpenAI credential — add an API key in Profile → API Keys or sign in with ChatGPT (OpenAI card)." };
    }

    // Shared brain: same identity + about + playbook the agent gets.
    let sharedContext = "";
    try {
      sharedContext = orchestrateContext(projectId, { projectRoot, backend: "voice" }).full || "";
    } catch (err) {
      console.warn("[voice] context assembly failed, continuing with relay-only instructions:", err?.message);
    }
    const instructions = buildVoiceInstructions(sharedContext, agentStatusLine) + getCompanionBlock();
    const { voice, accent } = await readVoiceSetting();
    // MCP catalog: live tool list from connected servers, grouped by server.
    // Appended last so it reflects current connections at mint time.
    const mcpCatalog = buildMcpCatalog();
    const sessionInstructions =
      (mcpCatalog ? instructions + "\n\n## Connected MCP tools\n" + mcpCatalog : instructions) +
      (ACCENT_INSTRUCTIONS[accent] ? "\n\n" + ACCENT_INSTRUCTIONS[accent] : "");

    try {
      const res = await fetch(OPENAI_REALTIME_SECRET_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: REALTIME_MODEL,
            instructions: sessionInstructions,
            tools: VOICE_TOOLS,
            // Schema note (probed live against /v1/realtime/client_secrets,
            // Aug 2026): turn_detection is REJECTED as a flat top-level
            // session param (400 unknown_parameter) — it must nest under
            // audio.input. A flat param silently killed every live session;
            // the fix is shape only, semantics identical.
            audio: {
              input: {
                transcription: { model: "whisper-1" },
                turn_detection: { type: "semantic_vad" },
              },
              output: { voice },
            },
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Surface the real upstream error — never wrap it away.
        return { ok: false, error: `OpenAI realtime session error ${res.status}: ${body.slice(0, 400)}` };
      }
      const data = await res.json();
      const token = data?.value || data?.client_secret?.value;
      if (!token) {
        return { ok: false, error: "OpenAI returned no client secret value." };
      }
      return { ok: true, token, instructions, tools: VOICE_TOOLS, voice };
    } catch (err) {
      return { ok: false, error: `Failed to reach OpenAI: ${err?.message || err}` };
    }
  }

  /**
   * Speak a short test line through gpt-4o-mini-tts (all 10 realtime voices
   * are supported there too — verified in the TTS guide). Runs in MAIN so
   * the API key never enters the renderer; audio plays via an <audio> sink
   * with a data: URL returned for the renderer to play. Returns a data URL
   * so playback (and any autoplay policy) stays in the renderer.
   *
   * @returns {Promise<{ ok: true, audio: string, voice: string } |
   *                     { ok: false, error: string }>}
   */
  async previewVoice(voiceId) {
    if (!REALTIME_VOICES.includes(voiceId)) {
      return { ok: false, error: `Unknown voice '${voiceId}'.` };
    }
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { ok: false, error: "No OpenAI credential — add an API key in Profile → API Keys or sign in with ChatGPT (OpenAI card)." };
    }
    const { accent } = await readVoiceSetting();
    try {
      const res = await fetch(OPENAI_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: voiceId,
          // Distinctive test line: British pronunciation cues that are easy
          // to judge by ear (schedule, water, can't, lieutenant), plus a
          // warm greeting so it's easy to follow, not a technical murmur.
          input:
            accent === "british"
              ? "Hello! Can't we schedule a call about the water shortage? The lieutenant said it's better to ask directly."
              : `Hi, I'm ${voiceId}. This is how I'll sound in Pane.`,
          instructions:
            "Speak briefly, warmly, and directly. No theatrical delivery." +
            (accent === "british" ? " " + ACCENT_INSTRUCTIONS.british : ""),
          response_format: "mp3",
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, error: `OpenAI TTS ${res.status}: ${body.slice(0, 300)}` };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Return raw base64 — the renderer wraps it in a Blob + object URL,
      // because CSP media-src allows blob: but not data:.
      return {
        ok: true,
        voice: voiceId,
        audioB64: buf.toString("base64"),
      };
    } catch (err) {
      return { ok: false, error: `Failed to reach OpenAI: ${err?.message || err}` };
    }
  }

  /**
   * Execute a whitelisted knowledge tool through the shared ToolExecutor.
   * delegate_task and get_agent_status never arrive here — the renderer
   * handles those locally (handoff + status read) before anything crosses IPC.
   *
   * @param {string} projectId
   * @param {string|null} projectRoot
   * @param {string} toolName
   * @param {object} args
   */
  async runTool(projectId, projectRoot, toolName, args) {
    // Companion-memory tools execute here — they're not ToolExecutor tools.
    if (toolName === "recall_conversation") {
      // Normalize to the { success, output } contract the renderer expects
      // (recallConversations returns { ok, hits, ... }).
      const res = recallConversations(args?.query, { daysBack: args?.days_back ?? null });
      if (res?.ok) return { success: true, output: JSON.stringify(res).slice(0, 12000) };
      return { success: false, error: res?.error || "conversation recall failed" };
    }
    if (toolName === "workspace_state") {
      return this.buildWorkspaceSnapshot(projectId);
    }
    // mcp_call gateway: { tool, args } → executor, which routes ext__*
    // names to the MCP client (same path the main agent uses).
    if (toolName === "mcp_call") {
      const target = typeof args?.tool === "string" ? args.tool.trim() : "";
      if (!mcpClient.isExternalTool(target)) {
        return {
          success: false,
          error: `'${target || "(missing)"}' is not an MCP tool. Pick an exact name from the Connected MCP tools list.`,
        };
      }
      let executor = this.executors.get(projectId);
      if (!executor) {
        executor = new ToolExecutor(projectId, projectRoot || "", () => {});
        this.executors.set(projectId, executor);
      }
      const toolId = `voice-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      try {
        const result = await executor.executeTool(toolId, target, args?.args || {});
        return result ?? { success: false, error: "MCP tool returned nothing." };
      } catch (err) {
        return { success: false, error: err?.cause?.message || err?.message || String(err) };
      }
    }
    // look_at_screen never arrives here — the renderer handles capture and
    // image push locally (the Realtime conversation lives in the renderer).
    if (!VOICE_TOOL_WHITELIST.has(toolName)) {
      return { success: false, error: `Tool '${toolName}' is not available to voice.` };
    }
    let executor = this.executors.get(projectId);
    if (!executor) {
      executor = new ToolExecutor(projectId, projectRoot || "", () => {});
      this.executors.set(projectId, executor);
    }
    const toolId = `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await executor.executeTool(toolId, toolName, args || {});
      return result ?? { success: false, error: "Tool returned nothing." };
    } catch (err) {
      // Unwrap and pass through the real error.
      return { success: false, error: err?.cause?.message || err?.message || String(err) };
    }
  }

  /**
   * Distill the companion memory at session end. Uses the same OpenAI key
   * as realtime/TTS; a small cheap model is enough for a ≤300-word summary.
   * Session-scoped: safe to call on every session end — trivial sessions
   * (few exchanges) skip the LLM call entirely.
   */
  async distillMemory(sessionExchanges) {
    const apiKey = await this.getApiKey();
    if (!apiKey) return { ok: false, error: "No OpenAI credential — API key or ChatGPT sign-in required." };
    const llmCall = async (systemPrompt, userPrompt) => {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenAI distill ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("OpenAI distill returned no content");
      return text;
    };
    return distillCompanionMemory(llmCall, { sessionExchanges });
  }
}

export const voiceRelay = new VoiceRelay();
