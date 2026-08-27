/** Verify tool-calling round trip: model emits function_call → translation produces tool_calls chunk */
const { app } = require("electron");
const { readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");

app.whenReady().then(async () => {
  try {
    const base = pathToFileURL(join(__dirname, "..", "src", "main")).href;
    const codex = await import(`${base}/codex-client.mjs`);

    const raw = JSON.parse(readFileSync(join(require("node:os").homedir(), ".codex", "auth.json"), "utf-8"));

    const req = codex.buildResponsesRequest({
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: "You must use the provided tool. Never answer directly." },
        { role: "user", content: "Run the shell command 'ls /tmp' using the tool." },
      ],
      tools: [{
        type: "function",
        function: {
          name: "run_shell_command",
          description: "Execute a shell command and return output",
          parameters: {
            type: "object",
            properties: { command: { type: "string", description: "The command" } },
            required: ["command"],
          },
        },
      }],
    });
    console.log("tools in request:", JSON.stringify(req.tools));

    const res = await codex.codexFetch(raw.tokens.access_token, raw.tokens.account_id, req);
    console.log("HTTP", res.status);
    if (!res.ok) {
      console.log((await res.text()).slice(0, 500));
      process.exitCode = 1;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let toolCalls = [];
    let text = "";

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
        for (const chunk of codex.responsesEventToChatChunks(ev)) {
          if (chunk.choices?.[0]?.delta?.content) text += chunk.choices[0].delta.content;
          const tcs = chunk.choices?.[0]?.delta?.tool_calls;
          if (tcs) toolCalls.push(...tcs);
        }
      }
    }

    console.log("\ntext:", JSON.stringify(text));
    console.log("toolCalls:", JSON.stringify(toolCalls, null, 2));

    if (toolCalls.length > 0) {
      const tc = toolCalls[0];
      const argsOk = (() => { try { return JSON.parse(tc.function.arguments).command; } catch { return null; } })();
      console.log(`\ntool: ${tc.function.name}, args.command: ${JSON.stringify(argsOk)}`);
      console.log("=== TOOL CALL ROUND TRIP VERIFIED ===");
    } else {
      console.log("\n=== NO TOOL CALL EMITTED (model answered in text) ===");
    }
  } catch (err) {
    console.error("CRASHED:", err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
