import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// Node.js globals for utility process
const { AbortController, fetch, TextDecoder, setImmediate, console } =
  globalThis;

import { PunkBackend } from "./punk-backend.mjs";

// ============================================================================
// HTTP Backend (Kimi/DeepSeek/Anthropic/etc.)
// ============================================================================

export class HttpBackend extends PunkBackend {
  constructor(onEvent) {
    super(onEvent);
    this.activeRequests = new Map(); // projectId -> AbortController
    this.requestStates = new Map(); // projectId -> { accumulated: string, toolUses: Map }
    this.paneDir = path.join(os.homedir(), ".pane");
  }

  async readBrief(projectId) {
    try {
      const content = await fs.readFile(
        path.join(this.paneDir, "memory", projectId, "brief.md"),
        "utf-8",
      );
      return content.trim();
    } catch {
      return "";
    }
  }

  async readContextualMemories(projectId) {
    try {
      const raw = await fs.readFile(
        path.join(this.paneDir, "brain", "context", `${projectId}.json`),
        "utf-8",
      );
      const contextData = JSON.parse(raw);
      if (!contextData.memories?.length) return "";

      const memParts = ["## Relevant past experience"];
      for (const m of contextData.memories.slice(0, 5)) {
        memParts.push(
          `- [${m.type}] (confidence: ${(m.confidence || 0.5).toFixed(1)}) ${m.content}`,
        );
      }
      if (contextData.tensions?.length > 0) {
        memParts.push("\n## Potential tensions with past decisions");
        for (const t of contextData.tensions.slice(0, 2)) {
          memParts.push(
            `- Past: "${t.pastDecision}" (confidence ${t.pastConfidence.toFixed(2)})`,
          );
          memParts.push(`  Current: "${t.newDecision}"`);
          memParts.push(`  Consider whether the past decision still applies.`);
        }
      }
      if (contextData.crossProjectInsights?.length > 0) {
        memParts.push("\n## Insights from other projects");
        for (const cp of contextData.crossProjectInsights.slice(0, 3)) {
          memParts.push(
            `- [${cp.project}] [${cp.type}] (confidence: ${cp.confidence.toFixed(1)}) ${cp.content}`,
          );
        }
      }
      return memParts.join("\n");
    } catch {
      return "";
    }
  }

  async readProfile() {
    try {
      const content = await fs.readFile(
        path.join(this.paneDir, "profile", "profile-export.md"),
        "utf-8",
      );
      return content.trim().length > 30 ? content.trim() : "";
    } catch {
      return "";
    }
  }

  async buildSystemPrompt(projectId, intent) {
    const profile = await this.readProfile();
    const brief = await this.readBrief(projectId);
    const contextualMemories = await this.readContextualMemories(projectId);

    let systemPrompt = "";

    if (profile) {
      let cappedProfile = profile;
      if (profile.length > 2000) {
        cappedProfile = profile.slice(0, 2000);
        const lastSection = cappedProfile.lastIndexOf("\n##");
        if (lastSection > 200)
          cappedProfile = cappedProfile.slice(0, lastSection);
      }
      systemPrompt += cappedProfile + "\n\n";
    }

    if (brief) {
      let cappedBrief = brief;
      if (brief.length > 3500) {
        const truncated = brief.slice(0, 3500);
        const lastSection = truncated.lastIndexOf("\n###");
        cappedBrief =
          lastSection > 500 ? truncated.slice(0, lastSection) : truncated;
      }
      systemPrompt += cappedBrief + "\n\n";
    }

    if (contextualMemories) {
      systemPrompt += contextualMemories + "\n\n";
    }

    if (intent === "execute") {
      systemPrompt += `You are in EXECUTION mode. Just do what is requested directly and efficiently. Skip planning or asking for permission unless absolutely necessary for safety or clarity.`;
    } else if (intent === "plan") {
      systemPrompt += `You are in PLANNING mode. Think deeply and reason carefully. Explore the architecture space, consider tradeoffs, and surface tensions with past decisions before recommending a direction. Present your reasoning transparently. End architectural proposals with a clear recommendation and ask the user to confirm before any implementation begins.`;
    } else if (intent === "explain") {
      systemPrompt += `You are in EXPLANATION mode. Your goal is to help the user understand the codebase. Provide clear, detailed, and accurate explanations. Use code examples where appropriate to illustrate your points.`;
    } else {
      systemPrompt += `For non-trivial tasks, present a brief plan FIRST and end with: "Ready to proceed — send 'go' to start." Wait for the user to confirm before making changes. For simple tasks (quick fixes, single-file edits, questions), just do them directly.`;
    }

    return systemPrompt;
  }

