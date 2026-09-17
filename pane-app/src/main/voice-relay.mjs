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
import { nativeImage } from "electron";
import { ToolExecutor } from "./tool-executor.mjs";
import { mcpClient } from "./mcp-client.mjs";
import { orchestrateContext } from "./context-orchestrator.mjs";
import { getAccessToken as getOpenAIAccessToken } from "./openai-oauth.mjs";
import { readActivities } from "./intents.mjs";
import { voiceSnapshot } from "./agent-status.mjs";
import {
  resolveVoiceDistillModel,
  readPaneSettings,
} from "./model-resolver.mjs";
import {
  journalExchange,
  recallConversations,
  distillCompanionMemory,
  getCompanionBlock,
} from "./companion-memory.mjs";

const { fetch } = globalThis;

const OPENAI_REALTIME_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";
// gpt-realtime-2.1-mini (Sep 17 2026): the 2.x full-size family has a
// documented, OpenAI-acknowledged accent-steering regression — accent
// instructions "not working at all, or reverting to a US accent after tool
// usage" (forum #1382384, #1377222), which is precisely Pane's tool-heavy
// (mcp_call) profile. UK voice-agent firms run production on mini-class
// models where the structured accent block holds. 2.1-mini is the current
// generation of that class ($10/$20 per 1M audio in/out vs $32/$64 on 2.1)
// and reportedly respects prompt rules MORE consistently than old mini.
const REALTIME_MODEL = "gpt-realtime-2.1-mini";
// Verified against the live realtime-conversations guide (Aug 2026):
// current realtime voice options. marin/cedar recommended by OpenAI.
export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
];
const DEFAULT_VOICE = "marin";

// OpenAI voices are persona presets, not accent variants — there is no
// native British voice (confirmed against live docs + OpenAI forum, Aug 2026).
// Accent is steered via session instructions on gpt-realtime, which shifts
// delivery while keeping the chosen voice's timbre. Shape (Sep 17 2026):
// terse rule-block, not prose persona — this exact shape is the one UK
// voice-agent firms report holding reliably in production on mini-class
// realtime models (forum #1382384). Long persona prose ("you grew up in
// London…") was three failures deep; the working shape is a short
// structured block of invariants.
const ACCENT_INSTRUCTIONS = {
  none: "",
  british:
    "## Accent\n" +
    "Speak English with a British accent.\n" +
    "- Keep the accent stable from the first word to the last.\n" +
    "- Use natural British vowel shaping, but keep speech easy to understand.\n" +
    "- Do not exaggerate the accent.\n" +
    "- Do not change response language based on the user's accent.\n",
};
const ACCENT_SPEAKING_STYLE = {
  none: "",
  british:
    " British accent, stable from first word to last — including short " +
    "replies, confirmations, and numbers.",
};

/**
 * The single authoritative voice resolver — every path that mints a
 * realtime session (live mintToken, preview previewToken) resolves its
 * voice through here and nowhere else. Mirrors model resolution: read the
 * persisted selection, validate against the provider catalog, and NEVER
 * silently substitute a different voice.
 *
 * Resolution contract (Sep 2026, supersedes the accent-coupling remap):
 *   - The user's selected voice is served VERBATIM. The Aug 29 accent
 *     coupling (british → force ballad) silently swapped a selected female
 *     voice (marin) for a male one (ballad) — a gender mismatch the user
 *     heard live ("selected a female voice, system served a male voice").
 *     Accent is an additive, instructions-only steer layered on top of the
 *     selected timbre; it may never rewrite the selection.
 *   - A selected voice that is absent from the provider catalog (stale,
 *     renamed, or hand-edited settings) is an ERROR, not a fallback: the
 *     caller gets ok:false with a precise message naming the voice and the
 *     valid options. Silent fallback to a default voice is exactly the
 *     failure mode this resolver exists to prevent.
 *   - No selection at all (fresh install, settings never touched) is the
 *     one legitimate default: marin, recorded as defaulted:true so
 *     telemetry can distinguish "user chose marin" from "nobody chose".
 *
 * @param {string|null} overrideVoiceId - explicit voice for one-shot
 *   previews; validated against the same catalog. Still never remapped.
 * @param {{ settingsPath?: string }} [opts] - test seam: path to the
 *   settings file (defaults to ~/.pane/settings.json). Behavior is
 *   identical; only the read location moves.
 * @returns {Promise<
 *   | { ok: true, voice: string, accent: "none"|"british", defaulted: boolean }
 *   | { ok: false, error: string, voice: string|null, accent: "none"|"british" }
 * >}
 */
