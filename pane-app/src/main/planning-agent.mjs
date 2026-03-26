/**
 * Planning Agent — multi-model orchestration, no approval gate.
 *
 * Flow: planning model explores + writes a natural markdown plan (streams to user)
 *       → execution model receives plan as context and implements immediately.
 *
 * No JSON parsing, no structured validation, no user approval step.
 * The plan is the model's natural output — readable in the conversation.
 */

// Internal tool names that are scaffolding, not user-facing work.
const INTERNAL_TOOLS = new Set([
  "TodoWrite", "TodoRead",
  "ToolSearch", "AskUserQuestion", "CronCreate", "CronDelete", "CronList",
  "EnterWorktree", "ExitWorktree", "TaskCreate", "TaskGet", "TaskList",
  "TaskOutput", "TaskStop", "TaskUpdate", "NotebookEdit",
]);

/**
 * Run the planning model — it explores the codebase and writes a natural
 * markdown plan that streams directly to the user's conversation view.
 *
 * Returns the captured plan text (for handoff to execution model), or null on failure.
 *
 * @param {{ request, planRoute, strategy, backend, onEvent }} opts
 * @returns {Promise<string|null>}
 */
export async function runPlanningAgent({ request, planRoute, strategy, backend, onEvent }) {
  const projectId    = request.projectId;
  const isCliBackend = !backend.supportsToolCalling;

  const systemInstructions = strategy.discovery
    ? PLANNING_PROMPT_DISCOVERY
    : PLANNING_PROMPT;

  // CLI backends: system instructions fold into the prompt (no separate system prompt channel).
  // HTTP backends: _systemPrepend becomes the system prompt so instructions don't pollute user turn.
  const planningPrompt = isCliBackend
    ? `${systemInstructions}\n\n---\n\nTask: ${request.prompt}`
    : request.prompt;

  const planningRequestId = `planning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const planningRequest = {
    ...request,
    requestId:      planningRequestId,
    provider:       planRoute.provider,
    model:          planRoute.model,
    thinking:       planRoute.thinking ?? (strategy.reasoning === "deep"),
    prompt:         planningPrompt,
    _systemPrepend: isCliBackend ? undefined : systemInstructions,
  };

  let capturedText = "";
  let spawnDoneResolve;
  const spawnDone = new Promise(r => { spawnDoneResolve = r; });

  const originalOnEvent = backend.onEvent;
  backend.onEvent = (pid, event, rid) => {
    if (rid !== planningRequestId) {
      // Not our event — pass through unchanged.
      onEvent(pid, event, rid);
      return;
    }

    const msgType = event.data?.parsed?.type;

    // ── Text capture ────────────────────────────────────────────────────
    // CLI (claude-agent-sdk): authoritative final text arrives in the `result` message.
    if (event.event === "message" && msgType === "result") {
      const rt = event.data.parsed.result;
      if (typeof rt === "string" && rt.trim()) capturedText = rt;
      // Suppress from renderer — text_delta already rendered it progressively.
      return;
    }
    // HTTP: final assistant message carries the complete text.
    // Also capture streaming text_delta chunks as fallback.
    if (event.event === "message" && msgType === "stream_event") {
      const streamEvt = event.data.parsed.event ?? event.data.parsed.data;
      const delta = streamEvt?.delta;
      if (delta?.type === "text_delta") capturedText += delta.text || "";
    }
    if (event.event === "message" && msgType === "assistant") {
      const blocks = event.data.parsed.message?.content || [];
      const text   = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      if (text.trim()) capturedText = text;
    }

    // ── Terminal signal ──────────────────────────────────────────────────
    // Suppress processEnded — the renderer must not think the main request ended.
    // We fire it ourselves after execution completes.
    if (event.event === "processEnded") {
      spawnDoneResolve();
      return;
    }

    // ── Session ID protection ────────────────────────────────────────────
    // The planning model runs in its own session. Its init event must not
    // overwrite the main conversation's session ID in the renderer.
    if (event.event === "message" && msgType === "system" &&
        event.data?.parsed?.subtype === "init") return;

    // ── Internal tool filtering ──────────────────────────────────────────
    // Don't surface Claude Code scaffolding tools (TodoWrite, etc.) to the user.
    if (event.event === "message" && msgType === "tool_use" &&
        INTERNAL_TOOLS.has(event.data.parsed.name)) return;

    if (event.event === "message" && msgType === "assistant") {
      const blocks   = event.data?.parsed?.message?.content || [];
      const onlyInternal = blocks.every(
        b => b.type !== "tool_use" || INTERNAL_TOOLS.has(b.name),
      );
      if (onlyInternal) return; // pure scaffolding turn — skip
    }

    // Rename agent/Task tool uses to pane_plan so UI labels them sensibly.
    let outEvent = event;
    if (event.event === "message" && msgType === "tool_use" &&
        (event.data.parsed.name === "agent" || event.data.parsed.name === "Task")) {
      outEvent = {
        ...event,
        data: { ...event.data, parsed: { ...event.data.parsed, name: "pane_plan" } },
      };
    }

    // Forward everything else (tool calls, text, errors) under the main requestId
    // so the user sees the planning model working in real time.
    onEvent(pid, outEvent, request.requestId);
  };

  try {
    await backend.spawn(planningRequest);
    await spawnDone;
  } catch (err) {
    console.error("[planning-agent] spawn failed:", err.message);
    onEvent(projectId, {
      event: "orchestration_error",
      data: { message: `Planning failed: ${err.message}` },
    }, request.requestId);
    return null;
  } finally {
    backend.onEvent = originalOnEvent;
  }

  if (!capturedText.trim()) {
    console.warn("[planning-agent] no plan text captured from planning model");
    return null;
  }

  console.log(
    `[planning-agent] plan captured: ${capturedText.length} chars — ` +
    `"${capturedText.slice(0, 80).replace(/\n/g, " ")}"`,
  );
  return capturedText;
}

// ── System prompts ───────────────────────────────────────────────────────────

const PLANNING_PROMPT = `You are the planning agent for Pane, a code editor. Your job:

1. Use your tools (read_file, list_directory, glob, search) to explore the codebase and understand what needs to change.
2. Write a clear, detailed implementation plan in plain markdown.

Write the plan as you would explain it to a senior colleague who will implement it:
- Organize by phases or sections
- Describe what changes in each file and why
- Note architectural decisions or tradeoffs
- Be specific about where exactly in each file the changes go
- End with scope: estimated files and change count

The execution model will read your plan and implement it immediately. Be thorough.

Do NOT write any code. Do NOT use structured JSON formats. Just plan in plain language.`;

const PLANNING_PROMPT_DISCOVERY = `${PLANNING_PROMPT}

The task scope is not fully defined — explore broadly before planning. Check the directory structure, read relevant files, understand the architecture before committing to a plan.`;