  /**
   * Load API config for a given provider from settings.json.
   * Always reads from disk so it picks up keys saved after startup.
   * @param {string|null} providerOverride
   * @returns {Promise<{provider: string, apiKey: string, baseUrl?: string}>}
   */
  async getApiConfig(providerOverride = null) {
    try {
      const content = await fs.readFile(
        path.join(this.paneDir, "settings.json"),
        "utf-8",
      );
      const settings = JSON.parse(content);

      const provider = providerOverride || settings.http_provider || "deepseek";

      // Multi-key map takes precedence; fall back to legacy single key
      let apiKey = "";
      if (settings.http_api_keys?.[provider]) {
        apiKey = settings.http_api_keys[provider];
      } else if (settings.http_api_key) {
        apiKey = settings.http_api_key;
      }

      let baseUrl;
      if (settings.http_base_urls?.[provider]) {
        baseUrl = settings.http_base_urls[provider];
      } else if (settings.http_base_url) {
        baseUrl = settings.http_base_url;
      }

      return { provider, apiKey, baseUrl };
    } catch {
      return {
        provider: providerOverride || "deepseek",
        apiKey: "",
        baseUrl: undefined,
      };
    }
  }

  /**
   * Validate API config. Error message is intentionally provider-agnostic —
   * Pane doesn't surface model names to users.
   */
  validateApiConfig(config) {
    if (!config.apiKey) {
      throw new Error(
        `No API key configured. Open settings (⌘,) and add a key under API Keys.`,
      );
    }
    return true;
  }

  async spawn(request) {
    const abortController = new AbortController();
    this.activeRequests.set(request.projectId, abortController);
    this.requestStates.set(request.projectId, {
      accumulated: "",
      toolUses: new Map(),
    });

    this.onEvent(request.projectId, { event: "processStarted", data: null });

    try {
      const systemPrompt = await this.buildSystemPrompt(
        request.projectId,
        request.intent,
      );
      const apiConfig = await this.getApiConfig(request.provider || null);
      this.validateApiConfig(apiConfig);

      // Emit synthetic init event after config is validated
      this.onEvent(request.projectId, {
        event: "message",
        data: {
          parsed: {
            type: "system",
            subtype: "init",
            session_id: request.sessionId || `http-${Date.now()}`,
            tools: [],
            model: request.model || this.getDefaultModel(apiConfig.provider),
          },
        },
      });

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: request.prompt },
      ];

      const body = {
        model: this.mapModelName(apiConfig.provider, request.model),
        messages,
        stream: true,
        max_tokens: 4096,
      };

      if (request.thinking && apiConfig.provider === "kimi") {
        body.temperature = 1;
        body.max_tokens = 8192;
      }

