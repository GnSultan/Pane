import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { getTokenAnalytics, getTokenTimeSeries, getModelRates, type TokenAnalyticsRow, type TokenTimeSeriesRow } from "../../lib/tauri-commands";

type TimeRange = "today" | "week" | "month" | "all";

const RANGES: Record<TimeRange, number> = {
  today: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: 0,
};

const PROVIDER_LINKS: Record<string, { label: string; url: string }> = {
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/activity" },
  deepseek: { label: "DeepSeek", url: "https://platform.deepseek.com/usage" },
  anthropic: { label: "Anthropic", url: "https://console.anthropic.com/settings/billing" },
  gemini: { label: "Google AI", url: "https://aistudio.google.com/" },
  kimi: { label: "Kimi", url: "https://platform.moonshot.cn/" },
  xiaomi: { label: "Xiaomi", url: "https://platform.xiaomimimo.com/" },
};

function formatCost(val: number) {
  if (val === 0) return "$0.00";
  // Show actual cents — don't hide real spend behind "< $0.01"
  if (val < 0.01) return `$${val.toFixed(4)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(val);
}

function formatExact(val: number) {
  return val.toLocaleString("en-US");
}

function formatTokens(val: number) {
  if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "B";
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1) + "k";
  return val.toString();
}

function formatModelName(name: string) {
  return name
    .split("/")
    .pop()!
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function DailyTokensChart({ data }: { data: TokenTimeSeriesRow[] }) {
  if (data.length === 0) return null;
  // Cap to last 30 entries — enough to see trends, not a wall
  const capped = data.slice(-30);
  const maxTokens = Math.max(...capped.map(d => d.daily_input + d.daily_output), 0.001);
  const [hovered, setHovered] = useState<TokenTimeSeriesRow | null>(null);
  const height = 96;
  const barWidth = Math.max(4, Math.min(12, 280 / capped.length));
  const gap = 2;
  const width = capped.length * (barWidth + gap);

  return (
    <div>
      <div className="relative">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          onMouseLeave={() => setHovered(null)}
        >
          {capped.map((d, i) => {
            const tokens = d.daily_input + d.daily_output;
            const barHeight = Math.max(1, (tokens / maxTokens) * (height - 2));
            const isHovered = hovered === d;
            return (
              <rect
                key={d.day}
                x={i * (barWidth + gap)}
                y={height - barHeight}
                width={barWidth}
                height={barHeight}
                rx={1}
                fill="currentColor"
                className={isHovered ? "text-pane-text" : "text-pane-text-secondary/30"}
                style={{ transition: "fill 0.1s" }}
                onMouseEnter={() => setHovered(d)}
              />
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-3 mt-1">
        <span className="font-mono text-pane-text tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
          {(hovered || capped[capped.length - 1])?.day}
        </span>
        <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
          {formatTokens(((hovered || capped[capped.length - 1])?.daily_input ?? 0) + ((hovered || capped[capped.length - 1])?.daily_output ?? 0))} tokens
          {" · "}{(hovered || capped[capped.length - 1])?.daily_calls ?? 0} calls
          {" · "}{formatCost((hovered || capped[capped.length - 1])?.daily_cost ?? 0)}
        </span>
      </div>
    </div>
  );
}

export function TokenAnalytics({ projectId, isExpanded }: { projectId: string | null; isExpanded: boolean }) {
  const [data, setData] = useState<TokenAnalyticsRow[]>([]);
  const [timeSeries, setTimeSeries] = useState<TokenTimeSeriesRow[]>([]);
  const [rates, setRates] = useState<Record<string, { input: number; output: number; cache_read?: number } | null>>({});
  const [range, setRange] = useState<TimeRange>("month");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const sinceMs = RANGES[range] === 0 ? 0 : Date.now() - RANGES[range];
      const [rows, series] = await Promise.all([
        getTokenAnalytics(projectId, sinceMs),
        getTokenTimeSeries(projectId, sinceMs),
      ]);
      setData(rows);
      setTimeSeries(series);
      setLastFetchedAt(Date.now());
      // Fetch list prices for all models in the results
      const models = [...new Set(rows.map(r => r.model))];
      if (models.length > 0) {
        getModelRates(models).then(r => { console.log("[analytics] rates:", r); setRates(r); }).catch(err => console.warn("[analytics] rates fetch failed:", err));
      }
    } catch (err) {
      console.error("[analytics] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId, range]);

  // Fetch on mount and when range changes
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Visibility-gated polling — only fetch/refresh when the accordion is expanded.
  // When opened: fetch immediately, then poll every 30s.
  // When closed: stop polling. This replaces the old push-based lastTokenUsageAt
  // subscription that caused re-renders on every single token_usage event.
  useEffect(() => {
    if (isExpanded) {
      // If there's stale data (never fetched or last fetch > 30s ago), refresh now.
      // Otherwise the mount-+range-driven fetch above already has fresh data.
      const isStale = lastFetchedAt === 0 || Date.now() - lastFetchedAt > 30_000;
      if (isStale) {
        fetchAll();
      }
      pollRef.current = setInterval(fetchAll, 30_000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isExpanded, fetchAll, lastFetchedAt]);

  const totals = useMemo(() => {
    return data.reduce(
      (acc, row) => ({
        cost: acc.cost + row.total_cost_usd,
        input: acc.input + row.total_input_tokens,
        output: acc.output + row.total_output_tokens,
        cached: acc.cached + row.total_cache_read,
        cacheCreation: acc.cacheCreation + row.total_cache_creation,
        calls: acc.calls + row.call_count,
      }),
      { cost: 0, input: 0, output: 0, cached: 0, cacheCreation: 0, calls: 0 }
    );
  }, [data]);

  // Resolve the effective rate for a row: prefer the snapshot of what was actually
  // used at estimation time, fall back to today's live list price.
  function effectiveRate(row: TokenAnalyticsRow): { input: number; output: number; cache_read?: number } | null {
    if (row.latest_rate_snapshot) {
      try { return JSON.parse(row.latest_rate_snapshot); } catch {
        // Malformed snapshot — fall through to live rates below
      }
    }
    return rates[row.model] ?? null;
  }

  // Cache rate from cache-capable models only — old models that predate caching
  // architecture dilute the rate. A model supports caching if its pricing has a
  // cache_read field, or if it has any cache activity in its own data.
  const cacheModelsTotals = useMemo(() => {
    return data.reduce(
      (acc, row) => {
        const modelRate = rates[row.model];
        const supportsCaching = modelRate
          ? typeof modelRate.cache_read === "number"
          : row.total_cache_read > 0 || row.total_cache_creation > 0;
        if (supportsCaching) {
          acc.input += row.total_input_tokens;
          acc.cached += row.total_cache_read;
        }
        return acc;
      },
      { input: 0, cached: 0 }
    );
  }, [data, rates]);

  // Estimate cache savings per-model using actual per-model cache_read rate.
  // Savings = cached_tokens * (full_input_price - cache_read_price).
  // When cache_read is unknown (not in OpenRouter data), savings = 0 (safe fallback).
  const cacheSavings = useMemo(() => {
    let savings = 0;
    for (const row of data) {
      const rate = effectiveRate(row);
      if (!rate || row.total_cache_read === 0) continue;
      const inputPricePerToken = rate.input / 1_000_000;
      const cacheReadPrice = typeof rate.cache_read === "number" ? rate.cache_read / 1_000_000 : inputPricePerToken;
      savings += row.total_cache_read * (inputPricePerToken - cacheReadPrice);
    }
    return savings;
  }, [data, rates]);

  // Group rows by provider, sort providers by total cost (desc), models by cost (desc)
  const groupedData = useMemo(() => {
    const groups: Record<string, TokenAnalyticsRow[]> = {};
    for (const row of data) {
      let group = groups[row.provider];
      if (!group) {
        group = [];
        groups[row.provider] = group;
      }
      group.push(row);
    }

    // Sort models within each provider by total cost descending
    for (const provider of Object.keys(groups)) {
      const rows = groups[provider]!;
      rows.sort((a, b) => b.total_cost_usd - a.total_cost_usd);
    }

    // Sort providers by total cost descending
    return Object.entries(groups)
      .map(([provider, rows]) => ({
        provider,
        rows,
        total: rows.reduce(
          (acc, r) => ({
            cost: acc.cost + r.total_cost_usd,
            input: acc.input + r.total_input_tokens,
            output: acc.output + r.total_output_tokens,
            cached: acc.cached + r.total_cache_read,
            cacheCreation: acc.cacheCreation + r.total_cache_creation,
            calls: acc.calls + r.call_count,
            modelCount: acc.modelCount + 1,
          }),
          { cost: 0, input: 0, output: 0, cached: 0, cacheCreation: 0, calls: 0, modelCount: 0 }
        ),
      }))
      .sort((a, b) => (b.total.input + b.total.output) - (a.total.input + a.total.output));
  }, [data]);

  return (
    <div className="flex flex-col gap-8">
      {/* Range selector */}
      <div className="flex items-center gap-1">
        {(["today", "week", "month", "all"] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-2 py-1 rounded-lg font-mono transition-all ${
              range === r
                ? "bg-pane-text/[0.08] text-pane-text"
                : "text-pane-text-secondary hover:text-pane-text-secondary"
            }`}
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {r.charAt(0).toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="p-5 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-2">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">spend</span>
          <span className="text-2xl font-mono text-pane-text font-semibold tabular-nums">{formatCost(totals.cost)}</span>
          <span className="text-sm font-mono text-pane-text-secondary">{totals.calls} calls</span>
        </div>
        <div className="p-5 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-2">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">tokens</span>
          <span className="text-2xl font-mono text-pane-text font-semibold tabular-nums">{formatTokens(totals.input + totals.output)}</span>
          <span className="text-sm font-mono text-pane-text-secondary">
            {totals.cached > 0
              ? `${formatTokens(totals.input - totals.cached)} non-cached · ${formatTokens(totals.cached)} cached · ${formatTokens(totals.output)} out`
              : `${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`}
          </span>
        </div>
        <div className="p-5 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-2">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">cache savings</span>
          <span className="text-2xl font-mono text-pane-status-added font-semibold tabular-nums">
            {cacheSavings > 0 ? formatCost(cacheSavings) : "—"}
          </span>
          <span className="text-sm font-mono text-pane-text-secondary">
            {cacheModelsTotals.cached > 0 && cacheModelsTotals.input > 0
              ? `${Math.round((cacheModelsTotals.cached / cacheModelsTotals.input) * 100)}% hit rate`
              : totals.cached > 0
                ? `${Math.round((totals.cached / totals.input) * 100)}% overall`
                : "no cache data"}
          </span>
        </div>
      </div>

      {/* Daily sparkline — tokens, not cost */}
      {timeSeries.length > 1 && (
        <DailyTokensChart data={timeSeries} />
      )}

      {/* Model breakdown — grouped by provider */}
      <div className="flex flex-col gap-1">
        {loading ? (
          <div className="py-8 flex justify-center">
            <div className="w-4 h-4 rounded-full border-2 border-pane-text/10 border-t-pane-text/40 animate-spin" />
          </div>
        ) : data.length === 0 ? (
          <div className="py-8 text-center">
            <span className="text-pane-text-secondary font-mono text-xs">no usage data for this period</span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groupedData.map(({ provider, rows, total }) => {
              const link = PROVIDER_LINKS[provider];
              const providerLabel = link?.label ?? provider.charAt(0).toUpperCase() + provider.slice(1);
              const totalTokens = total.input + total.output;
              const totalAllTokens = totals.input + totals.output;
              const providerPct = totalAllTokens > 0 ? Math.round((totalTokens / totalAllTokens) * 100) : 0;
              const isExpanded = expandedProvider === provider;

              return (
                <div key={provider} className="rounded-lg overflow-hidden ring-1 ring-pane-border/30 transition-colors">
                  {/* Header — click to toggle */}
                  <button
                    onClick={() => setExpandedProvider(isExpanded ? null : provider)}
                    className="flex items-center gap-3 w-full group py-2 px-4 bg-pane-bg hover:bg-pane-bg/80 active:bg-pane-bg/60 transition-all"
                  >
                    <span className="font-mono text-pane-text text-sm w-[110px] shrink-0 text-left">{providerLabel}</span>

                    {groupedData.length > 1 ? (
                      <div className="flex-1 h-6 bg-pane-text/[0.03] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-pane-text/10 rounded-full transition-all duration-200"
                          style={{ width: `${providerPct}%` }}
                        />
                      </div>
                    ) : (
                      <div className="flex-1" />
                    )}

                    <span className="font-mono text-pane-text-secondary/60 tabular-nums w-10 text-right shrink-0" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      {providerPct}%
                    </span>

                    <motion.svg
                      animate={{ rotate: isExpanded ? 180 : 0 }}
                      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                      width="12" height="12" viewBox="0 0 12 12" fill="none"
                      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                      className="text-pane-text-secondary/40 group-hover:text-pane-text-secondary"
                    >
                      <path d="M3 4.5L6 7.5L9 4.5" />
                    </motion.svg>
                  </button>

                  {/* Expanded content */}
                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="p-4 bg-pane-bg/30 border-t border-pane-border/30 flex flex-col gap-3">
                          {/* Stats strip — exact total tokens + cost pushed right */}
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-pane-text-secondary" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                              {formatExact(totalTokens)} total tokens · {total.calls.toLocaleString("en-US")} calls
                            </span>
                            <span className="font-mono text-pane-text tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                              {formatCost(total.cost)}
                            </span>
                          </div>

                          {/* Model rows */}
                          {rows.map((row) => {
                            const cacheHit = row.total_input_tokens > 0
                              ? Math.round((row.total_cache_read / row.total_input_tokens) * 100)
                              : 0;
                            return (
                              <div key={`${row.model}-${row.provider}-${row.activity_type}`}
                                className="flex flex-col gap-0.5 py-2 px-3 rounded-lg bg-pane-surface/30">
                                <span className="font-mono text-pane-text truncate" style={{ fontSize: "var(--pane-font-size-sm)" }}>
                                  {formatModelName(row.model)}
                                  {row.provider !== provider && (
                                    <span className="text-pane-text-secondary"> · {row.provider}</span>
                                  )}
                                </span>
                                <div className="flex items-center gap-5 w-full">
                                  <span className="font-mono text-pane-text-secondary tabular-nums shrink-0" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {row.call_count} calls
                                  </span>
                                  <span className="font-mono text-pane-text-secondary tabular-nums shrink-0" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatTokens(row.total_input_tokens)} in / {formatTokens(row.total_output_tokens)} out
                                  </span>
                                  <div className="flex-1" />
                                  {cacheHit > 0 && (
                                    <span className="font-mono text-pane-status-added tabular-nums shrink-0" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                      {cacheHit}% cached
                                    </span>
                                  )}
                                  <span className="font-mono text-pane-text tabular-nums shrink-0" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatCost(row.total_cost_usd)}
                                    {row.unknown_cost_count > 0 && (
                                      <span className="text-pane-text-secondary/40 ml-0.5" title={`${row.unknown_cost_count} calls with unknown pricing`}>?</span>
                                    )}
                                  </span>
                                </div>
                              </div>
                            );
                          })}

                          {/* Provider totals row — cache: hit vs miss */}
                          <div className="flex items-center justify-between pt-3 border-t border-pane-border/10">
                            <span className="font-mono text-pane-text-secondary/60" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                              {total.modelCount} {total.modelCount === 1 ? "model" : "models"} · {total.calls.toLocaleString("en-US")} calls
                            </span>
                            <div className="flex items-center gap-5">
                              {total.cached > 0 ? (
                                <>
                                  <span className="font-mono text-pane-status-added tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatTokens(total.cached)} hit
                                  </span>
                                  <span className="font-mono text-pane-text-secondary/60 tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatTokens(total.input - total.cached)} miss
                                  </span>
                                  <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatTokens(total.output)} out
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="font-mono text-pane-text-secondary/60 tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatTokens(total.input)} in
                                  </span>
                                  <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                                    {formatTokens(total.output)} out
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
