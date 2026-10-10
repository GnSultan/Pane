/**
 * Clipboard image → downscaled data URL.
 *
 * Pasted screenshots are often 2-5x display resolution (retina) with alpha
 * channels — megabytes of PNG that providers bill per pixel. Downscale to
 * max 1568px on the long edge (Anthropic's documented sweet spot for
 * screenshots/documents) and re-encode as JPEG q0.85 (alpha flattened onto
 * white — whiteboard/screenshot text survives fine). Typical result:
 * a 2.4MB screenshot → ~200-400KB.
 */

const MAX_EDGE = 1568;
const JPEG_QUALITY = 0.85;

export interface PreparedImage {
  /** data:image/jpeg;base64,... — ready for the user message content block */
  dataUrl: string;
  /** width x height after downscale */
  width: number;
  height: number;
  /** rough byte size of the base64 payload */
  bytes: number;
}

export async function prepareClipboardImage(
  blob: Blob,
): Promise<PreparedImage | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Flatten alpha onto white — JPEG has no alpha channel
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    if (!dataUrl.startsWith("data:image/")) return null;

    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return {
      dataUrl,
      width,
      height,
      bytes: Math.round((base64.length * 3) / 4),
    };
  } catch {
    return null;
  }
}
