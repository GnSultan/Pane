export interface EngineOption {
  label: string;
  provider: string;
  model: string;
  thinking: boolean;
  requiresKey: string;
  contextWindow?: number; // Token context window limit for this model
}

export interface IntentRouting {
  plan: { provider: string; model: string; thinking: boolean };
  execute: { provider: string; model: string; thinking: boolean };
  explain: { provider: string; model: string; thinking: boolean };
  other: { provider: string; model: string; thinking: boolean };
}

// Map of backendId -> Routing configuration
export type BackendRouting = Record<string, IntentRouting>;

export const DEFAULT_GEMINI_CLI_ROUTING: IntentRouting = {
  plan: { provider: "gemini", model: "auto-gemini-3", thinking: false },
  execute: { provider: "gemini", model: "auto-gemini-3", thinking: false },
  explain: { provider: "gemini", model: "auto-gemini-3", thinking: false },
  other: { provider: "gemini", model: "auto-gemini-3", thinking: false },
};

export const DEFAULT_HTTP_ROUTING: IntentRouting = {
  plan: {
    provider: "openrouter",
    model: "xiaomi/mimo-v2-flash",
    thinking: true,
  },
  execute: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-5",
    thinking: false,
  },
  explain: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-5",
    thinking: false,
  },
  other: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-5",
    thinking: false,
  },
};

export const DEFAULT_CLAUDE_CLI_ROUTING: IntentRouting = {
  plan: { provider: "anthropic", model: "claude-opus-4-6", thinking: false },
  execute: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
  explain: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
  other: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
};

export const DEFAULT_BACKEND_ROUTING: BackendRouting = {
  http: DEFAULT_HTTP_ROUTING,
  "gemini-cli": DEFAULT_GEMINI_CLI_ROUTING,
  "claude-cli": DEFAULT_CLAUDE_CLI_ROUTING,
};

// Deprecated — use DEFAULT_BACKEND_ROUTING instead
export const DEFAULT_ROUTING = DEFAULT_GEMINI_CLI_ROUTING;

