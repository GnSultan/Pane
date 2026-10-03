/**
 * Regression: MCP tool schemas must not carry regex constructs the Rust
 * regex crate rejects (lookarounds/backreferences).
 *
 * Root cause (Sep 17 2026): resend-mcp ships email `pattern` fields with
 * `(?!...)` lookaheads. OpenAI's Responses API validates tool schemas with
 * Rust regex and rejected the ENTIRE turn with
 *   400 invalid_json_schema "regex lookaround is not supported"
 * — one external server's schema poisoned every OpenAI spawn.
 *
 * The fix sanitizes schemas at tool-discovery time in
 * McpClient.getExternalTools() → _sanitizeSchemaPatterns. These tests pin
 * that transformation without spawning any MCP server.
 */
import { describe, it, expect } from "vitest";
import { mcpClient } from "../mcp-client.mjs";

// Fresh instances share the class of the exported singleton without
// touching its live connections/state.
const McpClient = mcpClient.constructor;

const LOOKAHEAD_EMAIL =
  "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";

function clientWithTool(inputSchema) {
  const client = new McpClient();
  client.toolIndex = new Map([
    ["ext__resend__create-contact", { name: "ext__resend__create-contact", description: "x", inputSchema }],
  ]);
  return client;
}

describe("McpClient._sanitizeSchemaPatterns", () => {
  it("replaces lookahead email patterns with an RE2-safe equivalent", () => {
    const client = clientWithTool({
      type: "object",
      properties: { email: { type: "string", pattern: LOOKAHEAD_EMAIL } },
    });
    const tools = client.getExternalTools();
    const pattern = tools[0].function.parameters.properties.email.pattern;
    expect(pattern).not.toMatch(/\(\?[=!<]/);
    expect(pattern).toContain("@");
  });

	it("drops patterns with unsupported constructs it cannot rewrite", () => {
    const client = clientWithTool({
      type: "object",
      properties: { code: { type: "string", pattern: "(?<=foo)bar\\1" } },
    });
    const tools = client.getExternalTools();
    const prop = tools[0].function.parameters.properties.code;
    expect(prop.pattern).toBeUndefined(); // unconstrained — schema still valid
    expect(prop.type).toBe("string");
  });

  it("leaves clean patterns untouched", () => {
    const clean = "^[a-z]+$";
    const client = clientWithTool({
      type: "object",
      properties: { slug: { type: "string", pattern: clean } },
    });
    const tools = client.getExternalTools();
    expect(tools[0].function.parameters.properties.slug.pattern).toBe(clean);
  });

  it("sanitizes nested patterns (array items, deep properties)", () => {
    const client = clientWithTool({
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: { type: "string", pattern: LOOKAHEAD_EMAIL },
        },
        deep: {
          type: "object",
          properties: { inner: { type: "string", pattern: "(?=x)y" } },
        },
      },
    });
    const params = client.getExternalTools()[0].function.parameters;
    expect(params.properties.emails.items.pattern).not.toMatch(/\(\?[=!<]/);
    expect(params.properties.deep.properties.inner.pattern).toBeUndefined();
  });

  it("does not mutate the source schema in toolIndex", () => {
    const client = clientWithTool({
      type: "object",
      properties: { email: { type: "string", pattern: LOOKAHEAD_EMAIL } },
    });
    client.getExternalTools();
    const source = client.toolIndex.get("ext__resend__create-contact").inputSchema;
    // Source retains the original (lookahead) pattern — only the outbound copy is sanitized
    expect(source.properties.email.pattern).toBe(LOOKAHEAD_EMAIL);
  });
});
