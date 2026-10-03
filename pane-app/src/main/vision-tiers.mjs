/**
 * Vision tier limits and the exact server-side resize rule.
 *
 * Anthropic resizes every image that exceeds a model tier's limits BEFORE the
 * model sees it. A resized screenshot means the coordinates the model emits no
 * longer map 1:1 onto the pixel space our computer tool acts in — the classic
 * cause of click-adjust-reclick loops. The fix: pre-resize ourselves so the
 * image we send IS the image the model sees.
 *
 * Resize rule (per docs.anthropic.com/en/docs/build-with-claude/vision-coordinates):
 *   visual tokens = ⌈width / 28⌉ × ⌈height / 28⌉
 *   Find the largest aspect-preserving size where BOTH:
 *     ⌈w/28⌉*28 ≤ max_edge AND ⌈h/28⌉*28 ≤ max_edge AND tokens ≤ max_tokens
 *   Images that fit are returned unchanged (then padded to a 28px multiple
 *   server-side — padding carries no content, so we ignore it).
 *
 * Tier limits (docs.anthropic.com/en/docs/build-with-claude/vision):
 *   Standard:    max_edge 1568, max_tokens 1568  (all models)
 *   High-res:    max_edge 2576, max_tokens 4784  (Claude 4.7+)
 *
 * Computer-use screenshots target STANDARD limits by default: it is the
 * strictest tier, so a standard-fit image is never server-resized on ANY
 * tier, and it keeps screenshot token cost at ~1.5k instead of ~4.7k.
 */

const PATCH = 28;

/** Standard tier: the strictest limits across all model tiers. */
export const STANDARD_TIER = { maxEdge: 1568, maxTokens: 1568 };
/** High-resolution tier (Claude 4.7+). */
export const HIGH_RES_TIER = { maxEdge: 2576, maxTokens: 4784 };

/** Visual tokens an image of these dimensions costs. */
export function countVisualTokens(width, height) {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

/**
 * The size Claude resizes an image to before padding. Port of Anthropic's
 * reference implementation (binary search along the long edge). Images that
 * already fit are returned unchanged.
 * @returns {{width: number, height: number}}
 */
export function resizedSize(width, height, tier = STANDARD_TIER) {
  const { maxEdge, maxTokens } = tier;

  const fits = (w, h) =>
    Math.ceil(w / PATCH) * PATCH <= maxEdge &&
    Math.ceil(h / PATCH) * PATCH <= maxEdge &&
    countVisualTokens(w, h) <= maxTokens;

  if (fits(width, height)) return { width, height };

  // Portrait: recurse on the transposed dimensions, swap back.
  if (height > width) {
    const t = resizedSize(height, width, tier);
    return { width: t.height, height: t.width };
  }

  // Binary search along the long edge (width ≥ height here) for the largest
  // aspect-preserving size that fits. lo always fits; hi never fits.
  const aspect = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(1, Math.round(mid / aspect)))) lo = mid;
    else hi = mid;
  }
  return { width: lo, height: Math.max(1, Math.round(lo / aspect)) };
}

/**
 * Scale a point from the model's seen-image space back to the original
 * pixel space. Padding is applied only to the bottom/right edges, so the
 * origin never shifts and a per-axis linear rescale is exact.
 * @param {{width:number, height:number}} resized - dimensions the model saw
 * @param {{width:number, height:number}} original - the pixel space we act in
 */
export function scalePoint(x, y, resized, original) {
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const cx = clamp(x, 0, resized.width);
  const cy = clamp(y, 0, resized.height);
  return {
    x: Math.round((cx / resized.width) * original.width),
    y: Math.round((cy / resized.height) * original.height),
  };
}

/**
 * Resize pipeline for computer-use screenshots: capture at physical
 * resolution, then shrink to the target tier so the model never sees a
 * server-resized image and its coordinates map 1:1 onto what it saw.
 *
 * `sips -Z` scales the LONG edge to N pixels (aspect preserved). We compute
 * the exact tier-fit dimensions and pass the long edge directly.
 *
 * @param {string} srcPng - full-resolution screenshot path
 * @param {string} origW/origH - physical pixel dimensions of srcPng
 * @returns {Promise<{ok:true, path:string, width:number, height:number, downscaled:boolean, sourceWidth:number, sourceHeight:number}|{ok:false,error:string}>}
 */
export async function fitScreenshotToTier(srcPng, origW, origH, tier = STANDARD_TIER, execFn) {
  const target = resizedSize(origW, origH, tier);
  if (target.width === origW && target.height === origH) {
    return { ok: true, path: srcPng, width: origW, height: origH, downscaled: false, sourceWidth: origW, sourceHeight: origH };
  }
  const longEdge = Math.max(target.width, target.height);
  const out = srcPng.replace(/\.png$/i, "") + `-fit${longEdge}.png`;
  const r = await execFn(`sips -Z ${longEdge} --setProperty format png "${srcPng}" --out "${out}"`, { timeout: 15 });
  if (!r.success) return { ok: false, error: `sips resize failed: ${r.stderr || r.stdout || "unknown"}` };
  return { ok: true, path: out, width: target.width, height: target.height, downscaled: true, sourceWidth: origW, sourceHeight: origH };
}
