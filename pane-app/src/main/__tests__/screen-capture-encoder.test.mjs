import { describe, it, expect } from "vitest";
import {
  normalizeJpegQuality,
  imageToBoundedDataUri,
} from "../voice-relay.mjs";

/**
 * Screen-capture encoder tests (Sep 2026 capture bug).
 *
 * ROOT CAUSE LOCKED HERE: Electron 40's nativeImage.toJPEG converts
 * quality as an INTEGER on the 0–100 scale. Fractional doubles (the old
 * 0.85/0.8 values) throw gin "Error processing argument at index 0,
 * conversion failure from <empty>" — surfacing in voice as
 * "Screen capture failed" ONLY on dense windows whose PNG exceeded the
 * 220k-char budget (the JPEG ladder was the only caller of toJPEG).
 *
 * The fakes below model the REAL Electron 40 contract: toJPEG throws on
 * non-integer quality. If someone reverts to fractional qualities, these
 * tests fail with the exact production error.
 */

/** Fake nativeImage modeling Electron 40's binding contract. */
function fakeImage({ width, height, pngChars, jpegBytesPerPx = 0.05 }) {
  let current = { width, height };
  const calls = { toJPEG: [], resize: [] };
  return {
    calls,
    getSize: () => ({ ...current }),
    toDataURL: () => "data:image/png;base64," + "x".repeat(pngChars(current.width)),
    toJPEG(quality) {
      calls.toJPEG.push(quality);
      // THE CONTRACT: integer 0–100 accepted, anything else throws the
      // exact production gin error.
      if (typeof quality !== "number" || !Number.isInteger(quality)) {
        throw new TypeError(
          'Error processing argument at index 0, conversion failure from ',
        );
      }
      if (quality < 0 || quality > 100) {
        throw new TypeError(
          'Error processing argument at index 0, conversion failure from ' + quality,
        );
      }
      return Buffer.alloc(Math.max(1, Math.round(current.width * current.height * jpegBytesPerPx)));
    },
    resize({ width }) {
      calls.resize.push(width);
      const scale = width / current.width;
      current = { width, height: Math.round(current.height * scale) };
      return this;
    },
  };
}

describe("normalizeJpegQuality — structural boundary for the Electron 40 binding", () => {
  it("passes integers through unchanged", () => {
    expect(normalizeJpegQuality(85)).toBe(85);
    expect(normalizeJpegQuality(80)).toBe(80);
    expect(normalizeJpegQuality(1)).toBe(1);
  });

  it("rounds fractional doubles to integers — the production failure mode", () => {
    expect(normalizeJpegQuality(0.85)).toBe(1); // legacy 0-1 scale → 1
    expect(normalizeJpegQuality(0.5)).toBe(1);
    expect(normalizeJpegQuality(84.6)).toBe(85);
  });

  it("clamps out-of-range and collapses garbage to the default", () => {
    expect(normalizeJpegQuality(500)).toBe(100);
    expect(normalizeJpegQuality(-3)).toBe(1);
    expect(normalizeJpegQuality(NaN)).toBe(85);
    expect(normalizeJpegQuality("high")).toBe(85);
    expect(normalizeJpegQuality(undefined)).toBe(85);
  });
});

describe("imageToBoundedDataUri — capture paths", () => {
  it("small window: PNG under budget, no JPEG encoding at all", () => {
    const img = fakeImage({ width: 1400, height: 900, pngChars: () => 90_000 });
    const out = imageToBoundedDataUri(img, 1600);
    expect(out.image.startsWith("data:image/png")).toBe(true);
    expect(out.width).toBe(1400);
    expect(img.calls.toJPEG).toHaveLength(0); // never entered the ladder
  });

  it("dense window (the Travelwise failure): PNG over budget → JPEG ladder with INTEGER quality only", () => {
    // 3400px retina capture of a dense thread → PNG ~976k chars → ladder.
    const img = fakeImage({
      width: 3400,
      height: 2200,
      pngChars: (w) => w * 280, // ~952k at full width — way over budget
      jpegBytesPerPx: 0.01, // JPEG fits immediately, no downscale loop needed
    });
    const out = imageToBoundedDataUri(img, 1600);
    expect(out.image.startsWith("data:image/jpeg")).toBe(true);
    expect(out.width).toBe(1600); // resized to maxW first
    expect(img.calls.toJPEG.length).toBeGreaterThanOrEqual(1);
    // THE REGRESSION GUARD: every native toJPEG call used an integer.
    for (const q of img.calls.toJPEG) {
      expect(Number.isInteger(q)).toBe(true);
    }
  });

  it("extreme density: downscale loop runs, still integer-only qualities, wire budget honored in CHARS", () => {
    // JPEG never fits until the 4-pass downscale guard or 600px floor stops it.
    const img = fakeImage({
      width: 3400,
      height: 2200,
      pngChars: (w) => w * 500,
      jpegBytesPerPx: 0.4, // huge JPEGs force the downscale ladder
    });
    const out = imageToBoundedDataUri(img, 1600);
    expect(out.image.startsWith("data:image/jpeg")).toBe(true);
    expect(img.calls.resize.length).toBeGreaterThan(0); // downscaling happened
    for (const q of img.calls.toJPEG) {
      expect(Number.isInteger(q)).toBe(true);
    }
    // Second pass drops quality (85 → 80)
    expect(img.calls.toJPEG[img.calls.toJPEG.length - 1]).toBeLessThanOrEqual(85);
    // The wire payload (base64 chars) respects the SCTP budget — the
    // bytes-vs-chars scale bug would let ~333k-char messages through.
    expect(out.image.length).toBeLessThanOrEqual(250_000);
  });

  it("wire budget is measured in data-URI chars, not buffer bytes (scale regression)", () => {
    // JPEG bytes just under budget but base64 would exceed it → must downscale.
    // At 1600w the fake yields 1600*1035*0.12 ≈ 198,720 bytes (< 250k bytes)
    // but ×4/3 ≈ 264,321 chars (> 250k chars) — old code shipped this as-is.
    const img = fakeImage({
      width: 3400,
      height: 2200,
      pngChars: (w) => w * 500,
      jpegBytesPerPx: 0.12,
    });
    const out = imageToBoundedDataUri(img, 1600);
    expect(out.image.length).toBeLessThanOrEqual(250_000);
  });
});
