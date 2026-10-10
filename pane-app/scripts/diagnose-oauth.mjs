#!/usr/bin/env node
/**
 * OAuth diagnostic — sends a minimal request to the Anthropic API using
 * the same body transformation as Pane's OAuth path. Logs the full request
 * and response so we can see exactly what the API returns.
 *
 * Usage: node scripts/diagnose-oauth.mjs
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BILLING_SALT = "59cf53e54c78";
const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const TOOL_PREFIX = "mcp_";

// ── Billing header signing (same as claude-signing.mjs) ───────────────

function extractFirstUserMessageText(messages) {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  const content = userMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text");
    if (textBlock && textBlock.text) return textBlock.text;
  }
  return "";
}

function computeCch(messageText) {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

function computeVersionSuffix(messageText, version) {
  const sampled = [4, 7, 20]
    .map((i) => (i < messageText.length ? messageText[i] : "0"))
    .join("");
  const input = `${BILLING_SALT}${sampled}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function buildBillingHeaderValue(messages, version = "2.1.185", entrypoint = "sdk-cli") {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text, version);
  const cch = computeCch(text);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}

// ── Tool name prefixing ───────────────────────────────────────────────

function prefixToolName(name) {
  const pascal = name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return `${TOOL_PREFIX}${pascal}`;
}

// ── cache_control stripping ───────────────────────────────────────────

function stripCacheControl(block) {
  if (typeof block === "string") return { type: "text", text: block };
  const { cache_control: _, ...rest } = block;
  return rest;
}

// ── Token loading ─────────────────────────────────────────────────────

async function getAccessToken() {
  // Try macOS Keychain first
  const { spawnSync } = await import("node:child_process");
  // Try Pane-native keychain first
  try {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", "Pane Claude-credentials", "-w"],
      { encoding: "utf-8", timeout: 5000 }
    );
    if (result.stdout?.trim()) {
      const data = JSON.parse(result.stdout.trim());
      if (data.accessToken) return data.accessToken;
    }
  } catch {}

  // Try Pane credentials file
  const paneCredPath = join(homedir(), ".pane", "claude-credentials.json");
  if (existsSync(paneCredPath)) {
    try {
      const creds = JSON.parse(readFileSync(paneCredPath, "utf-8"));
      if (creds.accessToken) return creds.accessToken;
    } catch {}
  }

  // Fall back to Claude Code keychain
  try {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8", timeout: 5000 }
    );
    if (result.stdout?.trim()) {
      const data = JSON.parse(result.stdout.trim());
      const oauth = data.claudeAiOauth ?? data;
      if (oauth.accessToken) return oauth.accessToken;
    }
  } catch {}

  // Try Claude Code credentials file
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) {
    try {
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      const oauth = creds.claudeAiOauth ?? creds;
      if (oauth.accessToken) return oauth.accessToken;
    } catch {}
  }

  console.error("Could not load OAuth access token. Run claude first.");
  process.exit(1);
}

// ── Construct the body ────────────────────────────────────────────────

function buildOAuthBody(billingHeader) {
  const tools = [
    { name: "run_shell_command", description: "Execute a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
  ];

  const systemBlocks = [
    { type: "text", text: "You are a helpful coding assistant. Work in /tmp/test-project." },
    { type: "text", text: "Follow security best practices." },
  ];

  const messages = [
    { role: "user", content: "Say hello world" },
  ];

  // ── Apply OAuth transformation ──
  const BILLING_PREFIX = "x-anthropic-billing-header";

  // Separate core from non-core
  const coreBlocks = [];
  const movedTexts = [];
  for (const block of systemBlocks) {
    const txt = typeof block === "string" ? block : (block.text ?? "");
    const stripped = stripCacheControl(block);
    if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
      coreBlocks.push(stripped);
    } else if (txt.length > 0) {
      movedTexts.push(txt);
    }
  }

  const newSystem = [
    { type: "text", text: billingHeader },
    { type: "text", text: SYSTEM_IDENTITY },
    ...coreBlocks,
  ];

  // Move non-core to first user message
  if (movedTexts.length > 0) {
    const prefix = movedTexts.join("\n\n");
    if (typeof messages[0].content === "string") {
      messages[0].content = prefix + "\n\n" + messages[0].content;
    }
  }

  // Prefix tools
  const prefixedTools = tools.map((t) => ({
    ...t,
    name: prefixToolName(t.name),
  }));

  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    system: newSystem,
    messages,
    tools: prefixedTools,
    metadata: { user_id: "diagnostic-test" },
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const accessToken = await getAccessToken();
  console.log("✓ Loaded access token (length: %d)", accessToken.length);

  const messages = [{ role: "user", content: "Say hello world" }];
  const billingHeader = buildBillingHeaderValue(messages);
  console.log("✓ Billing header: %s", billingHeader);

  const body = buildOAuthBody(billingHeader);

  console.log("\n========== REQUEST BODY ==========");
  console.log(JSON.stringify(body, null, 2));
  console.log("==================================\n");

  // Headers from claude-oauth.mjs getOAuthHeaders
  const cliVersion = process.env.ANTHROPIC_CLI_VERSION || "2.1.185";
  const userAgent = `claude-cli/${cliVersion} (external, sdk-cli)`;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05",
    "user-agent": userAgent,
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  };

  const url = "https://api.anthropic.com/v1/messages?beta=true";

  console.log("Sending to: %s", url);
  console.log("Headers: authorization=Bearer ***, anthropic-beta=%s", headers["anthropic-beta"]);
  console.log("");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    console.log("Status: %d %s", response.status, response.statusText);
    const responseText = await response.text();
    console.log("Response body:");
    console.log(responseText.slice(0, 2000));

    if (response.ok) {
      console.log("\n✓ Success!");
    } else {
      console.log("\n✗ Failed with status %d", response.status);
      // Try to parse error
      try {
        const err = JSON.parse(responseText);
        console.log("Error type: %s", err.error?.type);
        console.log("Error message: %s", err.error?.message);
      } catch {}
    }
  } catch (err) {
    console.error("Request failed: %s", err.message);
  }
}

main().catch((err) => {
  console.error("Fatal: %s", err.message);
  process.exit(1);
});
