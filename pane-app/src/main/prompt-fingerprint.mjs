/**
 * Prompt-prefix fingerprinting for prompt-cache break telemetry.
 *
 * Providers cache prompts by prefix: Anthropic in order tools → system →
 * messages (explicit breakpoints), OpenAI-compatible auto-cachers over the
 * raw serialized prefix. The first byte that differs from the previous
 * request invalidates everything downstream of it.
 *
 * Pane assembles the tools array and the system content — everything before
 * the conversation body — so a fingerprint over those two parts localizes
 * every self-inflicted cache break. Pure module: no electron imports, so
 * it's directly testable.
 */

import crypto from "node:crypto";

/**
 * Canonicalize a value so object property insertion order can't produce
 * false positives. Arrays keep order (tool order is significant on the
 * wire — a reordered array IS a different prefix). Primitives pass through.
 * @param {any} value
 * @returns {any}
 */
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
  return out;
}

/**
 * Stable SHA-256 fingerprint over a prefix part. Returns null when the
 * part is absent/empty — "no tools sent" is not a fingerprint.
 * @param {any} part tools array, system content, or any JSON-serializable prefix
 * @returns {string|null}
 */
export function fingerprintPart(part) {
  if (part === null || part === undefined) return null;
  if (Array.isArray(part) && part.length === 0) return null;
  if (typeof part === "object" && !Array.isArray(part) && Object.keys(part).length === 0) return null;
  const json = JSON.stringify(canonicalize(part));
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Compare this turn's prefix parts against the previous turn's.
 * @param {{toolsFp: string|null, systemFp: string|null}} previous
 * @param {{tools: any|null, system: any|null}} current raw parts
 * @returns {"tools"|"system"|"tools+system"|null} which component changed,
 *   or null when the prefix is byte-stable
 */
export function comparePrefixParts(previous, current) {
  const toolsFp = fingerprintPart(current.tools);
  const systemFp = fingerprintPart(current.system);
  const toolsChanged = !!toolsFp && toolsFp !== previous.toolsFp;
  const systemChanged = !!systemFp && systemFp !== previous.systemFp;
  if (toolsChanged && systemChanged) return "tools+system";
  if (toolsChanged) return "tools";
  if (systemChanged) return "system";
  return null;
}
