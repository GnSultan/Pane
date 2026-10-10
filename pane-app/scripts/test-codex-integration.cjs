/**
 * E2E test of the Codex client integration modules:
 *   buildResponsesRequest → codexFetch → responsesEventToChatChunks
 *
 * Simulates exactly what http-backend does for a tool-calling turn.
 */
const { app, net } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// Import the real modules (ESM) via dynamic import
async function loadModules() {
  const { pathToFileURL } = require("node:url");
  const base = pathToFileURL(join(__dirname, "..", "src", "main")).href;
  const codex = await import(`${base}/codex-client.mjs`);
  return { codex };
}

app.whenReady().then(async () => {
  let failures = 0;
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures++;
  };

  try {
    const { codex } = await loadModules();

    // ── 1. Request translation ──
    const chatBody = {
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: "You are Pane." },
        { role: "user", content: "list files" },
        {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "run_shell_command", arguments: "{\"command\":\"ls\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file1\nfile2" },
        { role: "user", content: "now read file1" },
      ],
      tools: [{
        type: "function",
        function: { name: "run_shell_command", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
      }],
    };

    const req = codex.buildResponsesRequest(chatBody);
    check("instructions extracted", req.instructions === "You are Pane.");
    check("input has 4 items", req.input.length === 4, `got ${req.input.length}`);
    check("user msg shape", req.input[0].type === "message" && req.input[0].role === "user");
    check("assistant tool_call item", req.input[1].type === "function_call" && req.input[1].call_id === "call_1", JSON.stringify(req.input[1]).slice(0, 80));
    check("tool result item", req.input[2].type === "function_call_output" && req.input[2].call_id === "call_1", JSON.stringify(req.input[2]).slice(0, 80));
    check("tools translated", req.tools[0].name === "run_shell_command" && req.tools[0].type === "function");
    check("stream forced", req.stream === true);
    check("store false", req.store === false);

    // ── 2. Live call through codexFetch ──
    const raw = JSON.parse(readFileSync(join(require("node:os").homedir(), ".codex", "auth.json"), "utf-8"));
    const token = raw.tokens.access_token;
    const accountId = raw.tokens.account_id;

    // Minimal request — no tools, just text
    const liveReq = codex.buildResponsesRequest({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Reply with exactly: INTEGRATION_OK" }],
    });

    const res = await codex.codexFetch(token, accountId, liveReq);
    check("codexFetch HTTP 200", res.status === 200, `status=${res.status}`);

    // ── 3. Stream + event translation ──
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage = null;
    let finishReason = null;
    let toolCallSeen = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        // Feed through the translation layer exactly like http-backend does
        for (const chunk of codex.responsesEventToChatChunks(ev)) {
          if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content;
          if (chunk.choices?.[0]?.delta?.tool_calls) toolCallSeen = true;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
        }
      }
    }

    check("text streamed", text.length > 0, `got ${JSON.stringify(text.slice(0, 60))}`);
    check("usage captured", !!usage, JSON.stringify(usage));
    check("finish_reason captured", finishReason === "stop", `got ${finishReason}`);
    console.log(`\n  full output: ${JSON.stringify(text)}`);

    // ── 4. Models list ──
    const models = await codex.codexModels(token, accountId);
    check("codexModels returns list", models.length > 0, `${models.length} models: ${models.slice(0, 4).map(m => m.id).join(", ")}...`);
    check("model shape", models[0].id && models[0].context_length > 0, `${models[0].id} ctx=${models[0].context_length}`);

    console.log(failures === 0 ? "\n=== ALL INTEGRATION TESTS PASSED ===" : `\n=== ${failures} FAILURES ===`);
    process.exitCode = failures ? 1 : 0;
  } catch (err) {
    console.error("TEST CRASHED:", err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
