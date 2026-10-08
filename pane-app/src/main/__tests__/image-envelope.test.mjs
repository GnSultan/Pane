import { describe, it, expect } from "vitest";
import {
  isImageEnvelope,
  buildImageEnvelope,
  parseImageEnvelope,
  imagePlaceholder,
  toAnthropicImageBlock,
  toOpenAIImageUrl,
} from "../image-envelope.mjs";
import { summarize } from "../tool-result-cache.mjs";

describe("image envelope", () => {
  const env = buildImageEnvelope({
    media_type: "image/png",
    label: "shot.png",
    data: "aGVsbG8=",
  });

  it("round-trips build → parse", () => {
    expect(isImageEnvelope(env)).toBe(true);
    const parsed = parseImageEnvelope(env);
    expect(parsed).toEqual({
      media_type: "image/png",
      label: "shot.png",
      data: "aGVsbG8=",
    });
  });

  it("rejects non-envelope strings", () => {
    expect(isImageEnvelope("file contents")).toBe(false);
    expect(parseImageEnvelope("plain text")).toBeNull();
  });

  it("rejects malformed JSON after prefix", () => {
    expect(parseImageEnvelope("__PANE_IMG__{broken")).toBeNull();
  });

  it("rejects unsupported media types", () => {
    const bad = buildImageEnvelopeSafe("video/mp4");
    expect(parseImageEnvelope(bad)).toBeNull();
  });

  it("produces a clean placeholder without base64", () => {
    const ph = imagePlaceholder(env);
    expect(ph).toContain("shot.png");
    expect(ph).not.toContain("aGVsbG8=");
  });

  it("builds Anthropic-native block", () => {
    expect(toAnthropicImageBlock(parseImageEnvelope(env))).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "aGVsbG8=",
      },
    });
  });

  it("builds OpenAI image_url part", () => {
    const part = toOpenAIImageUrl(parseImageEnvelope(env));
    expect(part.type).toBe("image_url");
    expect(part.image_url.url).toBe("data:image/png;base64,aGVsbG8=");
  });
});

function buildImageEnvelopeSafe(media_type) {
  return "__PANE_IMG__" + JSON.stringify({ media_type, label: "x", data: "ZA==" });
}

describe("summarize with image envelopes", () => {
  it("returns a clean marker, never base64", () => {
    const env = buildImageEnvelope({
      media_type: "image/png",
      label: "design.png",
      data: "A".repeat(1000),
    });
    const s = summarize("view_image", env);
    expect(s).toContain("design.png");
    expect(s).toContain("native image");
    expect(s).not.toContain("AAAA");
    expect(s.length).toBeLessThan(300);
  });

  it("handles malformed envelopes gracefully", () => {
    const s = summarize("view_image", "__PANE_IMG__garbage");
    expect(s).toContain("view_image");
    expect(s.length).toBeLessThan(60);
  });

  it("leaves normal tool results untouched", () => {
    expect(summarize("read_file", "line1\nline2\nline3")).toBe(
      "(read_file) line1\nline2\nline3",
    );
  });
});
