import type { ConversationState } from "./punk-types";

export type AgentIntent = "plan" | "execute" | "explain" | "other";

interface RoutingContext {
  prompt: string;
  conversation: ConversationState;
}

const PLAN_KEYWORDS = [
  "plan",
  "architecture",
  "design",
  "strategy",
  "roadmap",
  "approach",
  "high level",
  "refactor",
  "trade-off",
  "tradeoff",
  "options",
  "explore",
  "architect",
  "redesign",
  "rethink",
  "rearchitect",
  "structure",
  "pattern",
  "principle",
  "philosophy",
  "evaluate",
  "assess",
  "consider",
  "why",
  "how should",
];

const EXECUTE_KEYWORDS = [
  "implement",
  "apply",
  "edit",
  "change",
  "fix",
  "bug",
  "error",
  "traceback",
  "stack trace",
  "run",
  "test",
  "write code",
  "open file",
  "rename",
  "delete",
  "create",
  "build",
  "add",
  "make",
  "generate",
  "update",
  "remove",
  "move",
  "patch",
  "debug",
  "just",
  "quickly",
  "fast",
  "now",
];

const EXPLAIN_KEYWORDS = [
  "explain",
  "understand",
  "what does this do",
  "how does this work",
  "walk me through",
  "teach me",
  "clarify",
  "breakdown",
  "break down",
];

const SHORT_EXECUTION_COMMANDS = /^(go|proceed|yes|do it|start|build it|write it|make it|ship it|run it|ok|okay|yep|yeah|continue|next)\.?$/i;

function includesKeyword(prompt: string, keywords: string[]): boolean {
  const lower = prompt.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

export function inferAgentIntent(ctx: RoutingContext): AgentIntent {
  const { prompt } = ctx;
  const trimmed = prompt.trim();

  // 1. Explicit overrides
  if (trimmed.startsWith("/plan")) return "plan";
  if (trimmed.startsWith("/exec")) return "execute";
  if (trimmed.startsWith("/explain")) return "explain";

  // 2. Short command-like prompts → check for execution signals
  if (SHORT_EXECUTION_COMMANDS.test(trimmed)) {
    return "execute";
  }

  // 3. Keyword matching
  if (includesKeyword(prompt, EXPLAIN_KEYWORDS)) return "explain";
  if (includesKeyword(prompt, PLAN_KEYWORDS)) return "plan";
  if (includesKeyword(prompt, EXECUTE_KEYWORDS)) return "execute";

  // 5. Heuristic: very long, multi-paragraph prompts tend to be planning / design.
  const lineCount = prompt.split("\n").length;
  if (lineCount >= 8 || prompt.length > 1200) return "plan";

  return "other";
}

/**
 * Map a (model, intent) pair to the concrete CLI model name.
 * For now this only tweaks known aliases; later this can route
 * across entirely different providers.
 */
export function chooseModelForIntent(
  selectedModel: string | null,
  intent: AgentIntent,
): string | null {
  if (!selectedModel) return null;

  const lower = selectedModel.toLowerCase();

  // Opus "plan" alias: keep UI-friendly name, map to real model in claude-worker.
  if (intent === "plan") {
    if (lower.includes("opus")) {
      return "opusplan";
    }
  }

  // For now, default: return the user-selected model unchanged.
  return selectedModel;
}

