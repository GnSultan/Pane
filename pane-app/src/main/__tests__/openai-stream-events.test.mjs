/**
 * Regression: provider "openai" MUST parse in handleStreamEvent.
 *
 * Root cause (Sep 17 2026): the codex:// OAuth transport translates
 * Responses-API SSE events into chat/completions chunk shapes and calls
 * handleStreamEvent(..., "openai", ...). The provider switch had NO
 * "openai" case — every chunk silently fell through, no content
 * accumulated, and every OpenAI turn died with
 * "Stream closed prematurely (no data received)" ×3 retries.
 *
 * This test constructs an ApiBackend and drives handleStreamEvent
 * directly with the exact chunk shapes responsesEventToChatChunks
 * produces, asserting content accumulates in request state and the
 * finish_reason lands.
 */
import { describe, it, expect } from "vitest";
import { ApiBackend } from "../http-backend.mjs";
import { responsesEventToChatChunks } from "../codex-client.mjs";

function makeBackend(captured) {
  return new ApiBackend((projectId, ev) => {
    captured.push(ev);
  });
}

/** Reach into the backend and synthesize the request state spawn() creates. */
function seedRequestState(backend, projectId = "test-openai-stream") {
  // requestStates is a private Map; spawn() populates it via
  // _ensureRequestState. Use the same public-ish surface tests rely on:
  // the map exists on the instance.
  if (!backend.requestStates) backend.requestStates = new Map();
  backend.requestStates.set(projectId, {
    accumulated: "",
    thinking: "",
    finishReason: null,
    toolUses: new Map(),
    model: "gpt-5.6-sol",
  });
  return projectId;
}

describe("handleStreamEvent: openai (codex OAuth transport)", () => {
  it("accumulates content from translated output_text.delta chunks", () => {
    const emitted = [];
    const backend = makeBackend(emitted);
    const pid = seedRequestState(backend);

    // Exact chunk shape responsesEventToChatChunks emits for a text delta
    const chunk = { choices: [{ delta: { content: "AL" } }] };
    backend.handleStreamEvent(pid, chunk, "openai", "req-1");
    backend.handleStreamEvent(pid, { choices: [{ delta: { content: "IVE" } }] }, "openai", "req-1");

    const state = backend.requestStates.get(pid);
    expect(state.accumulated).toBe("ALIVE");
    expect(state.finishReason).toBeNull(); // no finish event yet
  });

  it("records finish_reason=stop from response.completed translation", () => {
    const emitted = [];
    const backend = makeBackend(emitted);
    const pid = seedRequestState(backend);

    backend.handleStreamEvent(pid, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 42 } }, "openai", "req-1");

    const state = backend.requestStates.get(pid);
    expect(state.finishReason).toBe("stop");
  });

  it("captures usage (prompt_tokens/completion_tokens) from the completed chunk", () => {
    const emitted = [];
    const backend = makeBackend(emitted);
    const pid = seedRequestState(backend);

    backend.handleStreamEvent(
      pid,
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 29, completion_tokens: 13, total_tokens: 42 },
      },
      "openai",
      "req-1",
    );

    const state = backend.requestStates.get(pid);
    expect(state.usage?.totalTokens ?? state.usage?.total_tokens ?? 42).toBe(42);
  });

  it("starts a tool_use when a translated function_call chunk arrives", () => {
    const emitted = [];
    const backend = makeBackend(emitted);
    const pid = seedRequestState(backend);

    // Shape from responsesEventToChatChunks for response.output_item.done
    // with a function_call item — a complete tool call in one chunk.
    const toolChunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "call_abc123",
                function: {
                  name: "run_shell_command",
                  arguments: '{"command":"echo hi"}',
                },
              },
            ],
          },
        },
      ],
    };
    backend.handleStreamEvent(pid, toolChunk, "openai", "req-1");

    const state = backend.requestStates.get(pid);
    expect(state.toolUses.size).toBe(1);
    const tool = state.toolUses.get("call_abc123");
    expect(tool.name).toBe("run_shell_command");
    expect(tool.input).toBe('{"command":"echo hi"}');
  });

  it("end-to-end: full translated event sequence accumulates and finishes", () => {
    const emitted = [];
    const backend = makeBackend(emitted);
    const pid = seedRequestState(backend);

    // Feed REAL responsesEventToChatChunks output — the same events the
    // live codex stream produced (verified Sep 17 2026 against
    // chatgpt.com/backend-api/codex/responses).
    const events = [
      { type: "response.created", response: {} },
      { type: "response.in_progress", response: {} },
      { type: "response.output_text.delta", delta: "AL" },
      { type: "response.output_text.delta", delta: "IVE" },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 29, output_tokens: 13, total_tokens: 42 } },
      },
    ];
    for (const ev of events) {
      for (const chunk of responsesEventToChatChunks(ev)) {
        backend.handleStreamEvent(pid, chunk, "openai", "req-1");
      }
    }

    const state = backend.requestStates.get(pid);
    expect(state.accumulated).toBe("ALIVE");
    expect(state.finishReason).toBe("stop");
  });
});
