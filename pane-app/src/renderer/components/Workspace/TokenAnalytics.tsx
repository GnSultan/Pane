import { useEffect, useState, useMemo, useCallback } from "react";
import { getTokenAnalytics, getTokenTimeSeries, getModelRates, type TokenAnalyticsRow, type TokenTimeSeriesRow } from "../../lib/tauri-commands";
import { useWorkspaceStore } from "../../stores/workspace";

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

function formatTokens(val: number) {
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1) + "k";
  return val.toString();
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

export function TokenAnalytics({ projectId }: { projectId: string | null }) {
  const [data, setData] = useState<TokenAnalyticsRow[]>([]);
  const [timeSeries, setTimeSeries] = useState<TokenTimeSeriesRow[]>([]);
  const [rates, setRates] = useState<Record<string, { input: number; output: number; cache_read?: number } | null>>({});
  const [range, setRange] = useState<TimeRange>("month");
  const [loading, setLoading] = useState(true);
  const lastTokenUsageAt = useWorkspaceStore((s) => s.lastTokenUsageAt);

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

  // Fetch on mount and range change
  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Live updates — refetch 2s after each token_usage event
  useEffect(() => {
    if (!lastTokenUsageAt) return;
    const timer = setTimeout(fetchAll, 2000);
    return () => clearTimeout(timer);
  }, [lastTokenUsageAt, fetchAll]);

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
            calls: acc.calls + r.call_count,
            modelCount: acc.modelCount + 1,
          }),
          { cost: 0, input: 0, output: 0, calls: 0, modelCount: 0 }
        ),
      }))
      .sort((a, b) => b.total.cost - a.total.cost);
  }, [data]);

  const maxCost = Math.max(...data.map(r => r.total_cost_usd), 0.000001);

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
            {r}
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
            {formatTokens(totals.input)} in · {formatTokens(totals.output)} out
          </span>
        </div>
        <div className="p-5 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-2">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">cache savings</span>
          <span className="text-2xl font-mono text-pane-status-added font-semibold tabular-nums">
            {cacheSavings > 0 ? formatCost(cacheSavings) : "—"}
          </span>
          <span className="text-sm font-mono text-pane-text-secondary">
            {totals.cached > 0 && (totals.input + totals.cached) > 0
              ? `${Math.round((totals.cached / (totals.input + totals.cached)) * 100)}% hit rate`
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
          <div className="flex flex-col gap-8">
            {groupedData.map(({ provider, rows, total }) => {
              const link = PROVIDER_LINKS[provider];
              const providerLabel = link?.label ?? provider.charAt(0).toUpperCase() + provider.slice(1);
              const providerPct = totals.cost > 0 ? Math.round((total.cost / totals.cost) * 100) : 0;

              return (
                <div key={provider} className="flex flex-col gap-1.5">
                  {/* Provider header */}
                  <div className="flex items-center justify-between px-0.5">
                    <span className="font-mono text-pane-text text-sm">{providerLabel}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                        {formatTokens(total.input + total.output)} total
                      </span>
                      {link && (
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-pane-text-secondary/30 hover:text-pane-text-secondary transition-colors"
                          style={{ fontSize: "var(--pane-font-size-xs)" }}
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Provider proportion bar */}
                  {groupedData.length > 1 && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 bg-pane-text/[0.04] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-pane-text/15 rounded-full"
                          style={{ width: `${providerPct}%` }}
                        />
                      </div>
                      <span className="font-mono text-pane-text-secondary/50 tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                        {providerPct}%
                      </span>
                    </div>
                  )}

                  {/* Model rows */}
                  {rows.map((row) => {
                    // Cache hit = cached / (cached + non-cached input). They're additive, not overlapping.
                    const totalInput = row.total_input_tokens + row.total_cache_read;
                    const cacheHit = totalInput > 0
                      ? Math.round((row.total_cache_read / totalInput) * 100)
                      : 0;
                    return (
                      <div key={`${row.model}-${row.provider}-${row.activity_type}`}
                        className="p-3 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-pane-text font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                            {row.model.split("/").pop()}
                            {row.provider !== provider && (
                              <span className="text-pane-text-secondary"> · {row.provider}</span>
                            )}
                          </span>
                          <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                            {row.call_count} calls{(() => {
                              const r = effectiveRate(row);
                              if (r) return ` · ${r.input}/${r.output}M`;
                              return "";
                            })()}
                          </span>
                        </div>

                        {/* Cost bar — green segment shows estimated cache savings proportion */}
                        <div className="h-1.5 w-full bg-pane-text/[0.04] rounded-full overflow-hidden flex mb-2">
                          {(() => {
                            const rate = effectiveRate(row);
                            const cacheSavedUsd = rate && row.total_cache_read > 0
                              ? (() => {
                                  const inputPricePerToken = rate.input / 1_000_000;
                                  const cacheReadPrice = typeof rate.cache_read === "number" ? rate.cache_read / 1_000_000 : inputPricePerToken;
                                  return row.total_cache_read * (inputPricePerToken - cacheReadPrice);
                                })()
                              : 0;
                            const costPct = maxCost > 0 ? (row.total_cost_usd / maxCost) * 100 : 0;
                            const cachePct = maxCost > 0 ? Math.min((cacheSavedUsd / maxCost) * 100, costPct) : 0;
                            const normalPct = costPct - cachePct;
                            return (
                              <>
                                {cachePct > 0 && (
                                  <div className="h-full bg-pane-status-added/40 rounded-l-full" style={{ width: `${cachePct}%` }} />
                                )}
                                <div className="h-full bg-pane-text/25" style={{ width: `${normalPct}%` }} />
                              </>
                            );
                          })()}
                        </div>

                        {/* Stats */}
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-pane-text tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                            {formatTokens(row.total_input_tokens)} in / {formatTokens(row.total_output_tokens)} out
                          </span>
                          <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                            {formatCost(row.total_cost_usd)}
                            {row.unknown_cost_count > 0 && (
                              <span className="text-pane-text-secondary/40 ml-0.5" title={`${row.unknown_cost_count} calls with unknown pricing`}>?</span>
                            )}
                          </span>
                          {cacheHit > 0 && (
                            <span className="font-mono text-pane-status-added tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                              {cacheHit}% cached
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Provider totals row */}
                  <div className="flex items-center justify-between px-0.5 pt-1.5 border-t border-pane-border/10">
                    <span className="font-mono text-pane-text-secondary" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      Total · {total.modelCount} {total.modelCount === 1 ? "model" : "models"} · {total.calls} calls
                    </span>
                    <span className="font-mono text-pane-text tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      {formatTokens(total.input)} in / {formatTokens(total.output)} out
                      <span className="text-pane-text-secondary ml-2">{formatCost(total.cost)}</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
