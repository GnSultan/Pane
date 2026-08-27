/**
 * End-to-end OAuth-only Realtime test:
 * 1. Mint ephemeral token with ChatGPT OAuth (no API key)
 * 2. Connect WebSocket to Realtime with the ephemeral token
 * 3. Wait for session.created → proves the full voice path works OAuth-only
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const codex = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf-8"));
const oauthToken = codex.tokens.access_token;

// Step 1: mint
const mintCtrl = new AbortController();
const mintTimeout = setTimeout(() => mintCtrl.abort(), 15000);
let ek;
try {
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: { type: "realtime", model: "gpt-realtime" },
    }),
    signal: mintCtrl.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`MINT FAILED ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const data = JSON.parse(text);
  ek = data.value;
  console.log(`✓ minted ephemeral token (${ek.slice(0, 14)}...) with OAuth`);
} finally {
  clearTimeout(mintTimeout);
}

// Step 2: connect WebSocket
const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";
console.log("connecting WS…");
const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${ek}` },
});

const failTimer = setTimeout(() => {
  console.log("✗ TIMEOUT: no session.created within 15s");
  process.exit(1);
}, 15000);

ws.onopen = () => console.log("✓ WS open");
ws.onerror = (e) => console.log("WS error:", e?.message || e);
ws.onclose = (e) => console.log(`WS closed: code=${e.code} reason=${e.reason || "(none)"}`);
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "session.created") {
    console.log(`✓ session.created — session ${msg.session?.id}, model ${msg.session?.model}`);
    console.log("OAUTH-ONLY REALTIME PATH: WORKS END-TO-END");
    clearTimeout(failTimer);
    ws.close();
    process.exit(0);
  }
  if (msg.type === "error") {
    console.log(`✗ realtime error: ${JSON.stringify(msg.error).slice(0, 300)}`);
    clearTimeout(failTimer);
    process.exit(1);
  }
};
