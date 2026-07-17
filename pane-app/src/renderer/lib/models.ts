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

// Two-slot power combo: thinking model (plan + verify) + execution model (build)
export interface PowerCombo {
  thinking: { provider: string; model: string; thinking: boolean };
  execution: { provider: string; model: string; thinking: boolean };
}

// Map of backendId -> PowerCombo configuration
export type BackendRouting = Record<string, PowerCombo>;

// Keep IntentRouting as a migration type — read from old settings.json
/** @deprecated Use PowerCombo. Kept only for settings migration. */
export interface IntentRouting {
  plan: { provider: string; model: string; thinking: boolean };
  execute: { provider: string; model: string; thinking: boolean };
  explain: { provider: string; model: string; thinking: boolean };
  other: { provider: string; model: string; thinking: boolean };
}

export const DEFAULT_GEMINI_COMBO: PowerCombo = {
  thinking:  { provider: "gemini", model: "gemini-3-flash-preview", thinking: false },
  execution: { provider: "gemini", model: "gemini-3-flash-preview", thinking: false },
};

export const DEFAULT_HTTP_COMBO: PowerCombo = {
  thinking:  { provider: "deepseek", model: "deepseek-v4-flash", thinking: true },
  execution: { provider: "deepseek", model: "deepseek-v4-flash", thinking: true },
};

export const DEFAULT_CLAUDE_CODE_COMBO: PowerCombo = {
  thinking:  { provider: "anthropic", model: "claude-opus-4-6",   thinking: false },
  execution: { provider: "anthropic", model: "claude-sonnet-4-6", thinking: false },
};

export const DEFAULT_BACKEND_ROUTING: BackendRouting = {
  api:          DEFAULT_HTTP_COMBO,
  "claude-code": DEFAULT_CLAUDE_CODE_COMBO,
  gemini:       DEFAULT_GEMINI_COMBO,
};

// Single global default — provider-agnostic. Opus thinks, Sonnet builds.
// User overrides this in Profile. Any provider can fill either slot.
export const DEFAULT_POWER_COMBO: PowerCombo = DEFAULT_CLAUDE_CODE_COMBO;

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
    lower.includes("trinity") ||
    lower.includes("glm") // GLM-5.x and GLM-4.7+ think by default
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
 * Get context window for a model.
 *
 * Priority:
 *   1. API-reported context_length from live model data (when provided)
 *   2. Static MODEL_CONTEXT_LIMITS map for SDK aliases
 *   3. Provider-based heuristic for unknown models
 *   4. 128k fallback
 *
 * @param model - The model identifier string
 * @param allModels - Optional map of provider → model objects from the
 *                    API. Each model object should have a `context_length`
 *                    field reported by the provider.
 */
export function getContextLimit(
  model: string | null,
  allModels?: Record<string, { context_length?: number; id: string }[]>,
): number {
  if (!model) return 128000;

  // 1. Search live API data for an exact or prefix match.
  //    Models fetched from OpenRouter/DeepSeek/etc. include the provider's
  //    actual context_length — this is the authoritative value.
  if (allModels) {
    const lower = model.toLowerCase();
    for (const models of Object.values(allModels)) {
      for (const m of models) {
        if (!m.context_length) continue;
        const mId = m.id?.toLowerCase();
        if (mId === lower || lower.startsWith(mId) || mId?.startsWith(lower) || lower.includes(mId!)) {
          return m.context_length;
        }
      }
    }
  }

  // 2. Static map — fallback for SDK aliases (opus/sonnet/haiku, etc.)
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];

  const lower = model.toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lower.includes(key)) return limit;
  }

  // 3. Provider-based heuristic
  if (lower.includes("gemini")) return 1000000;
  if (lower.includes("deepseek")) return 1000000; // DeepSeek V4 has 1M context
  if (lower.includes("glm")) return 1000000; // Z.ai GLM has 1M context (5.x, 4.7)

  return 128000;
}

/**
 * Get context window limit for a specific provider and model combination.
 */
export function getContextWindowForModel(
  provider: string,
  model: string,
  allModels?: Record<string, { context_length?: number; id: string }[]>,
): number {
  const fullModelId = `${provider}/${model}`;
  const fullResult = getContextLimit(fullModelId, allModels);
  if (fullResult !== 128000) return fullResult;
  return getContextLimit(model, allModels);
}
