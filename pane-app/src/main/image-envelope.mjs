/**
 * Image envelope — the carrier that lets images ride Pane's string-typed
 * tool-result pipeline without touching any schema.
 *
 * The executor returns tool result content as a STRING. Every hop (summarize →
 * ToolResultStore LRU → journal → _resultRef resolve) assumes strings. Rather
 * than re-type the whole pipeline, an image result is a string with a magic
 * prefix followed by JSON:
 *
 *   __PANE_IMG__{"media_type":"image/png","label":"shot.png","data":"<b64>"}
 *
 * normalizeMessages() detects the prefix at API request time and converts to
 * the provider-native block (Anthropic image block / OpenAI image_url /
 * Gemini inlineData). The renderer never receives the envelope — the emit
 * site swaps it for a small placeholder — so base64 never lands in the DOM.
 */

const PREFIX = "__PANE_IMG__";

/** Hard cap on base64 length per image (~4.7MB binary ≈ Anthropic's 5MB limit). */
export const MAX_IMAGE_BASE64 = 6_300_000;

const SUPPORTED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isImageEnvelope(str) {
  return typeof str === "string" && str.startsWith(PREFIX);
}

/**
 * @param {{ media_type: string, label: string, data: string }} env
 * @returns {string}
 */
export function buildImageEnvelope({ media_type, label, data }) {
  return PREFIX + JSON.stringify({ media_type, label, data });
}

/**
 * Parse an envelope back out. Returns null for anything malformed — callers
 * treat that as "not an image" and pass the string through untouched.
 *
 * @param {string} str
 * @returns {{ media_type: string, label: string, data: string } | null}
 */
export function parseImageEnvelope(str) {
  if (!isImageEnvelope(str)) return null;
  try {
    const parsed = JSON.parse(str.slice(PREFIX.length));
    if (
      parsed &&
      typeof parsed.data === "string" &&
      typeof parsed.media_type === "string" &&
      SUPPORTED_MEDIA.has(parsed.media_type)
    ) {
      return {
        media_type: parsed.media_type,
        label: typeof parsed.label === "string" ? parsed.label : "image",
        data: parsed.data,
      };
    }
  } catch {
    // malformed JSON — fall through to null
  }
  return null;
}

/** Small human-readable stand-in shown in the renderer instead of base64. */
export function imagePlaceholder(str) {
  const env = parseImageEnvelope(str);
  return `[image: ${env ? env.label : "unknown"} — shown to the model natively]`;
}

/** Anthropic-native image content block. */
export function toAnthropicImageBlock(env) {
  return {
    type: "image",
    source: { type: "base64", media_type: env.media_type, data: env.data },
  };
}

/** OpenAI-compatible image_url part (data URL). */
export function toOpenAIImageUrl(env) {
  return {
    type: "image_url",
    image_url: { url: `data:${env.media_type};base64,${env.data}` },
  };
}
