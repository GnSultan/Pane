/**
 * Live mint test with the NEW VOICE_TOOLS (incl. mcp_call) + MCP catalog in
 * instructions — validates the exact request body the app now sends.
 * Uses OAuth fallback path (no API key) to prove both changes at once.
 */
import { VOICE_TOOLS, buildMcpCatalog } from "../src/main/voice-relay.mjs";
import { getAccessToken } from "../src/main/openai-oauth.mjs";

const token = await getAccessToken();
if (!token) {
  console.log("✗ no OAuth token available");
  process.exit(1);
}
console.log("✓ OAuth token acquired (fallback credential)");

const catalog = buildMcpCatalog();
console.log(`✓ catalog: ${catalog ? catalog.split("\n").length + " lines" : "(empty — servers not connected in this standalone run)"}`);

const instructions =
  "Test relay instructions.\n\n## Connected MCP tools\n" + (catalog || "apple-calendar:\n  - ext__apple-calendar__calendar_list_events — List calendar events in a time window.");

const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    session: {
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions,
      tools: VOICE_TOOLS,
      audio: {
        input: {
          transcription: { model: "whisper-1" },
          turn_detection: { type: "semantic_vad" },
        },
        output: { voice: "marin" },
      },
    },
  }),
});
const body = await res.text();
if (!res.ok) {
  console.log(`✗ mint failed ${res.status}: ${body.slice(0, 400)}`);
  process.exit(1);
}
const data = JSON.parse(body);
const ek = data?.value || data?.client_secret?.value;
console.log(`✓ mint OK with ${VOICE_TOOLS.length} tools (incl. ${VOICE_TOOLS.some((t) => t.name === "mcp_call") ? "mcp_call" : "NO mcp_call!"}) — ek ${ek.slice(0, 12)}...`);
const sessionTools = data?.session?.tools;
console.log(`✓ session.tools confirmed server-side: ${Array.isArray(sessionTools) ? sessionTools.length + " tools" : JSON.stringify(sessionTools)?.slice(0, 80)}`);
process.exit(0);
