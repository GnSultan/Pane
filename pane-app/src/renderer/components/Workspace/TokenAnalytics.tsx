import { useEffect, useState, useMemo } from "react";
import { getTokenAnalytics, type TokenAnalyticsRow } from "../../lib/tauri-commands";
import { motion } from "framer-motion";

type TimeRange = "today" | "week" | "month" | "all";

export function TokenAnalytics({ projectId }: { projectId: string | null }) {
  const [data, setData] = useState<TokenAnalyticsRow[]>([]);
  const [range, setRange] = useState<TimeRange>("month");
  const [loading, setLoading] = useState(true);

  const ranges: Record<TimeRange, number> = {
    today: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    all: 0,
  };

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      const sinceMs = ranges[range] === 0 ? 0 : Date.now() - ranges[range];
      const rows = await getTokenAnalytics(projectId, sinceMs);
      setData(rows);
    } catch (err) {
      console.error("[analytics] failed to fetch:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [projectId, range]);

  const totals = useMemo(() => {
    return data.reduce(
      (acc, row) => ({
        cost: acc.cost + row.total_cost_usd,
        input: acc.input + row.total_input_tokens,
        output: acc.output + row.total_output_tokens,
        cached: acc.cached + row.total_cache_read,
        calls: acc.calls + row.call_count,
      }),
      { cost: 0, input: 0, output: 0, cached: 0, calls: 0 }
    );
  }, [data]);

  const formatCost = (val: number) => {
    if (val === 0) return "$0.00";
    if (val < 0.01) return `< $0.01`;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(val);
  };

  const formatTokens = (val: number) => {
    if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
    if (val >= 1_000) return (val / 1_000).toFixed(1) + "k";
    return val.toString();
  };

  const maxCost = Math.max(...data.map((r) => r.total_cost_usd), 0.000001);

  return (
    <div className="flex flex-col gap-6">
      {/* Range Selector */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(["today", "week", "month", "all"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-1 rounded-lg font-mono transition-all ${
                range === r
                  ? "bg-pane-text/[0.08] text-pane-text"
                  : "text-pane-text-secondary/40 hover:text-pane-text-secondary"
              }`}
              style={{ fontSize: "10px" }}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          onClick={fetchAnalytics}
          className="text-pane-text-secondary/30 hover:text-pane-text-secondary"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 rounded-xl bg-pane-surface/50 border border-pane-border/20 flex flex-col gap-1">
          <span className="text-pane-text-secondary/40 font-mono text-[10px] uppercase tracking-wider">total spend</span>
          <span className="text-xl font-mono text-pane-text font-medium">{formatCost(totals.cost)}</span>
        </div>
        <div className="p-4 rounded-xl bg-pane-surface/50 border border-pane-border/20 flex flex-col gap-1">
          <span className="text-pane-text-secondary/40 font-mono text-[10px] uppercase tracking-wider">total tokens</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-mono text-pane-text font-medium">{formatTokens(totals.input + totals.output)}</span>
            <span className="text-[10px] font-mono text-pane-text-secondary/50">
              {formatTokens(totals.cached)} cached
            </span>
          </div>
        </div>
      </div>

      {/* Breakdown List */}
      <div className="flex flex-col gap-2">
        <span className="text-pane-text-secondary/30 font-mono text-[10px] uppercase tracking-wider mb-1">breakdown by model</span>
        {loading ? (
          <div className="py-8 flex justify-center">
            <div className="w-4 h-4 rounded-full border-2 border-pane-text/10 border-t-pane-text/40 animate-spin" />
          </div>
        ) : data.length === 0 ? (
          <div className="py-8 text-center">
            <span className="text-pane-text-secondary/40 font-mono text-xs italic">no usage data for this period</span>
          </div>
        ) : (
          <div className="space-y-4">
            {data.map((row) => (
              <div key={`${row.model}-${row.activity_type}`} className="group">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-pane-text font-mono text-xs">
                      {row.model.split('/').pop()}
                    </span>
                    <span className="text-[9px] font-mono text-pane-text-secondary/40 uppercase tracking-tighter">
                      {row.provider} • {row.activity_type}
                    </span>
                  </div>
                  <div className="text-right flex flex-col items-end">
                    <span className="text-pane-text font-mono text-xs">{formatCost(row.total_cost_usd)}</span>
                    <span className="text-[9px] font-mono text-pane-text-secondary/40 uppercase">
                      {row.call_count} calls
                    </span>
                  </div>
                </div>
                {/* Visual Bar */}
                <div className="h-1.5 w-full bg-pane-text/[0.04] rounded-full overflow-hidden relative">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${(row.total_cost_usd / maxCost) * 100}%` }}
                    className="h-full bg-pane-text/30 group-hover:bg-pane-text/50 transition-colors rounded-full"
                  />
                  {/* Token Mix Bar (Subtle overlay for input/output/cache) */}
                  <div className="absolute inset-0 flex">
                     {/* We could add colors here for input/output/cache if desired */}
                  </div>
                </div>
                {/* Secondary Stats (Hidden by default, shown on hover?) */}
                <div className="flex items-center gap-3 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-[9px] font-mono text-pane-text-secondary/50">
                    {formatTokens(row.total_input_tokens)} in / {formatTokens(row.total_output_tokens)} out
                  </span>
                  {row.total_cache_read > 0 && (
                    <span className="text-[9px] font-mono text-pane-status-added/60">
                      {Math.round((row.total_cache_read / row.total_input_tokens) * 100)}% cache hit
                    </span>
                  )}
                  <span className="text-[9px] font-mono text-pane-text-secondary/50 ml-auto">
                    avg {Math.round(row.avg_duration_ms)}ms
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Deep Links */}
      <div className="mt-4 pt-4 border-t border-pane-border/10 flex flex-col gap-3">
        <span className="text-pane-text-secondary/30 font-mono text-[9px] uppercase tracking-wider">provider dashboards</span>
        <div className="flex flex-wrap gap-2">
          <a
            href="https://openrouter.ai/activity"
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 rounded bg-pane-text/[0.04] hover:bg-pane-text/[0.08] text-pane-text-secondary font-mono text-[10px] transition-colors"
          >
            OpenRouter ↗
          </a>
          <a
            href="https://platform.deepseek.com/usage"
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 rounded bg-pane-text/[0.04] hover:bg-pane-text/[0.08] text-pane-text-secondary font-mono text-[10px] transition-colors"
          >
            DeepSeek ↗
          </a>
          <a
            href="https://console.anthropic.com/settings/billing"
            target="_blank"
            rel="noreferrer"
            className="px-2 py-1 rounded bg-pane-text/[0.04] hover:bg-pane-text/[0.08] text-pane-text-secondary font-mono text-[10px] transition-colors"
          >
            Anthropic ↗
          </a>
        </div>
      </div>
    </div>
  );
}
