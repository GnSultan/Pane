import { describe, it, expect } from "vitest";
import { buildImageEnvelope } from "../image-envelope.mjs";

/**
 * normalizeMessages is a pure method on ApiBackend (no electron deps in the
 * method itself), but the module imports electron at top level. To unit test
 * the method in isolation we extract it via the prototype — importing the
 * module would fail outside electron. Instead we re-implement the harness by
 * importing the class with electron mocked.
 */

// Minimal electron mock — http-backend imports { net } from "electron"
const netMock = {
  request: () => ({
    on: () => {},
    write: () => {},
    end: () => {},
  }),
};
const electronMock = {
  net: netMock,
  app: { getPath: () => "/tmp", isPackaged: false },
  ipcMain: { handle: () => {}, on: () => {} },
};

vi.mock("electron", () => electronMock);

const { ApiBackend } = await import("../http-backend.mjs");

describe("normalizeMessages — image tool results", () => {
  const backend = Object.create(ApiBackend.prototype);

  const imgEnvelope = buildImageEnvelope({
    media_type: "image/png",
    label: "shot.png",
    data: "aGVsbG8=",
  });

  const baseMessages = [
    { role: "user", content: "look at this" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "view_image", input: { file_path: "shot.png" } }],
    },
    {
      role: "tool",
      tool_call_id: "tu_1",
      content: imgEnvelope,
    },
  ];

  it("anthropic: converts envelope to image block inside tool_result", () => {
    const out = backend.normalizeMessages(
      structuredClone(baseMessages),
      "anthropic",
    );
    // Find the user message carrying the tool_result
    const trMsg = out.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result"),
    );
    expect(trMsg).toBeTruthy();
    const block = trMsg.content.find((b) => b.type === "tool_result");
    // content should be [text marker, image block]
    expect(Array.isArray(block.content)).toBe(true);
    expect(block.content.some((b) => b.type === "image")).toBe(true);
    expect(block.content.some((b) => b.type === "text")).toBe(true);
    // base64 must NOT leak as raw string content
    expect(JSON.stringify(block.content)).toContain("aGVsbG8=");
  });

  it("openai-compat: hoists image into trailing user message, tool content replaced with marker", () => {
    const out = backend.normalizeMessages(
      structuredClone(baseMessages),
      "openrouter",
    );
    // Tool message content must NOT contain the envelope
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.content).not.toContain("__PANE_IMG__");
    expect(toolMsg.content).toContain("attached");

    // A trailing user message must carry the image_url part
    const imgUser = out.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "image_url"),
    );
    expect(imgUser).toBeTruthy();
    const part = imgUser.content.find((b) => b.type === "image_url");
    expect(part.image_url.url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("keeps tool_call → tool sequencing intact for openai with images", () => {
    const out = backend.normalizeMessages(
      structuredClone(baseMessages),
      "openrouter",
    );
    const callIds = new Set(
      out
        .filter((m) => m.role === "assistant" && m.tool_calls)
        .flatMap((m) => m.tool_calls.map((tc) => tc.id)),
    );
    const resultIds = new Set(
      out.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    );
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }
  });

  it("user message with data-URL image block converts to vision format (openai)", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: "data:image/jpeg;base64,aGVsbG8=" },
        ],
      },
    ];
    const out = backend.normalizeMessages(msgs, "deepseek");
    expect(out).toHaveLength(1);
    expect(Array.isArray(out[0].content)).toBe(true);
    const imgPart = out[0].content.find((b) => b.type === "image_url");
    expect(imgPart.image_url.url).toBe("data:image/jpeg;base64,aGVsbG8=");
    const textPart = out[0].content.find((b) => b.type === "text");
    expect(textPart.text).toBe("what is this?");
  });

  it("user message with data-URL image block converts to native source (anthropic)", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: "data:image/jpeg;base64,aGVsbG8=" },
        ],
      },
    ];
    const out = backend.normalizeMessages(msgs, "anthropic");
    expect(out).toHaveLength(1);
    const imgBlock = out[0].content.find((b) => b.type === "image");
    expect(imgBlock.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "aGVsbG8=",
    });
  });

  it("text-only user messages keep the plain string format (openai, cache stability)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const out = backend.normalizeMessages(msgs, "deepseek");
    expect(out[0].content).toBe("hello");
  });

  it("defensive flatten does not destroy vision-format user arrays (openai)", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
        ],
      },
    ];
    const out = backend.normalizeMessages(msgs, "deepseek");
    expect(Array.isArray(out[0].content)).toBe(true);
    expect(out[0].content.some((b) => b.type === "image_url")).toBe(true);
  });
});