export async function resolveVoiceSelection(overrideVoiceId = null, opts = {}) {
  let settings = null;
  let readErr = null;
  try {
    const settingsPath =
      opts.settingsPath ?? path.join(os.homedir(), ".pane", "settings.json");
    const content = await fs.readFile(settingsPath, "utf-8");
    settings = JSON.parse(content);
  } catch (err) {
    // Read/parse failure is NOT "no selection" — it means settings.json is
    // unreadable (concurrent write, corruption). Surface the real cause;
    // serving a default voice here would mask an intermittent failure.
    readErr = err;
  }
  const stored = settings?.voice_settings;
  const selectedVoice = overrideVoiceId ?? (typeof stored?.voice === "string" ? stored.voice : null);
  const accent = stored?.accent === "british" ? "british" : "none";
  if (selectedVoice !== null && !REALTIME_VOICES.includes(selectedVoice)) {
    return {
      ok: false,
      voice: selectedVoice,
      accent,
      error:
        `Selected voice '${selectedVoice}' is not available. ` +
        `Valid voices: ${REALTIME_VOICES.join(", ")}. ` +
        "Pick a voice in Profile → Voice.",
    };
  }
  if (selectedVoice !== null) {
    return { ok: true, voice: selectedVoice, accent, defaulted: false };
  }
  if (readErr) {
    return {
      ok: false,
      voice: null,
      accent,
      error: `Could not read voice settings: ${readErr?.message || readErr}`,
    };
  }
  // Fresh install / never-selected: the one sanctioned default.
  return { ok: true, voice: DEFAULT_VOICE, accent, defaulted: true };
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
  "pane_logs",
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
      "so the instruction must be complete and self-contained. " +
      "Can target ANY thread by name (defaults to the currently open thread) — " +
      "you are not tied to the thread you started in.",
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
        thread: {
          type: "string",
          description:
            "Name of the thread to run in. Pane switches to it so the user watches it happen. " +
            "Default: the currently open thread. Get exact names from workspace_state.",
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
    name: "list_mcp_tools",
    description:
      "List the exact names of connected external MCP tools (Calendar, Notion, " +
      "Gmail, Figma, Resend, Vercel, …) so you can call them via mcp_call. " +
      "Optional server filter, e.g. 'notion' or 'gmail'. Call this FIRST when " +
      "the user asks about anything external — never guess a tool name.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional: only list tools from this server (e.g. 'gmail').",
        },
      },
    },
  },
  {
    type: "function",
    name: "mcp_call",
    description:
      "Call an external tool from Pane's MCP servers (Calendar, Notion, Gmail, " +
      "Figma, Resend, Vercel, …). FIRST call list_mcp_tools to get the exact " +
      "tool names — never guess or invent one. Use for real-world actions: " +
      "check/add calendar events, search or update Notion, search mail, send " +
      "email, manage projects.",
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
    name: "agent_threads",
    description:
      "Live per-thread agent status — the authoritative monitor. Returns every " +
      "thread with its current phase (planning | editing | waiting | done | error | " +
      "idle), whether the run is read-only or editing, the current tool, recent " +
      "events, and the agent identity (model@provider). Use when the user asks " +
      "what an agent is doing RIGHT NOW, whether it's safe to interrupt, or which " +
      "agent (e.g. different models across threads) is on which thread. Cheaper " +
      "and more precise than workspace_state for status questions.",
    parameters: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "Optional: thread name — return only that thread's detail.",
        },
      },
    },
  },
  {
    type: "function",
    name: "workspace_state",
    description:
      "Snapshot of Pane's workspace, on demand. Use when the user asks about " +
      "threads, projects, activity, or anything 'how many / what's running'. " +
      "Returns: thread list with per-thread agent status and last activity, " +
      "message counts, peer threads on the current project. The default list " +
      "is capped at the 12 most recent threads — pass name (case-insensitive " +
      "substring) to search ALL threads when the one you need isn't listed.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Optional thread-name search (case-insensitive substring). " +
            "Returns every matching thread regardless of the recency cap.",
        },
      },
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
    name: "view_image",
    description:
      "Look at an image FILE on disk and actually see it. The user says the " +
      "path ('the screenshots on my Desktop', '~/Desktop/shot.png', 'the png " +
      "in the design folder') — pass it here and the image enters the " +
      "conversation as pixels you can inspect. Supports PNG, JPEG, GIF, WebP, " +
      "BMP; ~ expands to home. Use for design reviews, screenshot analysis, " +
      "'what do you think of this' about any image the user mentions. For " +
      "the live Pane window use look_at_screen instead.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path, or ~/-relative. If the user says a folder " +
            "('the images on my Desktop'), first list it with run_knowledge_tool " +
            "(glob) to get exact filenames, then call view_image on each.",
        },
        detail: {
          type: "string",
          enum: ["low", "high"],
          description: "'high' when reading small text or fine visual detail. Default 'low'.",
        },
      },
      required: ["path"],
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
function buildVoiceInstructions(sharedContext, agentStatusLine, accent = "none") {
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
    "call workspace_state — it returns threads with names, activity, and " +
    "message counts (default list: 12 most recent). When the user asks 'how " +
    "many threads', 'what's running', 'what was I doing in X' — call " +
    "workspace_state, don't guess. If the thread you need isn't in the " +
    "default list, call workspace_state again with name: '<part of name>' — " +
    "it searches ALL threads, not just the recent ones.\n" +
    "- Agent status: for 'what is the agent doing right now' precision, call " +
    "agent_threads — it returns each thread's live phase (planning = exploring " +
    "read-only, editing = writing files, waiting = paused for the user, " +
    "done/error = finished), the current tool, and the agent identity " +
    "(model@provider). It is the authoritative monitor; prefer it over " +
    "workspace_state for status of a specific agent or interruption safety.\n" +
    "- Sight: two ways to see. (1) The live Pane window — call look_at_screen " +
    "when the user references something on screen ('this file', 'that error', " +
    "'the layout'). (2) Image files on disk — when the user names an image or " +
    "a folder of images ('the screenshots on my Desktop', 'look at " +
    "~/Desktop/hero.png', 'what do you think of the new export'), call " +
    "view_image with the path; ~ expands to home. If they say a folder, glob " +
    "it first via run_knowledge_tool to get exact filenames, then view_image " +
    "each. Both cost image tokens — look when asked or when the task is " +
    "visual, not reflexively.\n" +
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
    "- After the delegated agent finishes, you will receive a completion notice — " +
    "report the result to the user aloud, briefly, without being asked.\n" +
    "- Speaking style: match Aslam — direct, no filler, no corporate tone." +
    ACCENT_SPEAKING_STYLE[accent] +
    "\n\n" +
    "You also have your own memory of past conversations with Aslam (injected " +
    "above when it exists) and the recall_conversation tool to keep the exact " +
    "record of what was said before. If he references something from days ago, " +
    "search for it — never guess and never pretend to remember what you can't " +
    "find.\n\n" +
    "External world access (mcp_call):\n" +
    "- Call list_mcp_tools to see the exact names of connected external tools " +
    "(calendar, Notion, Gmail, Figma, Resend, Vercel and more). When the user " +
    "asks about tomorrow's schedule, a Notion page, an email, or asks you to " +
    "send/create/update anything in those services: list the tools, pick the " +
    "matching one, and call it via mcp_call with exact name and arguments.\n" +
    "- Prefer read tools to answer questions; use write tools when asked to act. " +
    "For destructive actions (delete, send, spend) confirm intent first — the " +
    "user is speaking casually, so one quick confirm beats an irreversible mistake.\n" +
    "- If a needed tool isn't in the list, say so plainly — never fabricate a " +
    "tool name or invent results.\n\n" +
    `Current agent status: ${agentStatusLine}`
  );
}

