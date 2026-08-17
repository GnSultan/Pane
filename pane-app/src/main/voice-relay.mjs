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
import { orchestrateContext } from "./context-orchestrator.mjs";

const { fetch } = globalThis;

const OPENAI_REALTIME_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets";
const REALTIME_MODEL = "gpt-realtime-2.1";
const VOICE = "marin";

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
    "- Watch and report: the agent's activity is injected into your context as it " +
    "happens. Narrate progress when asked; stay quiet about it otherwise.\n" +
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
    try {
      const content = await fs.readFile(path.join(this.paneDir, "settings.json"), "utf-8");
      const settings = JSON.parse(content);
      return settings.http_api_keys?.openai || "";
    } catch {
      return "";
    }
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
  async mintToken(projectId, projectRoot, agentStatusLine = "idle") {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      return { ok: false, error: "No OpenAI API key set — add it in Profile → API Keys." };
    }

    // Shared brain: same identity + about + playbook the agent gets.
    let sharedContext = "";
    try {
      sharedContext = orchestrateContext(projectId, { projectRoot, backend: "voice" }).full || "";
    } catch (err) {
      console.warn("[voice] context assembly failed, continuing with relay-only instructions:", err?.message);
    }
    const instructions = buildVoiceInstructions(sharedContext, agentStatusLine);

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
            voice: VOICE,
            instructions,
            tools: VOICE_TOOLS,
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "semantic_vad" },
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
      return { ok: true, token, instructions, tools: VOICE_TOOLS };
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
}

export const voiceRelay = new VoiceRelay();
