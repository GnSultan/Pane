export interface EngineOption {
  label: string;
  provider: string;
  model: string;
  thinking: boolean;
  requiresKey: string;
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
  plan: { provider: "deepseek", model: "deepseek-v3.2-speciale", thinking: false },
  execute: { provider: "deepseek", model: "deepseek-v3.2", thinking: false },
  explain: { provider: "deepseek", model: "deepseek-v3.2", thinking: false },
  other: { provider: "deepseek", model: "deepseek-v3.2", thinking: false },
};

export const DEFAULT_CLAUDE_CLI_ROUTING: IntentRouting = {
  plan: { provider: "anthropic", model: "opus", thinking: false },
  execute: { provider: "anthropic", model: "sonnet", thinking: false },
  explain: { provider: "anthropic", model: "sonnet", thinking: false },
  other: { provider: "anthropic", model: "sonnet", thinking: false },
};

export const DEFAULT_BACKEND_ROUTING: BackendRouting = {
  "gemini-cli": DEFAULT_GEMINI_CLI_ROUTING,
  "claude-cli": DEFAULT_CLAUDE_CLI_ROUTING,
  "http": DEFAULT_HTTP_ROUTING,
};

// Deprecated — use DEFAULT_BACKEND_ROUTING instead
export const DEFAULT_ROUTING = DEFAULT_GEMINI_CLI_ROUTING;

export const THINKING_ENGINES: EngineOption[] = [
  {
    label: "DeepSeek V3.2 Speciale",
    provider: "deepseek",
    model: "deepseek-v3.2-speciale",
    thinking: false,
    requiresKey: "deepseek",
  },
  {
    label: "Gemini 3",
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 2.5",
    provider: "gemini",
    model: "auto-gemini-2.5",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    model: "gemini-3.1-pro-preview-customtools",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 2.5 Pro",
    provider: "gemini",
    model: "gemini-2.5-pro",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 1.5 Pro",
    provider: "gemini",
    model: "gemini-1.5-pro-latest",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Kimi K2.5 (Thinking)",
    provider: "kimi",
    model: "moonshot-v1-128k",
    thinking: true,
    requiresKey: "kimi",
  },
  {
    label: "Claude 3.5 Opus",
    provider: "anthropic",
    model: "claude-3-opus-latest",
    thinking: false,
    requiresKey: "anthropic",
  },
  {
    label: "DeepSeek R1",
    provider: "deepseek",
    model: "deepseek-reasoner",
    thinking: false,
    requiresKey: "deepseek",
  },
];

export const BUILDING_ENGINES: EngineOption[] = [
  {
    label: "DeepSeek V3.2",
    provider: "deepseek",
    model: "deepseek-v3.2",
    thinking: false,
    requiresKey: "deepseek",
  },
  {
    label: "Gemini 3",
    provider: "gemini",
    model: "auto-gemini-3",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 2.5",
    provider: "gemini",
    model: "auto-gemini-2.5",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "Gemini 3 Flash",
    provider: "gemini",
    model: "gemini-3-flash-preview",
    thinking: false,
    requiresKey: "gemini",
  },
  {
    label: "DeepSeek V3",
    provider: "deepseek",
    model: "deepseek-chat",
    thinking: false,
    requiresKey: "deepseek",
  },
  {
    label: "Claude 3.5 Sonnet",
    provider: "anthropic",
    model: "claude-3-5-sonnet-latest",
    thinking: false,
    requiresKey: "anthropic",
  },
];

export const PROVIDER_MODELS: Record<
  string,
  Array<{ value: string; label: string }>
> = {
  anthropic: [
    { value: "opus", label: "Claude 3.5 Opus" },
    { value: "sonnet", label: "Claude 3.5 Sonnet" },
    { value: "haiku", label: "Claude 3.5 Haiku" },
  ],
  deepseek: [
    { value: "deepseek-v3.2", label: "DeepSeek V3.2" },
    { value: "deepseek-v3.2-speciale", label: "DeepSeek V3.2 Speciale" },
    { value: "deepseek-chat", label: "DeepSeek V3" },
    { value: "deepseek-reasoner", label: "DeepSeek R1" },
  ],
  kimi: [
    { value: "moonshot-v1-8k", label: "Kimi K2.5 (Fast)" },
    { value: "moonshot-v1-128k", label: "Kimi K2.5 (Thinking)" },
  ],
  gemini: [
    { value: "auto-gemini-3", label: "Gemini 3" },
    { value: "auto-gemini-2.5", label: "Gemini 2.5" },
    { value: "gemini-3.1-pro-preview-customtools", label: "Gemini 3.1 Pro (Tools)" },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
};

export function engineKey(e: EngineOption) {
  return `${e.provider}::${e.model}`;
}

export function keyFromRoute(route: { provider: string; model: string } | undefined | null) {
  if (!route) return "none::none";
  return `${route.provider}::${route.model}`;
}
