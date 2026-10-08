import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  STANDARD_TIER,
  HIGH_RES_TIER,
  countVisualTokens,
  resizedSize,
  scalePoint,
} from "../vision-tiers.mjs";

void STANDARD_TIER;

describe("countVisualTokens", () => {
  it("one token per 28×28 patch", () => {
    assert.equal(countVisualTokens(28, 28), 1);
    assert.equal(countVisualTokens(1000, 1000), 1296); // 36×36 patches
  });
});

describe("resizedSize (Anthropic reference behavior)", () => {
  it("returns fitting images unchanged", () => {
    assert.deepEqual(resizedSize(200, 200), { width: 200, height: 200 });
    assert.deepEqual(resizedSize(1000, 1000), { width: 1000, height: 1000 });
  });

  it("A4 doc example: 1075×1520 → 924×1307 (standard tier)", () => {
    // Token limit triggers although both edges are under 1568 — the classic
    // silent-resize case from the coordinates doc.
    assert.deepEqual(resizedSize(1075, 1520), { width: 924, height: 1307 });
  });

  it("1920×1080 → 1456×819, not 1568×882 (token limit governs, not edge)", () => {
    assert.deepEqual(resizedSize(1920, 1080), { width: 1456, height: 819 });
  });

  it("retina full screen 2940×1912 → fits standard tier exactly", () => {
    const r = resizedSize(2940, 1912);
    // Must fit both constraints
    assert.ok(Math.ceil(r.width / 28) * 28 <= 1568, "width edge fit");
    assert.ok(Math.ceil(r.height / 28) * 28 <= 1568, "height edge fit");
    assert.ok(countVisualTokens(r.width, r.height) <= 1568, "token fit");
    // Aspect roughly preserved
    const srcAspect = 2940 / 1912;
    const outAspect = r.width / r.height;
    assert.ok(Math.abs(srcAspect - outAspect) < 0.02, `aspect ${outAspect} vs ${srcAspect}`);
  });

  it("high-res tier keeps more pixels for the same image", () => {
    const std = resizedSize(2940, 1912);
    const hi = resizedSize(2940, 1912, HIGH_RES_TIER);
    assert.ok(hi.width > std.width, "high-res tier should be wider");
    assert.ok(countVisualTokens(hi.width, hi.height) <= HIGH_RES_TIER.maxTokens);
  });

  it("high-res tier does not resize 1920×1080 (matches docs table)", () => {
    assert.deepEqual(resizedSize(1920, 1080, HIGH_RES_TIER), { width: 1920, height: 1080 });
  });

  it("3840×2160 → 1456×819 on standard (docs table)", () => {
    assert.deepEqual(resizedSize(3840, 2160), { width: 1456, height: 819 });
  });

  it("portrait images swap correctly", () => {
    // Portrait A4: 1075 wide × 1520 tall — the transpose path returns
    // (924, 1307), i.e. width 924, height 1307.
    const p = resizedSize(1075, 1520);
    assert.equal(p.width, 924);
    assert.equal(p.height, 1307);
  });

  it("elongated images respect the edge limit", () => {
    // 3000×400 panorama: tokens = 108×15 = 1620 > 1568 → must shrink
    const r = resizedSize(3000, 400);
    assert.ok(countVisualTokens(r.width, r.height) <= 1568, "token fit");
    assert.ok(Math.ceil(r.width / 28) * 28 <= 1568, "edge fit");
  });
});

describe("scalePoint", () => {
  it("maps model-space coordinates back onto the original", () => {
    // A4 example from the docs: (462, 653.5) on the resized 924×1307 maps
    // back onto the 1075×1520 original.
    const p = scalePoint(462, 653.5, { width: 924, height: 1307 }, { width: 1075, height: 1520 });
    assert.equal(p.x, 538); // 462/924*1075 = 537.5 → rounds to 538
    assert.equal(p.y, 760); // 653.5/1307*1520 = 759.95
  });

  it("identity when spaces match", () => {
    const p = scalePoint(100, 200, { width: 1000, height: 800 }, { width: 1000, height: 800 });
    assert.deepEqual(p, { x: 100, y: 200 });
  });

  it("clamps out-of-range model coordinates", () => {
    const p = scalePoint(5000, -10, { width: 1000, height: 800 }, { width: 2000, height: 1600 });
    assert.equal(p.x, 2000);
    assert.equal(p.y, 0);
  });
});