export const THINKING_ENGINES: EngineOption[] = [
  {
    label: "DeepSeek Reasoner (R1)",
    provider: "deepseek",
    model: "deepseek-reasoner",
    thinking: true,
    requiresKey: "deepseek",
    contextWindow: 128000,
  },
  {
    label: "Gemini 3 Flash",
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
    requiresKey: "gemini",
    contextWindow: 1000000,
  },
  {
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    model: "gemini-3.1-pro-preview-customtools",
    thinking: false,
    requiresKey: "gemini",
    contextWindow: 2000000,
  },
  {
    label: "Gemini 1.5 Pro",
    provider: "gemini",
    model: "gemini-1.5-pro-latest",
    thinking: false,
    requiresKey: "gemini",
    contextWindow: 1000000,
  },
  {
    label: "Kimi K2.5 (Thinking)",
    provider: "kimi",
    model: "moonshot-v1-128k",
    thinking: true,
    requiresKey: "kimi",
    contextWindow: 128000,
  },
  {
    label: "Claude Opus 4.6",
    provider: "anthropic",
    model: "claude-opus-4-6",
    thinking: false,
    requiresKey: "anthropic",
    contextWindow: 200000,
  },
  {
    label: "Claude Sonnet 4.5 (OR)",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-5",
    thinking: false,
    requiresKey: "openrouter",
    contextWindow: 200000,
  },
  {
    label: "DeepSeek R1 (OR)",
    provider: "openrouter",
    model: "deepseek/deepseek-r1",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Qwen3 Coder 480B (Free)",
    provider: "openrouter",
    model: "qwen/qwen3-coder:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 262144,
  },
  {
    label: "Qwen3 Coder 480B (Paid)",
    provider: "openrouter",
    model: "qwen/qwen3-coder",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 262144,
  },
  {
    label: "Step 3.5 Flash (OR)",
    provider: "openrouter",
    model: "stepfun/step-3.5-flash:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Llama 3.3 70B (OR)",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Arcee Trinity Mini (Free)",
    provider: "openrouter",
    model: "arcee-ai/trinity-mini:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 131072,
  },
  {
    label: "Qwen3 Next 80B (Free)",
    provider: "openrouter",
    model: "qwen/qwen3-next-80b-a3b-instruct:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 262144,
  },
  {
    label: "GLM 4.5 Air (Free)",
    provider: "openrouter",
    model: "z-ai/glm-4.5-air:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 131072,
  },
  {
    label: "GPT-OSS-120B (Free)",
    provider: "openrouter",
    model: "openai/gpt-oss-120b:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 131072,
  },
  {
    label: "Hermes 3 405B (OR)",
    provider: "openrouter",
    model: "nousresearch/hermes-3-llama-3.1-405b:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Xiaomi MiMo-V2-Flash (OR)",
    provider: "openrouter",
    model: "xiaomi/mimo-v2-flash",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
];

export const BUILDING_ENGINES: EngineOption[] = [
  {
    label: "DeepSeek Chat (V3.2)",
    provider: "deepseek",
    model: "deepseek-chat",
    thinking: false,
    requiresKey: "deepseek",
    contextWindow: 128000,
  },
  {
    label: "Gemini 3 Flash",
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
    requiresKey: "gemini",
    contextWindow: 1000000,
  },
  {
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    thinking: false,
    requiresKey: "gemini",
    contextWindow: 2000000,
  },
  {
    label: "Gemini 3 Flash (Preview)",
    provider: "gemini",
    model: "gemini-3-flash-preview",
    thinking: false,
    requiresKey: "gemini",
    contextWindow: 1000000,
  },
  {
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinking: false,
    requiresKey: "anthropic",
    contextWindow: 200000,
  },
  {
    label: "Claude Sonnet 4.5 (OR)",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4-5",
    thinking: false,
    requiresKey: "openrouter",
    contextWindow: 200000,
  },
  {
    label: "Gemini 2.0 Flash (OR)",
    provider: "openrouter",
    model: "google/gemini-2.0-flash-001",
    thinking: false,
    requiresKey: "openrouter",
    contextWindow: 1000000,
  },
  {
    label: "Qwen3 Coder 480B (Free)",
    provider: "openrouter",
    model: "qwen/qwen3-coder:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 262144,
  },
  {
    label: "Qwen3 Coder 480B (Paid)",
    provider: "openrouter",
    model: "qwen/qwen3-coder",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 262144,
  },
  {
    label: "Step 3.5 Flash (OR)",
    provider: "openrouter",
    model: "stepfun/step-3.5-flash:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Llama 3.3 70B (OR)",
    provider: "openrouter",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Arcee Trinity Mini (Free)",
    provider: "openrouter",
    model: "arcee-ai/trinity-mini:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 131072,
  },
  {
    label: "Qwen3 Next 80B (Free)",
    provider: "openrouter",
    model: "qwen/qwen3-next-80b-a3b-instruct:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 262144,
  },
  {
    label: "GLM 4.5 Air (Free)",
    provider: "openrouter",
    model: "z-ai/glm-4.5-air:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 131072,
  },
  {
    label: "GPT-OSS-120B (Free)",
    provider: "openrouter",
    model: "openai/gpt-oss-120b:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 131072,
  },
  {
    label: "Hermes 3 405B (OR)",
    provider: "openrouter",
    model: "nousresearch/hermes-3-llama-3.1-405b:free",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
  {
    label: "Xiaomi MiMo-V2-Flash (OR)",
    provider: "openrouter",
    model: "xiaomi/mimo-v2-flash",
    thinking: true,
    requiresKey: "openrouter",
    contextWindow: 128000,
  },
];

export const PROVIDER_MODELS: Record<
  string,
  Array<{ value: string; label: string }>
> = {
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek Chat (V3.2)" },
    { value: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)" },
  ],
  kimi: [
    { value: "moonshot-v1-8k", label: "Kimi K2.5 (Fast)" },
    { value: "moonshot-v1-128k", label: "Kimi K2.5 (Thinking)" },
  ],
  gemini: [
    { value: "auto-gemini-3", label: "Gemini 3 Flash" },
    { value: "auto-gemini-3.1", label: "Gemini 3.1" },
    {
      value: "gemini-3.1-pro-preview-customtools",
      label: "Gemini 3.1 Pro (Tools)",
    },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
    { value: "gemini-1.5-pro-latest", label: "Gemini 1.5 Pro" },
  ],
  openrouter: [
    { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 (OR)" },
    { value: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash (OR)" },
    { value: "deepseek/deepseek-chat", label: "DeepSeek V3 (OR)" },
    { value: "deepseek/deepseek-r1", label: "DeepSeek R1 (OR)" },
    { value: "openai/gpt-4o", label: "GPT-4o (OR)" },
    {
      value: "google/gemini-2.0-flash-lite-preview-02-05:free",
      label: "Gemini 2.0 Flash Lite (Free)",
    },
    {
      value: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Llama 3.3 70B (Free)",
    },
    {
      value: "mistralai/mistral-small-3.1-24b-instruct:free",
      label: "Mistral Small 24B (Free)",
    },
    {
      value: "nousresearch/hermes-3-llama-3.1-405b:free",
      label: "Hermes 3 405B (Free)",
    },
    {
      value: "arcee-ai/trinity-mini:free",
      label: "Arcee Trinity Mini (Free)",
    },
    {
      value: "qwen/qwen3-next-80b-a3b-instruct:free",
      label: "Qwen3 Next 80B (Free)",
    },
    {
      value: "openai/gpt-oss-120b:free",
      label: "GPT-OSS-120B (Free)",
    },
    {
      value: "z-ai/glm-4.5-air:free",
      label: "GLM 4.5 Air (Free)",
    },
    {
      value: "nvidia/nemotron-3-super-120b-a12b:free",
      label: "Nemotron 3 Super (Free)",
    },
    {
      value: "minimax/minimax-m2.5:free",
      label: "MiniMax M2.5 (Free)",
    },
    { value: "xiaomi/mimo-v2-flash", label: "Xiaomi MiMo-V2-Flash" },
    { value: "stepfun/step-3.5-flash:free", label: "Step 3.5 Flash (Free)" },
    {
      value: "mistralai/mistral-7b-instruct:free",
      label: "Mistral 7B (Free)",
    },
    {
      value: "qwen/qwen-2.5-72b-instruct:free",
      label: "Qwen 2.5 72B (Free)",
    },
    {
      value: "qwen/qwen3-coder:free",
      label: "Qwen3 Coder 480B (Free)",
    },
    {
      value: "qwen/qwen3-coder",
      label: "Qwen3 Coder 480B (Paid)",
    },
  ],
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
    lower.includes("flash-lite") || // Some lite models are thinking-ready
    lower.includes("trinity") // User specifically added trinity for agentic workflows
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
  // Provider/model-specific context windows
  "anthropic/claude-3-opus-latest": 200000,
  "anthropic/claude-3-5-sonnet-latest": 200000,
  "claude-3-opus-latest": 200000,
  "claude-3-5-sonnet-latest": 200000,
  "opus": 200000,
  "sonnet": 200000,
  "haiku": 200000,
  "gemini-3": 2000000,
  "gemini-2": 1000000,
  "gemini-1.5": 1000000,
  "deepseek-v3": 128000,
  "deepseek-chat": 128000,
  "deepseek-reasoner": 128000,
  "qwen3": 262144,
  "moonshot": 128000,
  "openrouter": 128000,
  // Specific OpenRouter model context windows
  "anthropic/claude-3.5-sonnet": 200000,
  "deepseek/deepseek-r1": 128000,
  "deepseek/deepseek-chat": 128000,
  "qwen/qwen3-coder": 262144,
  "qwen/qwen3-coder:free": 262144,
  "stepfun/step-3.5-flash:free": 128000,
  "meta-llama/llama-3.3-70b-instruct:free": 128000,
  "nousresearch/hermes-3-llama-3.1-405b:free": 128000,
  "arcee-ai/trinity-mini:free": 131072,
  "qwen/qwen3-next-80b-a3b-instruct:free": 262144,
  "openai/gpt-oss-120b:free": 131072,
  "z-ai/glm-4.5-air:free": 131072,
  "xiaomi/mimo-v2-flash": 128000,
  "google/gemini-2.0-flash-001": 1000000,
};

// Helper to find the best matching context window for a model
export function getContextLimit(model: string | null): number {
  if (!model) return 200000;
  
  const lower = model.toLowerCase();
  
  // First, try exact match for the full model string
  if (MODEL_CONTEXT_LIMITS[lower]) {
    return MODEL_CONTEXT_LIMITS[lower];
  }
  
  // Try exact match with the model as-is (case-sensitive)
  if (MODEL_CONTEXT_LIMITS[model]) {
    return MODEL_CONTEXT_LIMITS[model];
  }
  
  // Try partial matches from most specific to least specific
  // This handles cases like "anthropic/claude-3.5-sonnet" matching "sonnet"
  const partialMatches = [
    "anthropic/claude-3.5-sonnet",
    "deepseek/deepseek-r1",
    "deepseek/deepseek-chat",
    "qwen/qwen3-coder",
    "qwen/qwen3-next",
    "arcee-ai/trinity-mini",
    "openai/gpt-oss-120b",
    "z-ai/glm-4.5-air",
    "stepfun/step-3.5-flash",
    "meta-llama/llama-3.3",
    "nousresearch/hermes-3",
    "xiaomi/mimo-v2",
    "google/gemini-2.0",
    "gemini-3",
    "gemini-1.5",
    "opus",
    "sonnet",
    "haiku",
    "deepseek",
    "qwen3",
    "moonshot",
    "openrouter",
  ];
  
  for (const pattern of partialMatches) {
    if (lower.includes(pattern)) {
      const result = MODEL_CONTEXT_LIMITS[pattern];
      if (result !== undefined) return result;
    }
  }
  
  // Fallback: check for provider-level defaults
  if (lower.includes("openrouter")) return MODEL_CONTEXT_LIMITS["openrouter"] ?? 200000;
  if (lower.includes("anthropic")) return MODEL_CONTEXT_LIMITS["sonnet"] ?? 200000; // Default to sonnet
  if (lower.includes("gemini")) return MODEL_CONTEXT_LIMITS["gemini-1.5"] ?? 200000; // Default to 1.5
  if (lower.includes("deepseek")) return MODEL_CONTEXT_LIMITS["deepseek-chat"] ?? 200000;
  
  return 200000; // Final fallback
}

/**
 * Get context window limit for a specific provider and model combination.
 * This is useful for UI display and model selection.
 */
export function getContextWindowForModel(provider: string, model: string): number {
  // Build the full model identifier that might be used in getContextLimit
  const fullModelId = `${provider}/${model}`;
  
  // Try the full model ID first
  const fullResult = getContextLimit(fullModelId);
  if (fullResult !== 200000) { // If we got a specific result
    return fullResult;
  }
  
  // Try just the model name
  return getContextLimit(model);
}
