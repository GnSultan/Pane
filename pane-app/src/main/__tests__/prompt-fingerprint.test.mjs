import { describe, it, expect } from "vitest";
import { fingerprintPart, comparePrefixParts } from "../prompt-fingerprint.mjs";

/**
 * Prompt-prefix cache-break telemetry — the fingerprint layer.
 *
 * The wire tools[] array order is part of the provider prompt-cache prefix
 * (Anthropic caches tools → system → messages; auto-cachers hash the raw
 * prefix). getExternalTools() previously returned tools in MCP connection
 * order, so a server reconnect reordered the array mid-conversation and
 * silently invalidated the cache at fresh-input price. These tests pin the
 * fingerprint semantics the telemetry relies on.
 */
describe("prompt-fingerprint", () => {
  it("is stable across object key order (canonicalization)", () => {
    const a = fingerprintPart({
      type: "function",
      function: { name: "x", parameters: { type: "object", properties: {} } },
    });
    const b = fingerprintPart({
      function: { parameters: { properties: {}, type: "object" }, name: "x" },
      type: "function",
    });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("changes when the tools array is reordered (order is significant on the wire)", () => {
    const t1 = [
      { type: "function", function: { name: "a" } },
      { type: "function", function: { name: "b" } },
    ];
    const t2 = [
      { type: "function", function: { name: "b" } },
      { type: "function", function: { name: "a" } },
    ];
    expect(fingerprintPart(t1)).not.toBe(fingerprintPart(t2));
  });

  it("returns null for absent and empty parts", () => {
    expect(fingerprintPart(null)).toBeNull();
    expect(fingerprintPart(undefined)).toBeNull();
    expect(fingerprintPart([])).toBeNull();
    expect(fingerprintPart({})).toBeNull();
  });

  it("comparePrefixParts: first turn (no previous) is not a break — handled by caller, comparison is component-wise", () => {
    const tools = [{ name: "a" }];
    const system = [{ type: "text", text: "s" }];
    const toolsFp = fingerprintPart(tools);
    const systemFp = fingerprintPart(system);
    // Same prefix again → no change
    expect(
      comparePrefixParts({ toolsFp, systemFp }, { tools, system }),
    ).toBeNull();
  });

  it("comparePrefixParts localizes a tools-only change", () => {
    const system = [{ type: "text", text: "s" }];
    const systemFp = fingerprintPart(system);
    const prev = { toolsFp: fingerprintPart([{ name: "a" }]), systemFp };
    const next = { tools: [{ name: "a" }, { name: "b" }], system };
    expect(comparePrefixParts(prev, next)).toBe("tools");
  });

  it("comparePrefixParts localizes a system-only change", () => {
    const tools = [{ name: "a" }];
    const toolsFp = fingerprintPart(tools);
    const prev = { toolsFp, systemFp: fingerprintPart([{ text: "old" }]) };
    const next = { tools, system: [{ text: "new" }] };
    expect(comparePrefixParts(prev, next)).toBe("system");
  });

  it("comparePrefixParts reports tools+system when both diverge", () => {
    const prev = { toolsFp: fingerprintPart([{ name: "a" }]), systemFp: fingerprintPart([{ text: "old" }]) };
    const next = { tools: [{ name: "z" }], system: [{ text: "new" }] };
    expect(comparePrefixParts(prev, next)).toBe("tools+system");
  });

  it("comparePrefixParts: removed part (tools became empty) is not a false change", () => {
    const system = [{ text: "s" }];
    const prev = { toolsFp: fingerprintPart([{ name: "a" }]), systemFp: fingerprintPart(system) };
    // Provider dropped tools from the request — prefix system unchanged
    expect(comparePrefixParts(prev, { tools: null, system })).toBeNull();
  });
});
