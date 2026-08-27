/**
 * Codex Backend Client — ChatGPT subscription auth via OAuth tokens
 *
 * chatgpt.com/backend-api/codex speaks the Responses API, NOT chat/completions.
 * This module bridges Pane's OpenAI-compatible internals to that protocol.
 *
 * CRITICAL: ALL requests MUST use Electron's net.fetch — Node's undici TLS
 * fingerprint is blocked by Cloudflare on chatgpt.com (cf-mitigated: challenge).
 * This mirrors the claude-signing.mjs impersonation requirement.
 *
 * Protocol differences (verified empirically 2026-08-23):
 *   - Endpoint: POST {base}/responses (no /v1 prefix)
 *   - stream: true is MANDATORY (400 otherwise)
 *   - max_output_tokens is REJECTED (400) — no token budget control
 *   - Required headers: originator, chatgpt-account-id, OpenAI-Beta
 *   - SSE events: response.output_text.delta / response.completed (usage)
 *   - Models: Codex-specific slugs (gpt-5.6-sol etc.), NOT standard gpt-5 names
 *   - store: false required — we never persist server-side state
 *
 * Translation layer:
 *   OUT:  Pane chat/completions body → Responses API body
 *   IN:   Responses SSE events → chat/completions chunk shape
 *         (so handleStreamEvent's existing openai logic works unchanged)
 */

import { net } from "electron";
import { getAccessToken, getAccountId } from "./openai-oauth.mjs";

// ── Constants ──────────────────────────────────────────────────────────────

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_CLI_VERSION = "0.149.0"; // must match installed CLI for /models

// ── Request translation: chat/completions → Responses API ─────────────────

/**
 * Convert Pane's normalized chat/completions messages to Responses API input.
 *
 * Responses API input items:
 *   { type: "message", role: "user"|"assistant"|"system"|"developer",
 *     content: string | [{type:"input_text"|"output_text", text}] }
 *   { type: "function_call", call_id, name, arguments }
 *   { type: "function_call_output", call_id, output }
 */
export function chatToResponsesInput(messages, systemText) {
  const input = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      // System messages become the top-level instructions (handled by caller)
      continue;
    }

    if (msg.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: typeof msg.content === "string"
          ? msg.content
          : msg.content, // normalizeMessages already stringifies arrays
      });
      continue;
    }

    if (msg.role === "assistant") {
      // Assistant text
      if (msg.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: msg.content,
        });
      }
      // Tool calls the assistant made
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function?.name || tc.name,
            arguments: tc.function?.arguments || safeArgs(tc),
          });
  	}
      }
      continue;
    }

    if (msg.role === "tool") {
      // Tool results
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
      continue;
    }
  }

  return input;
}

function safeArgs(tc) {
  if (typeof tc.input === "string") return tc.input;
  if (tc.input && typeof tc.input === "object") return JSON.stringify(tc.input);
  return "{}";
}

/**
 * Convert Pane's OpenAI-format tools array to Responses API tools.
 * chat/completions: { type: "function", function: { name, description, parameters } }
 * Responses:        { type: "function", name, description, parameters }
 */
export function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || "",
    parameters: t.function?.parameters || t.parameters || { type: "object", properties: {} },
  }));
}

/**
 * Build a complete Responses API request body from a chat/completions body.
 */
export function buildResponsesRequest(body) {
  // Extract system message(s) as instructions
  const systemParts = [];
  const chatMessages = [];
  for (const msg of body.messages || []) {
    if (msg.role === "system" || msg.role === "developer") {
      systemParts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    } else {
      chatMessages.push(msg);
    }
  }

  const req = {
    model: body.model,
    instructions: systemParts.length ? systemParts.join("\n\n") : undefined,
    input: chatToResponsesInput(chatMessages),
    store: false,
    stream: true, // MANDATORY — server rejects non-streaming
  };

  if (body.tools?.length) {
    req.tools = chatToolsToResponses(body.tools);
    // code_mode: tools are code-executing functions (Codex models expect this)
    // omit — default behavior works
  }

  return req;
}

// ── Response translation: Responses SSE → chat/completions chunks ─────────

