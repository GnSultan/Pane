/**
 * S3-compatible presigned URL generator for Cloudflare R2.
 *
 * Generates AWS SigV4 presigned URLs so the client can upload/download
 * directly from R2's S3 endpoint, bypassing the Worker's body size limit.
 */

const S3_SERVICE = "s3";
const S3_REGION = "auto";

/**
 * Generate a presigned PUT URL for direct upload to R2.
 */
export async function generatePresignedPutUrl(
  accountId: string,
  accessKey: string,
  secretKey: string,
  bucket: string,
  key: string,
  ttlSeconds = 3600,
): Promise<string> {
  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}`;
  const path = `/${key}`;
  return signUrl("PUT", endpoint, host, path, accessKey, secretKey, ttlSeconds);
}

/**
 * Generate a presigned GET URL for direct download from R2.
 */
export async function generatePresignedGetUrl(
  accountId: string,
  accessKey: string,
  secretKey: string,
  bucket: string,
  key: string,
  ttlSeconds = 3600,
): Promise<string> {
  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}`;
  const path = `/${key}`;
  return signUrl("GET", endpoint, host, path, accessKey, secretKey, ttlSeconds);
}

// ---------------------------------------------------------------------------
// AWS SigV4 signing implementation
// ---------------------------------------------------------------------------

async function signUrl(
  method: "GET" | "PUT",
  endpoint: string,
  host: string,
  path: string,
  accessKey: string,
  secretKey: string,
  ttlSeconds: number,
): Promise<string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const credentialScope = `${dateStamp}/${S3_REGION}/${S3_SERVICE}/aws4_request`;
  const signedHeaders = "host";

  // Build query params (without signature — it depends on the canonical request).
  // URLSearchParams.toString() sorts alphabetically and URL-encodes per RFC 3986,
  // which is exactly what SigV4 canonical query strings require.
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttlSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  });

  // Canonical request — MUST include the query params for presigned URL auth.
  // The signature covers the query string, so omitting it means the computed
  // signature never matches what R2 expects from the actual PUT request.
  const canonicalRequest = [
    method,
    path,
    params.toString(),
    `host:${host}`,
    "",
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  // String to sign
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hex(await sha256(canonicalRequest)),
  ].join("\n");

  // Derive signing key
  const signingKey = await getSignatureKey(secretKey, dateStamp, S3_REGION, S3_SERVICE);
  const signature = hex(await hmacSha256(signingKey, stringToSign));

  // Append signature to params
  params.set("X-Amz-Signature", signature);

  return `${endpoint}${path}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Crypto helpers (Web Crypto API — standard in Cloudflare Workers)
// ---------------------------------------------------------------------------

async function sha256(message: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(message);
  return crypto.subtle.digest("SHA-256", data);
}

/**
 * Import a raw key for HMAC-SHA256 use, then sign.
 */
async function hmacSha256(keyMaterial: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false, // not extractable
    ["sign"],
  );
  const data = new TextEncoder().encode(message);
  return crypto.subtle.sign("HMAC", key, data);
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
  const kDate = await hmacSha256(enc("AWS4" + key), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

function hex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
