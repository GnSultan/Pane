/**
 * Pane Cloud Crypto
 *
 * Client-side encryption for cloud backups.
 * Uses Node.js built-in crypto — no external dependencies.
 *
 * Key derivation: HKDF(SHA-256) from user_secret + github_id
 * Encryption: AES-256-GCM with random 12-byte IV
 *
 * File format:
 *   [1 byte: IV length] [IV] [ciphertext] [16 byte auth tag]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";

/**
 * Derive a 256-bit AES key from the user_secret and github_id.
 *
 * @param {string} userSecret — base64-encoded 32-byte secret from D1
 * @param {number} githubId — user's GitHub numeric ID (used as salt)
 * @returns {Buffer} 32-byte key
 */
export function deriveKey(userSecret, githubId) {
  const ikm  = Buffer.from(userSecret, "base64");
  const salt = Buffer.from(String(githubId), "utf-8");
  const info = Buffer.from("pane-cloud-v1", "utf-8");

  return crypto.hkdfSync("sha256", ikm, salt, info, 32);
}

/**
 * Encrypt a file with AES-256-GCM.
 * Writes: [1 byte IV length][IV][ciphertext][16 byte auth tag]
 *
 * @param {string} inputPath — plaintext file path
 * @param {string} outputPath — encrypted file path
 * @param {Buffer} key — 32-byte AES key
 */
export async function encryptFile(inputPath, outputPath, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const input  = fs.createReadStream(inputPath);
  const output = fs.createWriteStream(outputPath);

  // Write header: IV length (1 byte) + IV
  output.write(Buffer.from([iv.length]));
  output.write(iv);

  // Stream encrypt
  await pipeline(input, cipher, output);

  // Append auth tag (16 bytes) — must be written after pipeline completes
  const tag = cipher.getAuthTag();
  fs.appendFileSync(outputPath, tag);
}

/**
 * Decrypt a file encrypted with encryptFile().
 *
 * @param {string} inputPath — encrypted file path
 * @param {string} outputPath — decrypted output path
 * @param {Buffer} key — 32-byte AES key
 */
export async function decryptFile(inputPath, outputPath, key) {
  // Read the entire file — backups are small enough (< 20MB)
  const data = fs.readFileSync(inputPath);

  // Parse header
  const ivLen = data[0];
  const iv    = data.subarray(1, 1 + ivLen);
  const tag   = data.subarray(data.length - 16);
  const ciphertext = data.subarray(1 + ivLen, data.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  fs.writeFileSync(outputPath, plaintext);
}

/**
 * Compute SHA-256 checksum of a file.
 * Used for integrity verification after upload/download.
 *
 * @param {string} filePath
 * @returns {Promise<string>} hex-encoded SHA-256
 */
export async function checksumFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
