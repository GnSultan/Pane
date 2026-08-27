/**
 * Claude Code billing header signing — required for OAuth authentication.
 *
 * The Anthropic API validates OAuth-authenticated requests by checking
 * a signed billing header in the system prompt. This header proves the
 * request originates from Claude Code and is tied to the first user message.
 *
 * This module implements the same signing algorithm as Claude Code's
 * K19() function, derived from the opencode-claude-auth reference.
 */

import { createHash } from "node:crypto";

const BILLING_SALT = "59cf53e54c78";

/**
 * Extract text from the first user message's first text content block.
 *
 * @param {Array<{role?: string, content?: string | Array<{type?: string, text?: string}>}>} messages
 * @returns {string}
 */
function extractFirstUserMessageText(messages) {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  const content = userMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text");
    if (textBlock && textBlock.text) {
      return textBlock.text;
    }
  }
  return "";
}

/**
 * Compute cch: first 5 hex characters of SHA-256(messageText).
 *
 * @param {string} messageText
 * @returns {string}
 */
function computeCch(messageText) {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

/**
 * Compute the 3-char version suffix.
 *
 * @param {string} messageText
 * @param {string} version
 * @returns {string}
 */
function computeVersionSuffix(messageText, version) {
  const sampled = [4, 7, 20]
    .map((i) => (i < messageText.length ? messageText[i] : "0"))
    .join("");
  const input = `${BILLING_SALT}${sampled}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Build the complete billing header string for insertion into system[0].
 * Format: x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;
 *
 * @param {Array<{role?: string, content?: string | Array<{type?: string, text?: string}>}>} messages
 * @param {string} [version] - Claude Code version (default: "2.1.185")
 * @param {string} [entrypoint] - Entry point identifier (default: "sdk-cli")
 * @returns {string}
 */
export function buildBillingHeaderValue(messages, version = "2.1.185", entrypoint = "sdk-cli") {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text, version);
  const cch = computeCch(text);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}
