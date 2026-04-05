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

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function DailyCostChart({ data }: { data: TokenTimeSeriesRow[] }) {
  if (data.length === 0) return null;
  // Cap to last 30 entries — enough to see trends, not a wall
  const capped = data.slice(-30);
  const maxCost = Math.max(...capped.map(d => d.daily_cost), 0.001);
  const [hovered, setHovered] = useState<TokenTimeSeriesRow | null>(null);
  const height = 48;
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
            const barHeight = Math.max(1, (d.daily_cost / maxCost) * (height - 2));
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
          {formatCost((hovered || capped[capped.length - 1])?.daily_cost ?? 0)} · {(hovered || capped[capped.length - 1])?.daily_calls ?? 0} calls · {formatTokens(((hovered || capped[capped.length - 1])?.daily_input ?? 0) + ((hovered || capped[capped.length - 1])?.daily_output ?? 0))} tokens
        </span>
      </div>
    </div>
  );
}

export function TokenAnalytics({ projectId }: { projectId: string | null }) {
  const [data, setData] = useState<TokenAnalyticsRow[]>([]);
  const [timeSeries, setTimeSeries] = useState<TokenTimeSeriesRow[]>([]);
  const [rates, setRates] = useState<Record<string, { input: number; output: number } | null>>({});
  const [range, setRange] = useState<TimeRange>("month");
  const [loading, setLoading] = useState(true);
  const lastTokenUsageAt = useWorkspaceStore((s) => (s as any).lastTokenUsageAt ?? 0);

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

  // Estimate cache savings: (cached_tokens * full_input_rate - cached_tokens * cache_rate)
  // Simplified: cached tokens saved ~90% of their input cost on average
  const cacheSavings = useMemo(() => {
    if (totals.cached === 0 || totals.input === 0) return 0;
    const avgInputCostPerToken = totals.cost > 0 ? totals.cost / (totals.input + totals.output) : 0;
    return totals.cached * avgInputCostPerToken * 0.8; // ~80% average savings across providers
  }, [totals]);

  // Unique providers in the data — for dynamic links
  const activeProviders = useMemo(() => {
    const providers = new Set(data.map(r => r.provider));
    return [...providers].filter(p => PROVIDER_LINKS[p]);
  }, [data]);

  const maxCost = Math.max(...data.map(r => r.total_cost_usd), 0.000001);

  return (
    <div className="flex flex-col gap-6">
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
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-1">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">spend</span>
          <span className="text-lg font-mono text-pane-text font-medium tabular-nums">{formatCost(totals.cost)}</span>
          <span className="text-xs font-mono text-pane-text-secondary">{totals.calls} calls</span>
        </div>
        <div className="p-3 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-1">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">tokens</span>
          <span className="text-lg font-mono text-pane-text font-medium tabular-nums">{formatTokens(totals.input + totals.output)}</span>
          <span className="text-xs font-mono text-pane-text-secondary">
            {formatTokens(totals.input)} in · {formatTokens(totals.output)} out
          </span>
        </div>
        <div className="p-3 rounded-xl bg-pane-surface/50 ring-1 ring-pane-border/20 flex flex-col gap-1">
          <span className="text-pane-text-secondary font-mono text-xs uppercase tracking-wider">cache savings</span>
          <span className="text-lg font-mono text-pane-status-added font-medium tabular-nums">
            {cacheSavings > 0 ? formatCost(cacheSavings) : "—"}
          </span>
          <span className="text-xs font-mono text-pane-text-secondary">
            {totals.cached > 0 && (totals.input + totals.cached) > 0
              ? `${Math.round((totals.cached / (totals.input + totals.cached)) * 100)}% hit rate`
              : "no cache data"}
          </span>
        </div>
      </div>

      {/* Daily sparkline */}
      {timeSeries.length > 1 && (
        <DailyCostChart data={timeSeries} />
      )}

      {/* Model breakdown */}
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
          <div className="space-y-3">
            {data.map((row) => {
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
                      <span className="text-pane-text-secondary"> · {row.provider}</span>
                    </span>
                    <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      {row.call_count} calls{(() => {
                        const r = rates[row.model];
                        if (r && (r.input > 0 || r.output > 0)) return ` · $${r.input}/${r.output}M`;
                        return "";
                      })()}
                    </span>
                  </div>

                  {/* Cost bar */}
                  <div className="h-1.5 w-full bg-pane-text/[0.04] rounded-full overflow-hidden flex mb-2">
                    {row.total_cache_read > 0 && (
                      <div
                        className="h-full bg-pane-status-added/40 rounded-l-full"
                        style={{ width: `${(row.total_cache_read / (row.total_input_tokens + row.total_output_tokens)) * (row.total_cost_usd / maxCost) * 100}%` }}
                      />
                    )}
                    <div
                      className="h-full bg-pane-text/25"
                      style={{ width: `${((row.total_cost_usd / maxCost) * 100) - (row.total_cache_read > 0 ? (row.total_cache_read / (row.total_input_tokens + row.total_output_tokens)) * (row.total_cost_usd / maxCost) * 100 : 0)}%` }}
                    />
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-pane-text tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      {formatTokens(row.total_input_tokens)} in / {formatTokens(row.total_output_tokens)} out
                    </span>
                    <span className="font-mono text-pane-text-secondary tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      {formatCost(row.total_cost_usd)}
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
          </div>
        )}
      </div>

      {/* Provider links — only show providers in the data */}
      {activeProviders.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {activeProviders.map((provider) => {
            const link = PROVIDER_LINKS[provider];
            return (
              <a
                key={provider}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="px-2 py-1 rounded bg-pane-text/[0.04] hover:bg-pane-text/[0.08] text-pane-text-secondary font-mono text-xs transition-colors"
              >
                {link.label} ↗
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