      const { url, headers } = this.prepareRequest(apiConfig, body, request);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => response.statusText);
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      if (!response.body) throw new Error("Response body is null");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let hasEmittedContent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            const emitted = this.handleStreamEvent(
              request.projectId,
              parsed,
              apiConfig.provider,
            );
            if (emitted) hasEmittedContent = true;
          } catch (err) {
            console.error("[punk] Failed to parse SSE data:", err, data);
          }
        }
      }

      const state = this.requestStates.get(request.projectId);
      if (!hasEmittedContent && state?.accumulated) {
        this.onEvent(request.projectId, {
          event: "message",
          data: {
            parsed: {
              type: "assistant",
              message: { content: [{ type: "text", text: state.accumulated }] },
            },
          },
        });
      }

      this.onEvent(request.projectId, {
        event: "processEnded",
        data: { exit_code: 0 },
      });
    } catch (error) {
      if (error.name === "AbortError") {
        this.onEvent(request.projectId, {
          event: "processEnded",
          data: { exit_code: null },
        });
      } else {
        this.onEvent(request.projectId, {
          event: "error",
          data: { message: error.message },
        });
        this.onEvent(request.projectId, {
          event: "processEnded",
          data: { exit_code: 1 },
        });
      }
    } finally {
      this.activeRequests.delete(request.projectId);
      this.requestStates.delete(request.projectId);
    }
  }

  prepareRequest(apiConfig, body, request = {}) {
    let url, headers;

    switch (apiConfig.provider) {
      case "deepseek":
        url =
          apiConfig.baseUrl || "https://api.deepseek.com/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        break;
      case "kimi":
        url =
          apiConfig.baseUrl || "https://api.moonshot.cn/v1/chat/completions";
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        };
        break;
      case "gemini":
        url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:streamGenerateContent`;
        headers = { "Content-Type": "application/json" };
        // Gemini has no separate API key header, it's in the URL
        url += `?key=${apiConfig.apiKey}`;

        // Gemini uses a different body structure and needs history
        const contents = [];
        // Gemini uses "user" and "model" roles
        if (request.history) {
          for (const message of request.history) {
            if (message.type === "user") {
              contents.push({
                role: "user",
                parts: message.content
                  .filter((c) => c.type === "text")
                  .map((c) => ({ text: c.text })),
              });
            } else if (message.type === "assistant") {
              contents.push({
                role: "model",
                parts: message.content
                  .filter((c) => c.type === "text")
                  .map((c) => ({ text: c.text })),
              });
            }
          }
        }
        contents.push({ role: "user", parts: [{ text: request.prompt }] });

        body = {
          contents,
          systemInstruction: {
            parts: [
              {
                text:
                  body.messages.find((m) => m.role === "system")?.content || "",
              },
            ],
          },
        };
        break;
      case "anthropic":
        url = apiConfig.baseUrl || "https://api.anthropic.com/v1/messages";
        headers = {
          "Content-Type": "application/json",
          "x-api-key": apiConfig.apiKey,
          "anthropic-version": "2023-06-01",
        };
        body.messages = body.messages.filter((m) => m.role !== "system");
        if (body.messages[0]?.role === "system") {
          body.system = body.messages[0].content;
          body.messages = body.messages.slice(1);
        }
        break;
      default:
        throw new Error(`Unsupported provider: ${apiConfig.provider}`);
    }

    return { url, headers };
  }

  getDefaultModel(provider) {
    switch (provider) {
      case "gemini":
        return "gemini-3-flash-preview";
      case "deepseek":
        return "deepseek-chat";
      case "kimi":
        return "moonshot-v1-128k";
      case "anthropic":
        return "claude-3-5-sonnet-20241022";
      default:
        return "gpt-4";
    }
  }

  mapModelName(provider, model) {
    if (!model) return this.getDefaultModel(provider);
    if (model.includes("-") && /(\d|v\d)/.test(model)) return model;

    if (provider === "anthropic") {
      const map = {
        opus: "claude-3-opus-20240229",
        opusplan: "claude-3-opus-20240229",
        sonnet: "claude-3-5-sonnet-20241022",
        haiku: "claude-3-haiku-20240307",
      };
      return map[model.toLowerCase()] || this.getDefaultModel(provider);
    }

    return model;
  }

  handleStreamEvent(projectId, event, provider) {
    const state = this.requestStates.get(projectId);
    if (!state) return false;

    let content = "";
    let finishReason = null;
    let toolUse = null;

    switch (provider) {
      case "deepseek":
      case "kimi":
        if (event.choices?.[0]?.delta?.content)
          content = event.choices[0].delta.content;
        if (event.choices?.[0]?.delta?.tool_calls) {
          const tc = event.choices[0].delta.tool_calls[0];
          if (tc)
            toolUse = {
              id: tc.id,
              name: tc.function?.name,
              input: tc.function?.arguments || "",
            };
        }
        finishReason = event.choices?.[0]?.finish_reason;
        break;

      case "gemini":
        if (event.candidates?.[0]?.content?.parts?.[0]?.text) {
          content = event.candidates[0].content.parts[0].text;
        }
        finishReason = event.candidates?.[0]?.finishReason;
        break;

      case "anthropic":
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        )
          content = event.delta.text;
        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "tool_use"
        ) {
          toolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: event.content_block.input || {},
          };
        }
        if (event.type === "message_stop") finishReason = "stop";
        break;
    }

    let emitted = false;

    if (toolUse && !state.toolUses.has(toolUse.id)) {
      state.toolUses.set(toolUse.id, toolUse);
      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", ...toolUse },
            },
          },
        },
      });
      emitted = true;
    }

    if (content) {
      state.accumulated += content;
      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: content },
            },
          },
        },
      });
      emitted = true;
    }

    if (finishReason && (state.accumulated || state.toolUses.size > 0)) {
      const contentBlocks = [];
      if (state.accumulated)
        contentBlocks.push({ type: "text", text: state.accumulated });
      for (const tool of state.toolUses.values()) {
        contentBlocks.push({
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input:
            typeof tool.input === "string"
              ? JSON.parse(tool.input)
              : tool.input,
        });
      }
      this.onEvent(projectId, {
        event: "message",
        data: {
          parsed: { type: "assistant", message: { content: contentBlocks } },
        },
      });
      emitted = true;
    }

    return emitted;
  }

  async abort(projectId) {
    const controller = this.activeRequests.get(projectId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(projectId);
    }
    this.requestStates.delete(projectId);
  }

  async terminate(projectId) {
    await this.abort(projectId);
  }

  async shutdown() {
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
    this.requestStates.clear();
  }
}
