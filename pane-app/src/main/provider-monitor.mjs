/**
 * Provider Monitor — Usage & quota tracking for all providers.
 *
 * TWO MODELS OF QUOTA:
 *
 * 1. Claude (Anthropic): The API returns `anthropic-ratelimit-*` headers on
 *    EVERY response (not just errors). We parse them after each response and
 *    emit a rate_limit event with the remaining/reset data. No tracking needed
 *    on our side — the server tells us directly.
 *
 * 2. Z.ai (GLM Coding Plan): No quota-check API exists. But the docs give us:
 *    - The credit formula: (input×multiplier + cached×multiplier + output×multiplier) / 10,000
 *    - The multipliers per model (GLM-5.2: 6.9/1.7/24, etc.)
 *    - The plan limits (Lite: 2k/10k, Pro: 12k/60k, Max: 28k/140k — 5h/weekly)
 *    - The reset rules: 5h credits reset 5 hours after consumption (rolling),
 *      weekly credits reset every 7 days.
 *    We track usage ourselves via rolling windows and emit rate_limit events.
 *
 * ERROR CODES (Z.ai):
 *   Terminal (don't retry — quota is gone until reset):
 *     1113: Insufficient balance / no resource package
 *     1308: Usage limit reached for {unit}. Resets at {next_flush_time}
 *     1309: Coding Plan package expired
 *     1310: Weekly/Monthly limit exhausted. Resets at {next_flush_time}
 *     1316-1321: Various 5h/7d limit + spend cap combos
 *   Transient (retry makes sense):
 *     1302: Rate limit reached for requests
 *     1305: Service temporarily overloaded
 *   Terminal (account/config):
 *     1311: Plan doesn't include this model
 *     1313: Fair Usage Policy violation
 *     1314-1315: Enterprise package issues
 *
 * Off-peak: 50% credit rate during off-peak hours.
 *   Peak: Mon-Fri 14:00-18:00 Singapore Time (UTC+8).
 *   We conservatively charge peak rates always — the real consumption is often
 *   lower, which is the safe direction for a usage indicator.
 */

// ── Z.ai Credit Multipliers (per model) ──────────────────────────────────────

const ZAI_MULTIPLIERS = {
  "glm-5.2": { input: 6.9, cached: 1.7, output: 24 },
  "glm-5-turbo": { input: 5.7, cached: 1.5, output: 21 },
  "glm-4.7": { input: 4.6, cached: 1.2, output: 16 },
  // Default fallback — closest to GLM-4.7 (conservative)
  _default: { input: 4.6, cached: 1.2, output: 16 },
};

/**
 * Get multipliers for a model ID. Matches case-insensitively on the model name,
 * so "GLM-5.2" and "glm-5.2" both work.
 * @param {string} modelId
 * @returns {{ input: number, cached: number, output: number }}
 */
export function getZaiMultipliers(modelId) {
  if (!modelId) return ZAI_MULTIPLIERS._default;
  const lower = modelId.toLowerCase();
  for (const [key, val] of Object.entries(ZAI_MULTIPLIERS)) {
    if (key === "_default") continue;
    if (lower.includes(key)) return val;
  }
  return ZAI_MULTIPLIERS._default;
}

// ── Z.ai Plan Limits ─────────────────────────────────────────────────────────

export const ZAI_PLAN_LIMITS = {
  lite: { fiveHour: 2000, weekly: 10000 },
  pro: { fiveHour: 12000, weekly: 60000 },
  max: { fiveHour: 28000, weekly: 140000 },
};

/**
 * Get plan limits for a tier.
 * @param {"lite" | "pro" | "max" | string} tier
 * @returns {{ fiveHour: number, weekly: number } | null}
 */
export function getZaiPlanLimits(tier) {
  if (!tier) return null;
  return ZAI_PLAN_LIMITS[tier.toLowerCase()] || null;
}

// ── Credit Calculation ───────────────────────────────────────────────────────

/**
 * Calculate Z.ai credits consumed for a single request.
 *
 * Formula from docs:
 *   credits = (input_tokens × input_multiplier
 *             + cached_tokens × cached_multiplier
 *             + output_tokens × output_multiplier) / 10,000
 *
 * Note: `input_tokens` from Z.ai's usage response already includes cached
 * tokens in prompt_tokens. We subtract cached to avoid double counting.
 *
 * @param {object} usage — { input_tokens, output_tokens, cache_read_input_tokens, ... }
 * @param {string} modelId
 * @returns {number} credits consumed (always ≥ 0)
 */