/**
 * Translate one Responses-API SSE event into zero or more chat/completions
 * chunk objects that handleStreamEvent already knows how to parse.
 *
 * Event mapping:
 *   response.output_text.delta {delta}
 *     → {choices:[{delta:{content: delta}}]}
 *   response.reasoning_summary_text.delta {delta}
 *     → {choices:[{delta:{reasoning: delta}}]}
 *   response.output_item.done {item:{type:"function_call", ...}}
 *     → tool call start+args in one chunk (Codex emits complete tool calls)
 *   response.completed {response:{usage}}
 *     → {choices:[{delta:{},finish_reason:"stop"}], usage:{...}}
 *   response.failed / response.incomplete
 *     → finish_reason error mapping
 */
export function responsesEventToChatChunks(ev) {
  const chunks = [];

  switch (ev.type) {
    case "response.output_text.delta":
      if (ev.delta) {
        chunks.push({ choices: [{ delta: { content: ev.delta } }] });
      }
      break;

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      if (ev.delta) {
        // Route through the reasoning field — model personality registry
        // (getModelStreamingConfig) reads "reasoning" for openai models
        chunks.push({ choices: [{ delta: { reasoning: ev.delta } }] });
      }
      break;

    case "response.output_item.done": {
      const item = ev.item;
      if (item?.type === "function_call") {
        // Codex sends complete tool calls, not streamed deltas. Emit as a
        // single chat-style tool_calls chunk: id + name + full arguments.
        chunks.push({
          choices: [{
            delta: {
              tool_calls: [{
                index: item.call_id ? undefined : undefined,
                id: item.call_id,
                type: "function",
                function: { name: item.name, arguments: item.arguments || "{}" },
              }],
            },
          }],
        });
      }
      break;
    }

    case "response.completed": {
      const usage = ev.response?.usage;
      const finishReason = mapFinish(ev.response?.status);
      chunks.push({
        choices: [{ delta: {}, finish_reason: finishReason }],
        usage: usage ? {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: outputTokensOf(usage),
          prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details?.cached_tokens || 0,
          },
        } : undefined,
      });
      break;
    }

    case "response.failed":
      chunks.push({
        choices: [{ delta: { content: `\n\n[stream failed: ${ev.response?.error?.message || "unknown"}]` } }],
      });
      chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
      break;

    case "response.incomplete":
      chunks.push({ choices: [{ delta: {}, finish_reason: "length" }] });
      break;

    default:
      break;
  }

  return chunks;
}

function outputTokensOf(usage) {
  return usage.output_tokens || 0;
}

function mapFinish(status) {
  switch (status) {
    case "completed": return "stop";
    case "incomplete": return "length";
    case "failed": return "stop";
    default: return "stop";
  }
}

// ── Network layer ──────────────────────────────────────────────────────────

export function codexHeaders(accessToken, accountId, { stream = true } = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    originator: "codex_cli_rs",
    ...(stream ? { Accept: "text/event-stream", "OpenAI-Beta": "responses=experimental" } : {}),
  };
}

/**
 * POST /responses — returns a WHATWG-compatible streaming Response.
 * Uses net.fetch (Chromium TLS) — Node fetch is Cloudflare-blocked.
 */
export async function codexFetch(accessToken, accountId, body) {
  return net.fetch(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: codexHeaders(accessToken, accountId, { stream: true }),
    body: JSON.stringify(body),
  });
}

/**
 * GET /models — Codex-specific model list (requires client_version param).
 * Returns chat-style model objects: { id, context_length, ... }.
 */
export async function codexModels(accessToken, accountId) {
  const res = await net.fetch(
    `${CODEX_BASE_URL}/models?client_version=${CODEX_CLI_VERSION}`,
    { headers: codexHeaders(accessToken, accountId, { stream: false }) },
  );
  if (!res.ok) {
    throw new Error(`Codex /models failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return (data.models || []).map((m) => ({
    id: m.slug,
    name: m.display_name || m.slug,
    context_length: m.context_window || m.max_context_window || 128000,
    provider: "OpenAI",
    tier: m.slug.includes("mini") ? 2 : 1,
    input_cost: null,
    output_cost: null,
  }));
}
