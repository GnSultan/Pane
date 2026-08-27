/**
 * Probe: can OAuth (Codex/ChatGPT) tokens mint Realtime client secrets?
 * And does the current API-key path work? Read-only diagnostics, no changes.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const settings = JSON.parse(readFileSync(join(homedir(), ".pane", "settings.json"), "utf-8"));
const apiKey = settings.http_api_keys?.openai;
const codex = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf-8"));

async function probe(name, url, headers, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    console.log(`${name} → ${res.status} ${text.slice(0, 250).replace(/\n/g, " ")}`);
    return res.status;
  } catch (e) {
    console.log(`${name} → ERR ${e.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

const sessionBody = { session: { type: "realtime", model: "gpt-realtime" } };

// 1. Current voice path: api.openai.com with API key
await probe(
  "API-key api.openai.com/v1/realtime/client_secrets",
  "https://api.openai.com/v1/realtime/client_secrets",
  { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  sessionBody,
);

// 2. OAuth path: Codex backend
await probe(
  "OAuth chatgpt.com/backend-api/codex/v1/realtime/client_secrets",
  "https://chatgpt.com/backend-api/codex/v1/realtime/client_secrets",
  {
    Authorization: `Bearer ${codex.tokens.access_token}`,
    "Content-Type": "application/json",
    originator: "codex_cli_rs",
  },
  sessionBody,
);

// 3. OAuth path: plain api.openai.com with the ChatGPT OAuth token
//    (documents whether the token is accepted at the standard API edge)
await probe(
  "OAuth api.openai.com/v1/realtime/client_secrets",
  "https://api.openai.com/v1/realtime/client_secrets",
  {
    Authorization: `Bearer ${codex.tokens.access_token}`,
    "Content-Type": "application/json",
  },
  sessionBody,
);