export function calculateZaiCredits(usage, modelId) {
  if (!usage) return 0;
  const mult = getZaiMultipliers(modelId);

  const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const cachedTokens =
    usage.cache_read_input_tokens ||
    usage.prompt_cache_hit_tokens ||
    usage.cached_tokens ||
    0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;

  // Z.ai's prompt_tokens includes cached tokens. Subtract them so the
  // input multiplier applies only to uncached input.
  const uncachedInput = Math.max(0, promptTokens - cachedTokens);

  const credits =
    (uncachedInput * mult.input +
      cachedTokens * mult.cached +
      outputTokens * mult.output) /
    10000;

  return Math.max(0, credits);
}

// ── Rolling Window Tracker ───────────────────────────────────────────────────

/**
 * In-memory rolling window for Z.ai credit tracking.
 * Stores { timestamp, credits } entries and prunes entries older than the window.
 *
 * Two windows:
 *   - 5-hour (5 * 60 * 60 * 1000 ms)
 *   - 7-day  (7 * 24 * 60 * 60 * 1000 ms)
 *
 * We keep a single log and compute both windows from it — the 5h window is a
 * strict subset of the 7d window, so there's no need for separate logs.
 *
 * Capped at 500 entries (trim oldest) to prevent unbounded growth. At ~1 entry
 * per API call, 500 entries covers a full week of heavy usage.
 */
const MAX_ENTRIES = 500;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {Array<{ ts: number, credits: number }>} */
let _zaiUsageLog = [];

/**
 * Add credits consumed and return updated usage summary.
 * @param {number} credits
 * @returns {{ fiveHourUsed: number, weeklyUsed: number }}
 */
export function recordZaiUsage(credits) {
  if (credits <= 0) return getZaiUsageSummary();
  const now = Date.now();
  _zaiUsageLog.push({ ts: now, credits });

  // Trim by entry count
  if (_zaiUsageLog.length > MAX_ENTRIES) {
    _zaiUsageLog = _zaiUsageLog.slice(-MAX_ENTRIES);
  }

  return getZaiUsageSummary();
}

/**
 * Get current usage in both windows.
 * @returns {{ fiveHourUsed: number, weeklyUsed: number }}
 */
export function getZaiUsageSummary() {
  const now = Date.now();
  const fiveHourCutoff = now - FIVE_HOURS_MS;
  const weeklyCutoff = now - SEVEN_DAYS_MS;

  let fiveHourUsed = 0;
  let weeklyUsed = 0;

  // Prune entries older than 7 days while iterating
  const pruned = [];
  for (const entry of _zaiUsageLog) {
    if (entry.ts < weeklyCutoff) continue; // drop
    pruned.push(entry);
    weeklyUsed += entry.credits;
    if (entry.ts >= fiveHourCutoff) {
      fiveHourUsed += entry.credits;
    }
  }
  _zaiUsageLog = pruned;

  return {
    fiveHourUsed: Math.round(fiveHourUsed),
    weeklyUsed: Math.round(weeklyUsed),
  };
}

/**
 * Reset the Z.ai usage log entirely (e.g., on provider switch).
 */
export function resetZaiUsage() {
  _zaiUsageLog = [];
}

// ── Claude Header Parsing ────────────────────────────────────────────────────

/**
 * Parse Anthropic rate limit headers from a successful API response.
 *
 * Headers appear on ALL responses (200 and 429), not just errors:
 *   anthropic-ratelimit-requests-remaining: 87
 *   anthropic-ratelimit-tokens-remaining: 45000
 *   anthropic-ratelimit-tokens-reset: 2024-01-15T14:30:00Z
 *   retry-after: 12  (only on 429)
 *
 * @param {Headers} headers — fetch Response.headers
 * @returns {object|null} — normalized rate limit data, or null if no headers present
 */
export function parseClaudeRateLimitHeaders(headers) {
  if (!headers) return null;

  const tokensRemaining = headers.get("anthropic-ratelimit-tokens-remaining");
  const tokensLimit = headers.get("anthropic-ratelimit-tokens-limit");
  const tokensReset = headers.get("anthropic-ratelimit-tokens-reset");
  const requestsRemaining = headers.get("anthropic-ratelimit-requests-remaining");
  const requestsLimit = headers.get("anthropic-ratelimit-requests-limit");
  const retryAfter = headers.get("retry-after");

  // If none of the rate limit headers are present, this isn't an Anthropic response
  if (!tokensRemaining && !requestsRemaining && !retryAfter) {
    return null;
  }

  // Parse reset timestamp to epoch seconds
  let resetsAtSec = null;
  if (tokensReset) {
    const ms = Date.parse(tokensReset);
    if (!isNaN(ms)) resetsAtSec = Math.floor(ms / 1000);
  }

  // Compute utilization from token limits
  let utilization = null;
  if (tokensLimit && tokensRemaining) {
    const limit = parseInt(tokensLimit, 10);
    const remaining = parseInt(tokensRemaining, 10);
    if (limit > 0) {
      utilization = Math.max(0, Math.min(1, 1 - remaining / limit));
    }
  }

  // retry-after gives us the wait time in seconds — convert to reset epoch
  let retryAfterSec = null;
  if (retryAfter) {
    retryAfterSec = parseInt(retryAfter, 10);
    if (!isNaN(retryAfterSec) && retryAfterSec > 0 && !resetsAtSec) {
      resetsAtSec = Math.floor(Date.now() / 1000) + retryAfterSec;
    }
  }

  return {
    utilization,
    resetsAt: resetsAtSec,
    tokensLimit: tokensLimit ? parseInt(tokensLimit, 10) : null,
    tokensRemaining: tokensRemaining ? parseInt(tokensRemaining, 10) : null,
    requestsLimit: requestsLimit ? parseInt(requestsLimit, 10) : null,
    requestsRemaining: requestsRemaining ? parseInt(requestsRemaining, 10) : null,
    retryAfter: retryAfterSec,
  };
}

