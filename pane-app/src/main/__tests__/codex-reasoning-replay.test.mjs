/**
 * Regression: reasoning items MUST survive the codex round-trip.
 *
 * Root cause (Sep 18 2026): with store:false, the Codex Responses API keeps
 * NO server-side state. Pane replayed only text + tool_calls on each tool
 * round-trip, silently discarding the model's reasoning items — so every
 * GPT-5.x reasoning model "reset" after each tool result: re-oriented,
 * re-searched, grepped blindly. Claude was unaffected (server-side thinking),
 * which made OpenAI sessions in Pane look inexplicably worse.
 *
 * The fix has three boundaries, all covered here:
 *   1. responsesEventToChatChunks captures reasoning items with
 *      encrypted_content from response.output_item.done
 *   2. handleStreamEvent (openai branch) collects them into
 *      state.codexReasoningItems
 *   3. chatToResponsesInput replays them BEFORE the assistant's
 *      text/tool_calls on the next round-trip
 * plus: buildResponsesRequest asks for encrypted_content via `include`.
 */
import { describe, it, expect } from "vitest";
import { ApiBackend } from "../http-backend.mjs";
import {
  responsesEventToChatChunks,
  chatToResponsesInput,
  buildResponsesRequest,
} from "../codex-client.mjs";

describe("codex reasoning replay: capture", () => {
  it("emits a codex_reasoning_item chunk for reasoning items with encrypted_content", () => {
    const chunks = responsesEventToChatChunks({
      type: "response.output_item.done",
      item: {
        type: "reasoning",
        id: "rs_abc123",
        encrypted_content: "ENC[BLOB]",
        summary: [],
      },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.codex_reasoning_item).toEqual({
      id: "rs_abc123",
      encrypted_content: "ENC[BLOB]",
      summary: [],
    });
  });

  it("does NOT capture summary-only reasoning items (nothing replayable)", () => {
    const chunks = responsesEventToChatChunks({
      type: "response.output_item.done",
      item: { type: "reasoning", id: "rs_none", summary: [{ type: "summary_text", text: "hi" }] },
    });
    expect(chunks).toHaveLength(0);
  });

  it("handleStreamEvent collects reasoning items into state (openai branch)", () => {
    const backend = new ApiBackend(() => {});
    if (!backend.requestStates) backend.requestStates = new Map();
    backend.requestStates.set("pid", {
      accumulated: "",
      thinking: "",
      finishReason: null,
      toolUses: new Map(),
      model: "gpt-5.6-sol",
    });

    backend.handleStreamEvent(
      "pid",
      { choices: [{ delta: { codex_reasoning_item: { id: "rs_1", encrypted_content: "E1" } } }] },
      "openai",
      "req-1",
    );
    backend.handleStreamEvent(
      "pid",
      { choices: [{ delta: { codex_reasoning_item: { id: "rs_2", encrypted_content: "E2" } } }] },
      "openai",
      "req-1",
    );

    const state = backend.requestStates.get("pid");
    expect(state.codexReasoningItems).toEqual([
      { id: "rs_1", encrypted_content: "E1" },
      { id: "rs_2", encrypted_content: "E2" },
    ]);
    // No visible side effects — nothing accumulated
    expect(state.accumulated).toBe("");
  });
});

describe("codex reasoning replay: wire format", () => {
  it("replays reasoning items BEFORE the assistant text and tool calls", () => {
    const input = chatToResponsesInput([
      { role: "user", content: "find the bug" },
      {
        role: "assistant",
        codex_reasoning_items: [{ id: "rs_1", encrypted_content: "E1" }],
        content: "Reading the file first.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: '{"path":"a.ts"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ]);

    // Order must be: user → reasoning → assistant text → function_call → output
    expect(input.map((i) => i.type)).toEqual([
      "message",       // user
      "reasoning",     // captured item — must precede its outputs
      "message",       // assistant text
      "function_call",
      "function_call_output",
    ]);
    expect(input[1]).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "E1",
    });
  });

  it("skips reasoning items without encrypted_content (not replayable)", () => {
    const input = chatToResponsesInput([
      {
        role: "assistant",
        codex_reasoning_items: [{ id: "rs_x" }, { id: "rs_y", summary: [] }],
        content: "text",
      },
    ]);
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
  });

  it("buildResponsesRequest requests encrypted reasoning payloads", () => {
    const req = buildResponsesRequest({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(req.include).toEqual(["reasoning.encrypted_content"]);
    expect(req.store).toBe(false);
  });
});

describe("codex user content mapping (vision fix)", () => {
  it("maps chat-style vision arrays to Responses content parts", () => {
    const input = chatToResponsesInput([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
        ],
      },
    ]);
    expect(input[0].content).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" },
    ]);
  });

  it("maps renderer data-URL image blocks to input_image", () => {
    const input = chatToResponsesInput([
      {
        role: "user",
        content: [{ type: "image", source: "data:image/png;base64,WEVG" }],
      },
    ]);
    expect(input[0].content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,WEVG" },
    ]);
  });

  it("passes plain strings through unchanged (prefix-cache stability)", () => {
    const input = chatToResponsesInput([{ role: "user", content: "plain" }]);
    expect(input[0].content).toBe("plain");
  });

  it("tool output stays a string even for array content", () => {
    const input = chatToResponsesInput([
      { role: "tool", tool_call_id: "c1", content: ["unexpected"] },
    ]);
    expect(typeof input[0].output).toBe("string");
  });
});