/**
 * Encode a nativeImage as a data URI bounded for the WebRTC data channel.
 * dc.send() THROWS on oversized SCTP messages (Chromium), and a 1100px UI
 * screenshot as PNG can exceed the limit — that throw killed the image
 * push AND the function_call_output after it, hanging the model mid-call
 * (the "look_at_screen never works" bug, Sep 2026). Adaptive ladder:
 * PNG (crisp text) when small enough, JPEG 85/100 when not, downscale+
 * JPEG 80 if still over. Returns { image, width, height }.
 *
 * ELECTRON 40 CONTRACT (verified empirically, Sep 2026): nativeImage
 * .toJPEG(quality) converts quality as an INTEGER on the 0–100 scale.
 * A fractional double (0.85, 0.8 — what older Electron docs/examples
 * used) throws gin "Error processing argument at index 0, conversion
 * failure from <empty>" which surfaced to voice as "Screen capture
 * failed" ONLY on dense windows (PNG over budget → JPEG ladder).
 * normalizeJpegQuality() is the structural boundary: every value that
 * reaches the native binding is clamped to a safe integer 1–100.
 */
const JPEG_QUALITY_HIGH = 85; // percent — integer, per Electron 40 binding
const JPEG_QUALITY_LOW = 80; // downscale fallback pass

export function normalizeJpegQuality(q) {
  // Integer percent, clamped to 1–100 (0 produces a degenerate image and
  // >100 is out of range). NaN/garbage collapses to the high default.
  if (!Number.isFinite(q)) return JPEG_QUALITY_HIGH;
  return Math.min(100, Math.max(1, Math.round(q)));
}

export function imageToBoundedDataUri(sourceImage, maxW) {
  let current =
    sourceImage.getSize().width > maxW ? sourceImage.resize({ width: maxW }) : sourceImage;
  // Budgets in data-URI chars (~1.33x binary). Chromium's RTCDataChannel
  // throws on messages over the negotiated SCTP max (typically 256KB
  // binary ≈ 340k chars incl. JSON wrapper). Both budgets stay safely
  // under it: PNG_BUDGET keeps crisp PNG when small; JPEG_BUDGET is the
  // hard ceiling after downscaling.
  const PNG_BUDGET = 220_000;
  const JPEG_BUDGET = 250_000;
  const pngUri = current.toDataURL();
  if (pngUri.length <= PNG_BUDGET) {
    return { image: pngUri, width: current.getSize().width, height: current.getSize().height };
  }
  // JPEG ladder — flat UI screenshots compress dramatically. Downscale
  // (min 600px wide) until the encoded size fits the wire budget.
  // Scale note: jpeg.length is BUFFER BYTES; the wire payload is the
  // base64 data URI (≈ 4/3 × bytes + prefix). Comparing bytes directly
  // against the chars budget under-counts by 33% and lets ~333k-char
  // messages through → dc.send() throws (the original hang bug).
  const jpegWireChars = (buf) => buf.length * 4 / 3 + 23;
  let quality = JPEG_QUALITY_HIGH;
  let jpeg = current.toJPEG(normalizeJpegQuality(quality));
  let guard = 0;
  while (jpegWireChars(jpeg) > JPEG_BUDGET && current.getSize().width > 600 && guard < 4) {
    current = current.resize({ width: Math.round((current.getSize().width * 3) / 4) });
    if (guard === 1) quality = JPEG_QUALITY_LOW; // second pass drops quality
    jpeg = current.toJPEG(normalizeJpegQuality(quality));
    guard += 1;
  }
  return {
    image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    width: current.getSize().width,
    height: current.getSize().height,
  };
}