// ── Z.ai Error Classification ────────────────────────────────────────────────

/**
 * Z.ai error codes that are TERMINAL — the quota is exhausted or the account
 * has a config issue. Retrying is pure waste; the condition won't resolve
 * until the reset window or user action.
 */
const ZAI_TERMINAL_ERROR_CODES = new Set([
  "1113", // Insufficient balance / no resource package
  "1308", // Usage limit reached for {unit}
  "1309", // Coding Plan package expired
  "1310", // Weekly/Monthly limit exhausted
  "1311", // Plan doesn't include this model
  "1313", // Fair Usage Policy violation
  "1314", // Enterprise package expired
  "1315", // Enterprise API key mismatch
  "1316", // 5h limit, insufficient balance for extra
  "1317", // 7d limit, insufficient balance for extra
  "1318", // 5h limit, monthly spend limit reached
  "1319", // 7d limit, monthly spend limit reached
  "1320", // 5h limit, monthly spend limit (variant)
  "1321", // 7d limit, monthly spend limit (variant)
]);

/**
 * Parse a Z.ai error response body and classify it.
 *
 * Z.ai error shape: { "error": { "code": "1316", "message": "Usage limit..." } }
 *
 * @param {string} bodyText — raw response body text
 * @returns {{ isTerminal: boolean, errorCode: string|null, resetTime: number|null, message: string|null } | null}
 *   resetTime is epoch ms, or null if not present.
 *   Returns null if the body isn't a recognizable Z.ai error.
 */
export function classifyZaiError(bodyText) {
  if (!bodyText) return null;

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }

  const errorCode = parsed?.error?.code;
  const errorMessage = parsed?.error?.message;
  if (!errorCode && !errorMessage) return null;

  const isTerminal = ZAI_TERMINAL_ERROR_CODES.has(String(errorCode));

  // Extract reset time from the message text: "Resets at 2025-01-15T14:30:00+08:00"
  // Z.ai uses {next_flush_time} which is typically an ISO 8601 timestamp.
  let resetTime = null;
  if (errorMessage) {
    const resetMatch = errorMessage.match(
      /(?:resets?|reset)\s+at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[:\d]*[+-]\d{2}:?\d{2}|[A-Za-z]+,?\s+\d{4})/i,
    );
    if (resetMatch) {
      const ms = Date.parse(resetMatch[1]);
      if (!isNaN(ms)) resetTime = ms;
    }

    // Also try a bare ISO timestamp without "resets at" prefix
    if (!resetTime) {
      const isoMatch = errorMessage.match(
        /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/,
      );
      if (isoMatch) {
        const ms = Date.parse(isoMatch[1]);
        if (!isNaN(ms)) resetTime = ms;
      }
    }
  }

  if (!isTerminal && !errorCode) return null;

  return {
    isTerminal,
    errorCode: errorCode ? String(errorCode) : null,
    resetTime,
    message: errorMessage || null,
  };
}

/**
 * Build a human-readable error message for a terminal Z.ai error.
 * @param {{ errorCode: string, resetTime: number|null, message: string|null }} classified
 * @returns {string}
 */
export function formatZaiQuotaError(classified) {
  const { errorCode, resetTime, message } = classified;
  const resetStr = resetTime
    ? ` · resets at ${new Date(resetTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";

  switch (errorCode) {
    case "1113":
      return `Z.ai quota exhausted — recharge at z.ai${resetStr}`;
    case "1309":
      return `Z.ai Coding Plan expired — renew at z.ai/subscribe${resetStr}`;
    case "1310":
      return `Z.ai weekly limit reached${resetStr}`;
    case "1311":
      return `Z.ai plan doesn't include this model`;
    case "1313":
      return `Z.ai Fair Usage Policy limit active`;
    case "1314":
    case "1315":
      return `Z.ai enterprise package issue`;
    default:
      // 1308, 1316-1321 — usage limit variants
      return `Z.ai quota exhausted${resetStr}`;
  }
}
