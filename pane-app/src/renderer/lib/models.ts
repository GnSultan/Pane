export interface EngineOption {
  label: string;
  provider: string;
  model: string;
  thinking: boolean;
  requiresKey: string;
  contextWindow?: number;
  inputCost?: number | null;  // $/Mtok input
  outputCost?: number | null; // $/Mtok output
}

export interface IntentRouting {
  plan: { provider: string; model: string; thinking: boolean };
  execute: { provider: string; model: string; thinking: boolean };
  explain: { provider: string; model: string; thinking: boolean };
  other: { provider: string; model: string; thinking: boolean };
}

// Map of backendId -> Routing configuration
export type BackendRouting = Record<string, IntentRouting>;

export const DEFAULT_GEMINI_ROUTING: IntentRouting = {
  plan: { provider: "gemini", model: "gemini-3-flash-preview", thinking: false },
  execute: { provider: "gemini", model: "gemini-3-flash-preview", thinking: false },
  explain: { provider: "gemini", model: "gemini-3-flash-preview", thinking: false },
  other: { provider: "gemini", model: "gemini-3-flash-preview", thinking: false },
};

export const DEFAULT_HTTP_ROUTING: IntentRouting = {
  plan: {
    provider: "deepseek",
    model: "deepseek-r1",
    thinking: true,
  },
  execute: {
    provider: "deepseek",
    model: "deepseek-v3",
    thinking: false,
  },
  explain: {
    provider: "deepseek",
    model: "deepseek-v3",
    thinking: false,
  },
  other: {
    provider: "deepseek",
    model: "deepseek-v3",
    thinking: false,
  },
};

export const DEFAULT_CLAUDE_CODE_ROUTING: IntentRouting = {
  plan: { provider: "anthropic", model: "claude-opus-4-6", thinking: false },
  execute: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
  explain: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
  other: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
};

export const DEFAULT_BACKEND_ROUTING: BackendRouting = {
  api: DEFAULT_HTTP_ROUTING,
  "claude-code": DEFAULT_CLAUDE_CODE_ROUTING,
  "gemini": DEFAULT_GEMINI_ROUTING,
};

export function isThinkingModel(model: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return (
    lower.includes("reasoner") ||
    lower.includes("thinking") ||
    lower.includes("r1") ||
    lower.includes("reasoning") ||
    lower.includes("thought") ||
    lower.includes("o1-") ||
    lower.includes("o3-") ||
    lower.includes("pro-thinking") ||
    lower.includes("next") || // Many reasoning models use "next" (e.g. Qwen Next)
    lower.includes("step-") ||
    lower.includes("flash-lite") ||
    lower.includes("trinity")
  );
}

export function engineKey(e: EngineOption) {
  return `${e.provider}::${e.model}`;
}

export function keyFromRoute(
  route: { provider: string; model: string } | undefined | null,
) {
  if (!route) return "none::none";
  return `${route.provider}::${route.model}`;
}

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude 4.6 models with 1M context beta
  "claude-opus-4-6": 1000000,
  "claude-sonnet-4-6": 1000000,
  "claude-haiku-4-5-20251001": 200000,
  "opus": 1000000,
  "sonnet": 1000000,
  "haiku": 200000,
};

/**
 * Get context window for a model. Returns the API-reported context_length when
 * available (passed through allModels), falling back to MODEL_CONTEXT_LIMITS
 * for SDK-alias resolution (opus/sonnet/haiku) and a 128k default.
 */
export function getContextLimit(model: string | null): number {
  if (!model) return 128000;

  // Exact match
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];

  // Partial match for aliases
  const lower = model.toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lower.includes(key)) return limit;
  }

  return 128000;
}

/**
 * Get context window limit for a specific provider and model combination.
 */
export function getContextWindowForModel(provider: string, model: string): number {
  const fullModelId = `${provider}/${model}`;
  const fullResult = getContextLimit(fullModelId);
  if (fullResult !== 128000) return fullResult;
  return getContextLimit(model);
}