export class VoiceRelay {
  constructor() {
    this.paneDir = path.join(os.homedir(), ".pane");
    this.executors = new Map(); // projectId -> ToolExecutor (read-only use)
  }

  /**
   * Append a discovery/call telemetry line to ~/.pane/voice-debug.log.
   * Same channel as mint telemetry — a voice session that "can't see
   * calendar" must be diagnosable from the log alone. Fire-and-forget:
   * telemetry must never break the tool path it observes.
   * @param {string} kind
   * @param {Record<string, unknown>} fields
   */
  _logDiscovery(kind, fields) {
    fs.appendFile(
      path.join(os.homedir(), ".pane", "voice-debug.log"),
      `[${new Date().toISOString()}][${kind}] ${JSON.stringify(fields)}\n`,
    ).catch(() => {
      /* telemetry must never break tooling */
    });
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
  async buildWorkspaceSnapshot(currentProjectId, { name = null } = {}) {
    // Thread registry
    const threads = [];
    const want = typeof name === "string" && name.trim() ? name.trim().toLowerCase() : "";
    let totalThreads = 0;
    try {
      const content = await fs.readFile(this.paneDir + "/settings.json", "utf-8");
      const settings = JSON.parse(content);
      const states = settings?.project_states || {};
      const now = Date.now();
      totalThreads = Object.keys(states).length;
      for (const [id, st] of Object.entries(states)) {
        if (want) {
          const tName = String(st?.name || id).toLowerCase();
          if (!tName.includes(want) && !id.toLowerCase().includes(want)) continue;
        }
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
      // Workspace truth, not the filtered count — the model reasons about
      // totals ("how many threads") from this field.
      totalThreads,
      activeThreads: activeCount,
      // Recency cap only for the unfiltered view. A name search is an
      // explicit lookup — return every match so no thread is
      // undiscoverable by exact-name search regardless of activity.
      threads: want ? threads : threads.slice(0, 12),
      matched: want ? threads.length : undefined,
      peersOnThisProject: peers,
      messageCounts,
    };
  }

  /**
   * Capture the Pane window as PNG and return a data URI for the Realtime
   * input_image content part. Pull-based: invoked only when the model calls
   * look_at_screen. Resize keeps tokens bounded — full-res window capture
   * would balloon every glance into hundreds of image tokens.
   *
   * Failure diagnostics (Sep 2026 capture bug): every failure path now
   * carries tool name + phase + window/encoder state so the log alone
   * identifies the layer (window lookup vs native encode vs timeout).
   * The raw error message is passed through — never replaced with a
   * generic "capture failed".
   */
  async captureScreen(detail = "low") {
    const CAPTURE_TIMEOUT_MS = 10_000;
    const t0 = Date.now();
    const started = this._logCapture("start", { detail, ms: 0 });
    const { BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.getURL().startsWith("file://"),
    );
    if (!win) {
      this._logCapture("no_window", { detail, ms: Date.now() - t0 });
      return { ok: false, error: "No Pane window available to capture." };
    }
    try {
      // Explicit timeout: capturePage on an occluded/backgrounded window
      // can stall on slow machines; the model's function call must never
      // hang the voice turn indefinitely.
      const image = await Promise.race([
        win.webContents.capturePage(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`capturePage timed out after ${CAPTURE_TIMEOUT_MS}ms`)),
            CAPTURE_TIMEOUT_MS,
          ),
        ),
      ]);
      const size = image.getSize();
      const encoded = imageToBoundedDataUri(image, detail === "high" ? 1600 : 1100);
      this._logCapture("ok", {
        detail,
        ms: Date.now() - t0,
        srcW: size.width,
        srcH: size.height,
        outW: encoded.width,
        outChars: encoded.image.length,
        format: encoded.image.slice(5, 15),
      });
      return { ok: true, ...encoded };
    } catch (err) {
      // Phase context makes the gin error actionable — the raw message
      // ("conversion failure from <empty>") alone doesn't say which call.
      const phase = "encode"; // window found + capturePage returned/failed here
      this._logCapture("error", {
        detail,
        ms: Date.now() - t0,
        phase,
        errName: err?.name,
        errMsg: String(err?.message || err).slice(0, 300),
      });
      return {
        ok: false,
        error: `Screen capture failed (${phase}): ${err?.message || err}`,
      };
    }
  }

  /**
   * Telemetry for screen capture — structured, no pixels, no secrets.
   * Goes to ~/.pane/voice-debug.log alongside mint/tool telemetry so a
   * "voice couldn't see" report is diagnosable from the log alone.
   * @param {"start"|"ok"|"no_window"|"error"} phase
   * @param {Record<string, unknown>} fields
   */
  _logCapture(phase, fields) {
    return this._logDiscovery("screen-capture", { phase, ...fields });
  }

  /**
   * Load an image file from disk as a data URI for the Realtime
   * input_image content part. The voice twin of view_image: the user says
   * "look at ~/Desktop/screen.png" and the model sees the actual pixels.
   * Same resize policy as captureScreen — tokens stay bounded. Accepts ~
   * for home; returns real error text (never a generic "load failed").
   */
  async loadImageFile(filePath, detail = "low") {
    if (!filePath || typeof filePath !== "string") {
      return { ok: false, error: "path is required" };
    }
    const expanded = filePath.startsWith("~/")
      ? path.join(os.homedir(), filePath.slice(2))
      : filePath;
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(expanded)) {
      return {
        ok: false,
        error:
          "Unsupported image type — PNG, JPEG, GIF, WebP, or BMP only. For PDFs or other files, ask the user to export an image or paste it into the chat.",
      };
    }
    const resolved = path.resolve(expanded);
    try {
      const stats = await fsPromises.stat(resolved);
      // 20MB raw-file cap — images larger than this are almost certainly
      // wrong (misselected exports); post-resize PNG may still be big.
      if (stats.size > 20 * 1024 * 1024) {
        return { ok: false, error: `Image is ${(stats.size / 1048576).toFixed(1)}MB — too large. Ask the user to export a smaller version.` };
      }
      const buf = await fsPromises.readFile(resolved);
      const image = nativeImage.createFromBuffer(buf);
      if (image.isEmpty()) {
        return {
          ok: false,
          error: `Could not decode ${path.basename(resolved)} — the file may be corrupted or not a real image.`,
        };
      }
      const size = image.getSize();
      const t0 = Date.now();
      const encoded = imageToBoundedDataUri(image, detail === "high" ? 1600 : 1100);
      this._logCapture("file_ok", {
        detail,
        ms: Date.now() - t0,
        srcW: size.width,
        srcH: size.height,
        outW: encoded.width,
        outChars: encoded.image.length,
        format: encoded.image.slice(5, 15),
      });
      return {
        ok: true,
        ...encoded,
        bytes: stats.size,
      };
    } catch (err) {
      const code = err?.code;
      if (code === "ENOENT") {
        return {
          ok: false,
          error: `File not found: ${filePath}. Ask the user to confirm the exact path.`,
        };
      }
      if (code === "EACCES") {
        return { ok: false, error: `Permission denied reading ${filePath}.` };
      }
      return { ok: false, error: `Image load failed: ${err?.message || err}` };
    }
  }

  async mintToken(projectId, projectRoot, agentStatusLine = "idle") {
    // Voice resolution FIRST: a stale/invalid selection must surface its
    // own precise error, not be masked by a credential or context failure
    // that happens to land first. Cheap read — no network before it.
    const resolved = await resolveVoiceSelection();
    if (!resolved.ok) {
      // Never silently mint a different voice than the user selected —
      // the live session must match the picker or stop.
      return { ok: false, error: resolved.error };
    }
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
    const { voice, accent } = resolved;
    const instructions = buildVoiceInstructions(sharedContext, agentStatusLine, accent) + getCompanionBlock();
    // MCP catalog: live tool list from connected servers, grouped by server.
    // Appended last so it reflects current connections at mint time.
    // buildMcpCatalog() is still used by tests; live instructions no longer
    // embed the catalog (see sessionInstructions below).
    const mcpCatalog = null;
    // Accent placement (live-tested Aug 2026): the accent block is small
    // (~700 chars) and the full blob is ~40k chars ending in a monotonic
    // 260-line tool catalog — appended at the tail, adherence collapsed
    // (preview stayed British, streaming drifted American). Instructions
    // delivery was PROVEN intact (session echo + input-token accounting
    // matched blob size); this is an attention problem, not plumbing.
    // So: full block leads (primacy), one-line reminder closes (recency).
    const accentLead = ACCENT_INSTRUCTIONS[accent] ? ACCENT_INSTRUCTIONS[accent] + "\n\n" : "";
    const accentTailReminder =
      accent === "british" ? "\n\n## Accent\nSpeak English with a British accent. Keep it stable from the first word to the last." : "";
    // MCP catalog: NO LONGER baked into instructions (accent dilution fix,
    // Aug 2026). The 260-line catalog was 53% of a 42k-char blob; at that
    // ratio accent adherence collapsed several turns in while the tiny
    // preview stayed British. Discovery now happens on demand via the
    // list_mcp_tools tool. buildMcpCatalog stays exported for tests.
    const sessionInstructions =
      accentLead + instructions + accentTailReminder;

    // Mint telemetry (added Aug 2026 accent regression): a session that
    // sounds unaccented must be diagnosable from the log alone — which
    // voice/accent the relay ACTUALLY used, and how the instruction blob
    // was composed. Ground truth, no inference needed post-hoc.
    try {
      await fs.appendFile(
        path.join(os.homedir(), ".pane", "voice-debug.log"),
        `[${new Date().toISOString()}][mint] voice=${voice} accent=${accent} defaulted=${resolved.defaulted ? "yes" : "no"} ` +
          `accentLead=${accentLead.length} sharedBlob=${instructions.length} ` +
          `catalogInInstructions=no tailReminder=${accentTailReminder.length} ` +
          `total=${sessionInstructions.length}\n`,
      );
    } catch {
      /* telemetry must never break minting */
    }

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
                // VAD hardening (user complaint: "any sound cuts the agent's
                // speech — music, table bumps"). Root causes: semantic_vad at
                // eagerness "auto" fires on any speech-like audio, and
                // noise_reduction was null (off). Tuning (verified accepted by
                // /v1/realtime/client_secrets, Aug 2026):
                //   - near_field: suppresses background/noise (music, movement)
                //     for close-mic capture. The alternative, "far_field",
                //     preserves room audio — wrong for laptop-mic conversation.
                //   - eagerness "low": model waits for a fuller utterance
                //     before ending the user's turn — fewer false turn-ends on
                //     transient sounds.
                //   - interrupt_response stays true: real speech during agent
                //     speech must still barge in. Gating that off would break
                //     genuine interruption.
                noise_reduction: { type: "near_field" },
                turn_detection: {
                  type: "semantic_vad",
                  eagerness: "low",
                  create_response: true,
                  interrupt_response: true,
                },
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
      // Return the COMPOSED blob (accent lead + shared instructions + tail
      // reminder) — exactly what the mint body sent and what the server echo
      // counts. The renderer re-sends this verbatim on session.update for
      // turn-boundary accent reassertion; returning the shared blob here
      // would make the reassertion strip the accent block wholesale.
      // accent is a structured field: the renderer must not infer it by
      // pattern-matching instruction text (fragile, and it went stale once).
      return { ok: true, token, instructions: sessionInstructions, accent, tools: VOICE_TOOLS, voice };
    } catch (err) {
      return { ok: false, error: `Failed to reach OpenAI: ${err?.message || err}` };
    }
  }

  /**
   * Mint an ephemeral token for a one-shot voice PREVIEW session.
   *
   * Why not TTS: /v1/audio/speech requires the api.model.audio.request
   * scope, which ChatGPT OAuth tokens do not carry (401 "insufficient
   * permissions") — only standard API keys can call TTS. The realtime
   * client_secrets endpoint accepts BOTH credentials (verified live,
   * Aug 2026), so the preview rides the same path as the live session:
   * real model (gpt-realtime), real voice, real accent steering, and the
   * same ephemeral-token security (key never enters the renderer).
   *
   * The renderer opens a recvonly WebRTC connection with this token,
   * sends response.create, and plays the model speaking the line.
   *
   * @param {string} voiceId
   * @returns {Promise<{ ok: true, token: string, line: string } |
   *                     { ok: false, error: string }>}
   */
  async previewToken(voiceId) {
    // The preview resolves through the SAME authoritative resolver as the
    // live session — same catalog, same validation, same no-substitution
    // rule. Preview and live must not diverge, or a preview that sounds
    // like voice X followed by a live session serving voice Y hides real
    // bugs (the accent-coupling remap did exactly this: previewed one
    // voice, served another). The requested voiceId is validated, never
    // remapped — accent still steers delivery via instructions only.
    const resolved = await resolveVoiceSelection(typeof voiceId === "string" ? voiceId : null);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const { accent } = resolved;
    const voice = resolved.voice;
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { ok: false, error: "No OpenAI credential — add an API key in Profile → API Keys or sign in with ChatGPT (OpenAI card)." };
    }
    // Distinctive test line: British pronunciation cues that are easy
    // to judge by ear (schedule, water, can't, lieutenant), plus a
    // warm greeting so it's easy to follow, not a technical murmur.
    const line =
      accent === "british"
        ? "Hello! Can't we schedule a call about the water shortage? The lieutenant said it's better to ask directly."
        : `Hi, I'm ${voice}. This is how I'll sound in Pane.`;
    const instructions =
      "This is a one-shot voice preview. Say exactly this line once, verbatim, " +
      "warmly and briefly, then stop — do not add anything: " +
      `"${line}"` +
      (accent === "british" ? "\n\n" + ACCENT_INSTRUCTIONS.british : "");
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
            instructions,
            // Listen-only preview: no transcription, no turn detection,
            // no tools — output voice only.
            audio: { output: { voice } },
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
      return { ok: true, token, line };
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
      // args.name is the thread-name search — enforced here at the tool
      // boundary, not in prompts: the snapshot builder filters the FULL
      // registry before any capping.
      return this.buildWorkspaceSnapshot(projectId, {
        name: args?.name,
      });
    }
    if (toolName === "agent_threads") {
      // Authoritative status store — deterministic, never reconstructed
      // from logs. voiceSnapshot() projects through VOICE_SAFE_FIELDS, so
      // only monitoring metadata ever crosses this boundary (no prompts,
      // no file contents, no secrets — structurally impossible).
      const snap = voiceSnapshot();
      const want = typeof args?.thread === "string" && args.thread.trim() ? args.thread.trim().toLowerCase() : "";
      const threads = want
        ? snap.threads.filter(
            (t) =>
              (t.threadName || "").toLowerCase().includes(want) ||
              (t.threadId || "").toLowerCase().includes(want),
          )
        : snap.threads;
      return {
        total: snap.threads.length,
        activeThreads: snap.activeThreads,
        // A filtered lookup is an explicit ask — return every match. The
        // unfiltered view keeps the recency cap.
        threads: want ? threads : threads.slice(0, 12),
        note: "phases: planning=exploring read-only, editing=writing files, waiting=paused for user, done/error=finished",
      };
    }
    if (toolName === "list_mcp_tools") {
      // On-demand catalog discovery (accent fix, Aug 2026): the 260-line
      // catalog used to be baked into session instructions (22k chars, 53%
      // of the blob). At that size the accent block was <1% of instructions
      // and adherence collapsed several turns in (preview stayed British,
      // live drifted American — dilution, documented in community reports
      // on large realtime instruction files). Now the model pulls the exact
      // tool names on demand; instructions stay lean, accent stays loud.
      const filter = typeof args?.server === "string" ? args.server.trim().toLowerCase() : "";
      const tools = mcpClient.getExternalTools();
      // Discovery must explain absence, not just presence: a configured
      // server that failed to connect is invisible in getExternalTools(),
      // and "no calendar tools" would send the model guessing at names.
      // getStatus() covers every configured server with a state, so the
      // answer distinguishes disabled / disconnected / empty from absent.
      const statuses = mcpClient.getStatus();
      if (!tools.length) {
        const lines = statuses.map((s) => `${s.name}: ${s.status}`);
        const detail = lines.length
          ? `MCP servers configured but none exposed tools — states: ${lines.join("; ")}`
          : "No MCP servers configured at all (see Settings → MCP).";
        this._logDiscovery("list_mcp_tools", { ok: true, exposed: 0, configured: statuses.length });
        return { success: true, output: detail };
      }
      const byServer = new Map();
      for (const t of tools) {
        const server = t.function.name.split("__")[1] ?? "unknown";
        if (filter && server !== filter && !server.includes(filter)) continue;
        if (!byServer.has(server)) byServer.set(server, []);
        byServer.get(server, []).push({ name: t.function.name, description: t.function.description });
      }
      const out = [...byServer.keys()].sort().map((s) => {
        const list = byServer
          .get(s)
          .map((t) => `  - ${t.name}${t.description ? ` — ${String(t.description).slice(0, 120)}` : ""}`)
          .join("\n");
        return `${s}:\n${list}`;
      });
      // Mention configured-but-not-exposed servers when filtered (the
      // filter may have matched a disconnected server by name).
      const filteredOut = statuses.filter(
        (s) => s.status !== "connected" && (!filter || s.name.toLowerCase().includes(filter)),
      );
      const outLines = out.length ? out.join("\n") : `No MCP tools matching '${filter}'.`;
      const suffix = filteredOut.length
        ? `\n(not exposing tools: ${filteredOut.map((s) => `${s.name} (${s.status})`).join(", ")})`
        : "";
      this._logDiscovery("list_mcp_tools", {
        ok: true,
        exposed: tools.length,
        configured: statuses.length,
        filter: filter || null,
        matched: out.length,
      });
      return { success: true, output: outLines + suffix };
    }
    // mcp_call gateway: { tool, args } → executor, which routes ext__*
    // names to the MCP client (same path the main agent uses).
    if (toolName === "mcp_call") {
      const target = typeof args?.tool === "string" ? args.tool.trim() : "";
      // Precise failure taxonomy — "cannot access calendar" must resolve
      // to ONE of these causes from the error text alone:
      //   1. missing/blank tool name          → tell them to call discovery
      //   2. name not in index                → nearest matches + how to list
      //   3. no servers at all                → environment misconfiguration
      if (!mcpClient.isExternalTool(target)) {
        if (!target) {
          this._logDiscovery("mcp_call", { ok: false, reason: "missing-tool-name" });
          return {
            success: false,
            error: "No tool name given. Call list_mcp_tools first and pass an exact name as 'tool'.",
          };
        }
        const known = mcpClient.getExternalTools().map((t) => t.function.name);
        const near = known.filter((n) => {
          const short = target.toLowerCase();
          return n.toLowerCase().includes(short) || short.includes(n.toLowerCase());
        }).slice(0, 3);
        this._logDiscovery("mcp_call", { ok: false, reason: "not-an-mcp-tool", target, near: near.length });
        return {
          success: false,
          error: near.length
            ? `'${target}' is not an MCP tool. Closest: ${near.join(", ")}. Call list_mcp_tools for the full list.`
            : `'${target}' is not an MCP tool. Known external tools start with 'ext__'. Call list_mcp_tools to see what is connected.`,
        };
      }
      const known = mcpClient.getExternalTools().map((t) => t.function.name);
      if (!known.includes(target)) {
        // ext__-shaped but not in the index: either the server lost
        // connection after discovery, or the name is close but wrong.
        const near = known.filter((n) => n.toLowerCase().startsWith(target.slice(0, target.lastIndexOf("__") + 2).toLowerCase())).slice(0, 3);
        const statusLine = mcpClient
          .getStatus()
          .map((s) => `${s.name}=${s.status}`)
          .join(" ");
        this._logDiscovery("mcp_call", { ok: false, reason: "tool-not-in-index", target, serverStates: statusLine });
        return {
          success: false,
          error: near.length
            ? `Tool '${target}' is not currently available. Nearest: ${near.join(", ")}. Server states: ${statusLine}. Call list_mcp_tools to refresh.`
            : `Tool '${target}' is not currently available. Server states: ${statusLine}. The server may have disconnected — call list_mcp_tools to see what remains.`,
        };
      }
      let executor = this.executors.get(projectId);
      if (!executor) {
        executor = new ToolExecutor(projectId, projectRoot || "", () => {});
        this.executors.set(projectId, executor);
      }
      const toolId = `voice-mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      try {
        const started = Date.now();
        const result = await executor.executeTool(toolId, target, args?.args || {});
        this._logDiscovery("mcp_call", { ok: !result?.error, tool: target, ms: Date.now() - started });
        return result ?? { success: false, error: "MCP tool returned nothing." };
      } catch (err) {
        this._logDiscovery("mcp_call", { ok: false, tool: target, error: err?.message });
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
   * Distill the companion memory at session end. Two transports, chosen by
   * the credential that actually exists (verified live, Sep 2026):
   *   - platform API key  → api.openai.com/v1/chat/completions
   *   - ChatGPT OAuth     → Codex Responses bridge (chatgpt.com/backend-api/
   *     codex), the same path main chat uses. OAuth tokens are REJECTED by
   *     api.openai.com (401, TTS-class) — this is why distillation silently
   *     died for 10 days while the user was OAuth-only: the model gate
   *     errored, the renderer swallowed it, memory.md froze at Aug 23.
   * A small cheap model is enough for a ≤300-word summary. Session-scoped:
   * safe to call on every session end — trivial sessions (few exchanges)
   * skip the LLM call entirely.
   */
  async distillMemory(sessionExchanges) {
    const settings = await readPaneSettings();
    const apiKey = String(settings?.http_api_keys?.openai || "");
    // OAuth availability probe — cheap local file read + expiry check, no
    // network. Throws propagate: a broken credential store must surface,
    // not be flattened into "no credential".
    let codexAvailable = false;
    try {
      codexAvailable = Boolean(await getOpenAIAccessToken());
    } catch (err) {
      console.warn("[voice] OpenAI OAuth probe for distill failed:", err?.message || err);
    }
    if (!apiKey && !codexAvailable) {
      this._logDiscovery("distill", { ok: false, reason: "no-credential" });
      return { ok: false, error: "No OpenAI credential — API key or ChatGPT sign-in required." };
    }
    // Model + transport resolution: explicit voice_distill_model override
    // targets the platform API; otherwise the active selection when it's an
    // OpenAI model; otherwise the Codex bridge default when OAuth exists.
    // No invented models — misconfiguration returns a surfaced error.
    const { model: distillModel, transport, error: distillError } =
      resolveVoiceDistillModel(settings, codexAvailable && !apiKey);
    if (distillError || !distillModel) {
      this._logDiscovery("distill", { ok: false, reason: "no-model", error: distillError });
      return { ok: false, error: distillError || "No model configured for voice memory distillation." };
    }

    /** One-shot (non-streaming collect) LLM call over the chosen transport. */
    const llmCall = async (systemPrompt, userPrompt) => {
      if (transport === "codex") {
        // Lazy import: codex-client pulls electron's net.fetch (Node TLS is
        // Cloudflare-blocked on chatgpt.com). Lazy keeps vitest (plain Node)
        // importable — same pattern as captureScreen's electron import.
        const { buildResponsesRequest, codexFetch } = await import("./codex-client.mjs");
        const token = await getOpenAIAccessToken();
        if (!token) throw new Error("OpenAI OAuth token expired — sign in with ChatGPT again.");
        const { getAccountId } = await import("./openai-oauth.mjs");
        const body = buildResponsesRequest({
          model: distillModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        const res = await codexFetch(token, getAccountId(), body);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Codex distill ${res.status}: ${text.slice(0, 300)}`);
        }
        // SSE collect: accumulate output_text deltas until completed.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let out = "";
        let usage = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let ev;
            try {
              ev = JSON.parse(payload);
            } catch {
              continue;
            }
            if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
              out += ev.delta;
            } else if (ev.type === "response.completed") {
              usage = ev.response?.usage || null;
              // Fallback: completed without streamed deltas (non-stream
              // body shape) — read assembled output_text if present.
              if (!out && Array.isArray(ev.response?.output)) {
                for (const item of ev.response.output) {
                  if (item.type === "message" && Array.isArray(item.content)) {
                    for (const part of item.content) {
                      if (typeof part.text === "string") out += part.text;
                    }
                  }
                }
              }
            } else if (ev.type === "response.failed" || ev.type === "error") {
              const detail = ev.error?.message || ev.response?.error?.message || JSON.stringify(ev).slice(0, 200);
              throw new Error(`Codex distill failed: ${detail}`);
            }
          }
        }
        if (!out.trim()) throw new Error("Codex distill returned no content");
        return out;
      }
      // Platform API transport — original path, unchanged semantics.
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: distillModel,
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

    // Outcome telemetry: a frozen memory.md must be diagnosable from
    // voice-debug.log alone — outcome, model, transport, word count,
    // duration. Never blocks the return.
    const started = Date.now();
    const result = await distillCompanionMemory(llmCall, { sessionExchanges });
    this._logDiscovery("distill", {
      ok: !result?.error && result?.ok !== false,
      skipped: result?.skipped === true,
      reason: result?.reason || null,
      error: result?.error || null,
      model: distillModel,
      transport,
      words: result?.words || null,
      ms: Date.now() - started,
    });
    return result;
  }
}

export const voiceRelay = new VoiceRelay();
