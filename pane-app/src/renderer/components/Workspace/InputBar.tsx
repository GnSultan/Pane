import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { TodoPanel } from "./TodoPanel";
import type { Todo } from "../../lib/punk-types";
import {
  isThinkingModel,
  getContextLimit,
} from "../../lib/models";
import { previewRoute, showFilePicker, brainMindGetAll, type RoutePreview, type MindEntry } from "../../lib/tauri-commands";

const EMPTY_TODOS: Todo[] = [];

// ── Reactive mode indicator ─────────────────────────────────────────────
// Auto-detected from route preview, one-tap override by user.

const MODE_CYCLE = ["plan", "analyze", "execute", "discuss"] as const;

const MODE_CONFIG: Record<string, { directive: string; color: string }> = {
  plan:    { directive: "/analyze ", color: "var(--pane-status-modified)" },
  analyze: { directive: "/analyze ", color: "var(--pane-accent)" },
  execute: { directive: "",          color: "var(--pane-status-added)" },
  discuss: { directive: "/discuss ", color: "var(--pane-terminal)" },
};

interface DetectedMode {
  mode: string;
  directive: string;
  color: string;
}

function mapRouteToMode(preview: RoutePreview): string {
  if (preview.mode === "analyze") return "analyze";
  if (preview.mode === "discuss") return "discuss";
  if (preview.mode === "orchestrate") return "plan";
  if (preview.taskType === "explain" || preview.taskType === "architect") return "plan";
  if (preview.taskType === "conversation" || preview.taskType === "quick-answer") return "discuss";
  return "execute";
}

/**
 * Detect if the message is a strong signal to LEAVE the current mode.
 * Weak references to other modes ("plan it out" inside a discuss session)
 * are NOT transition signals — the user is talking about planning, not
 * requesting a mode switch.
 *
 * Only explicit action phrases break the current flow.
 */
function detectTransition(text: string, currentMode: string): string | null {
  const t = text.trim().toLowerCase();

  // From discuss/plan/analyze → execute: user wants action NOW
  if (currentMode !== "execute") {
    if (/^(do it|go ahead|ship it|let'?s go|build it|execute|make it happen|yes do it|ok do it|start building|let'?s build|implement it|go for it)\s*[.!]?$/i.test(t)) {
      return "execute";
    }
    // Short approvals after the model asked "should I proceed?" — only if very short
    if (t.length < 20 && /^(yes|yep|yup|ok|okay|sure|proceed|approved|lgtm|go)\s*[.!]?$/i.test(t)) {
      return "execute";
    }
  }

  // From execute → discuss: user wants to stop and talk
  if (currentMode === "execute") {
    if (/^(wait|stop|hold on|let'?s (talk|discuss|think)|actually|pause)\b/i.test(t)) {
      return "discuss";
    }
  }

  // No strong signal — stay in current mode
  return null;
}

/** Instant client-side intent guess — no IPC, runs on every keystroke. */
function quickClassify(text: string): string {
  const t = text.trim().toLowerCase();
  if (t.length < 5) return "execute";
  // Discuss: short questions
  if (t.endsWith("?") && t.length < 120) return "discuss";
  // Analyze: investigation keywords
  if (/\b(analyze|audit|investigate|trace|where are we|what's wrong|how does|review the|deep dive|go deep|explain how)\b/i.test(t)) return "analyze";
  // Plan: architecture / long vision
  if (/\b(plan|design|architect|rethink|reimagine|strategy|approach|vision|proposal)\b/i.test(t)) return "plan";
  if (t.split("\n").length >= 6 || t.length > 800) return "plan";
  // Discuss: general questions
  if (/^(what|why|how|when|where|who|which|is|are|can|could|would|should|does|do)\b/i.test(t) && t.endsWith("?")) return "discuss";
  return "execute";
}

function formatRelativeTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function RateLimitIndicator() {
  const info = useWorkspaceStore((s) => s.rateLimitInfo);
  const provider = useWorkspaceStore((s) => s.selectedModelProvider);
  const setRateLimitInfo = useWorkspaceStore((s) => s.setRateLimitInfo);

  // Compute before the conditional return so useEffect is always called unconditionally.
  const resetEpochMs = info?.resetsAt ? info.resetsAt * 1000 : null;

  // Auto-expire: schedule a clear when the reset time passes so the warning
  // disappears on its own without needing another backend event.
  useEffect(() => {
    if (!resetEpochMs) return;
    const delay = resetEpochMs - Date.now();
    if (delay <= 0) {
      setRateLimitInfo(null);
      return;
    }
    const t = setTimeout(() => setRateLimitInfo(null), delay);
    return () => clearTimeout(t);
  }, [resetEpochMs, setRateLimitInfo]);

  // Only show for Claude (anthropic) provider — rate limits are Claude-specific.
  // Keeping the stored value across model switches lets it reappear immediately
  // when switching back to Claude, without waiting for the next backend event.
  if (!info || provider !== "anthropic") return null;

  const isOverage = info.isUsingOverage === true;
  const isWarning = info.status === "allowed_warning";
  const isRejected = info.status === "rejected";
  const overageRejected = info.overageStatus === "rejected";

  // Show overage indicator when using extra usage
  if (isOverage && !overageRejected) {
    const overageResets = info.overageResetsAt
      ? formatRelativeTime(info.overageResetsAt * 1000)
      : null;
    return (
      <span className="font-mono tabular-nums text-[var(--pane-status-modified)]" style={{ fontSize: "var(--pane-font-size-xs)" }}>
        extra usage{overageResets ? ` · resets ${overageResets}` : ""}
      </span>
    );
  }

  if (overageRejected) {
    const reason = info.overageDisabledReason;
    return (
      <span className="font-mono tabular-nums text-pane-error" style={{ fontSize: "var(--pane-font-size-xs)" }}>
        {reason === "out_of_credits" ? "extra usage · out of credits" : "extra usage exhausted"}
      </span>
    );
  }

  if (!isWarning && !isRejected) return null;

  const pct = info.utilization != null ? Math.round(info.utilization * 100) : null;
  const resetTime = resetEpochMs
    ? formatRelativeTime(resetEpochMs)
    : null;

  return (
    <span className={`font-mono tabular-nums ${isRejected ? "text-pane-error" : "text-[var(--pane-status-modified)]"}`} style={{ fontSize: "var(--pane-font-size-xs)" }}>
      {pct != null && <>{pct}% </>}{isRejected ? "limit reached" : "limit"}{resetTime && <> · resets {resetTime}</>}
    </span>
  );
}

function ContextUsageIndicator({ projectId }: { projectId: string }) {
  const contextTokens = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.contextTokens ?? 0,
  );
  const model = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.model ?? null,
  );

  if (!contextTokens || contextTokens === 0) return null;

  const limit = getContextLimit(model);
  const pct = Math.round((contextTokens / limit) * 100);

  // Only show when it carries signal — sub-50% is noise, warnings start at 70%.
  if (pct < 50) return null;

  const color =
    pct >= 85 ? "text-pane-error" :
    pct >= 70 ? "text-pane-status-modified" :
    "text-pane-text-secondary/50";

  return (
    <span
      className={`font-mono tabular-nums ${color}`}
      style={{ fontSize: "var(--pane-font-size-xs)" }}
      title={`${contextTokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`}
    >
      ctx {pct}%
    </span>
  );
}

// ─── Static caret (no-blink) ─────────────────────────────────────────────────
//
// Chrome's caret blink is native — CSS `animation` on `caret-color` only works
// in Firefox. The reliable fix: hide the native caret with `caretColor: transparent`
// and render a static 2px amber div positioned via the mirror-div technique.
//
// The mirror is a hidden div with identical typography/padding to the textarea.
// We insert text up to selectionStart, append a zero-width marker span, then
// read marker.offsetTop/offsetLeft as the caret coordinates.

function measureCaretPos(
  el: HTMLTextAreaElement,
  container: HTMLElement,
): { top: number; left: number; lineHeight: number } | null {
  const sel = el.selectionStart;
  if (sel === null) return null;

  const computed = window.getComputedStyle(el);

  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: el.clientWidth + "px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "break-word",
    padding: computed.padding,
    font: computed.font,
    letterSpacing: computed.letterSpacing,
    lineHeight: computed.lineHeight,
    boxSizing: computed.boxSizing,
  });

  mirror.appendChild(document.createTextNode(el.value.slice(0, sel)));
  const marker = document.createElement("span");
  marker.textContent = "\u200b"; // zero-width space — no visual impact
  mirror.appendChild(marker);

  container.appendChild(mirror);
  const caretH = parseFloat(computed.fontSize) || 15;
  // Use the vertical center of the marker box — unambiguous regardless of
  // whether offsetTop lands at the top or bottom of the line box.
  const markerCenter = marker.offsetTop + marker.offsetHeight / 2;
  const result = {
    top: markerCenter - el.scrollTop - caretH / 2,
    left: marker.offsetLeft,
    lineHeight: caretH,
  };
  container.removeChild(mirror);
  return result;
}

interface InputBarProps {
  projectId: string;
  onSend: (message: string, minds?: Array<{ id: string }>, effectiveMode?: string) => void;
  onAbort: () => void;
  isProcessing: boolean;
}

function isConversationVisible(): boolean {
  const { activeProjectId, projects } = useProjectsStore.getState();
  if (!activeProjectId) return false;
  const project = projects.get(activeProjectId);
  return project?.mode === "conversation";
}

function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  if (!lowerQuery) return 0;
  let score = 0, queryIndex = 0, lastMatchIndex = -1;
  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      if (lastMatchIndex !== -1 && i === lastMatchIndex + 1) score += 5;
      if (i === 0 && queryIndex === 0) score += 10;
      if (lowerText[i - 1] === '-' || lowerText[i - 1] === ' ') score += 8;
      score += 1;
      lastMatchIndex = i;
      queryIndex++;
    }
  }
  if (lowerText === lowerQuery) score += 20;
  return queryIndex === lowerQuery.length ? score : -1;
}

// ─── Model picker — inline carousel ──────────────────────────────────────────
//
// Resting state: compact trigger button showing current model name.
// Expanded state: the entire button bar transforms into a full-width inline
// carousel — no floating surface, no background/passthrough issue.

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  "anthropic-api": "Anthropic API",
  gemini: "Gemini CLI",
  "gemini-api": "Gemini API",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  kimi: "Kimi",
  stepfun: "StepFun",
};
function resolveProviderName(key: string): string {
  return PROVIDER_NAMES[key] ?? key;
}

type ModelItem =
  | { kind: "auto" }
  | {
      kind: "model";
      value: string;
      label: string;
      providerLabel: string;
      providerKey: string;
      thinking?: boolean;
    };


// Collapsed trigger — just the current model name, click to expand
function ModelPickerTrigger({
  value,
  autoRoute,
  routedModel,
  isProcessing,
  onClick,
}: {
  value: string;
  autoRoute: boolean;
  routedModel?: string | null;
  isProcessing?: boolean;
  onClick: () => void;
}) {
  const fetchedModels = useWorkspaceStore((s) => s.allModels);
  const label = useMemo(() => {
    if (autoRoute) {
      if (isProcessing && routedModel) {
        for (const models of Object.values(fetchedModels)) {
          const found = (models as any[])?.find((m: any) => m.id === routedModel);
          if (found) return (found.name || found.id).toLowerCase();
        }
      }
      return "pane auto";
    }
    for (const models of Object.values(fetchedModels)) {
      const found = (models as any[])?.find((m: any) => m.id === value);
      if (found) return (found.name || found.id).toLowerCase();
    }
    return value.toLowerCase() || "model";
  }, [value, autoRoute, routedModel, isProcessing, fetchedModels]);

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
        bg-pane-bg ring-1 ring-pane-border/25
        text-pane-text-secondary btn-press select-none"
      style={{ fontSize: "var(--pane-font-size-xs)" }}
    >
      <div className={`w-1.5 h-1.5 rounded-full transition-colors shrink-0 ${autoRoute ? "bg-pane-status-added" : "bg-pane-text-secondary"}`} />
      <span>{label}</span>
    </button>
  );
}

// ─── Mode picker — inline carousel ───────────────────────────────────────────

function ModePickerExpanded({
  activeMode,
  onSelect,
  onClose,
}: {
  activeMode: string;
  onSelect: (mode: string) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const modes = MODE_CYCLE as unknown as string[];

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    requestAnimationFrame(() => document.addEventListener("mousedown", handler));
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div ref={containerRef} className="flex-1 min-w-0 flex items-center gap-1 pointer-events-auto">
      <div className="flex-1" />
      {modes.map((mode) => {
        const config = MODE_CONFIG[mode];
        const active = mode === activeMode;
        return (
          <button
            key={mode}
            onClick={() => { onSelect(mode); onClose(); }}
            className={`shrink-0 flex items-center px-3 py-0.5 transition-opacity hover:opacity-100 ${active ? "opacity-100" : "opacity-35"}`}
          >
            <span
              className="font-mono whitespace-nowrap"
              style={{
                fontSize: "var(--pane-font-size-xs)",
                color: active ? config?.color : "var(--pane-text)",
                lineHeight: 1.5,
              }}
            >
              {mode}
            </span>
          </button>
        );
      })}
      <button
        onClick={onClose}
        className="shrink-0 text-pane-text-secondary/30 hover:text-pane-text-secondary/60 transition-colors ml-1"
        style={{ fontSize: "14px", lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

// Expanded full-bar picker — carousel + search
function ModelPickerExpanded({
  value,
  autoRoute,
  onChange,
  onToggleAutoRoute,
  onClose,
}: {
  value: string;
  autoRoute: boolean;
  onChange: (v: string, thinking?: boolean, provider?: string) => void;
  onToggleAutoRoute: (v: boolean) => void;
  onClose: () => void;
}) {
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [scrollIndex, setScrollIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const fetchedModels = useWorkspaceStore((s) => s.allModels);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);

  const allItems = useMemo<ModelItem[]>(() => {
    // Group by provider, Claude first, then alphabetical
    const grouped = new Map<string, ModelItem[]>();
    for (const [providerKey, models] of Object.entries(fetchedModels)) {
      if (!models || (models as any[]).length === 0) continue;
      if (disabledProviders.includes(providerKey)) continue;
      const group: ModelItem[] = [];
      for (const m of models as any[]) {
        group.push({
          kind: "model",
          value: m.id,
          label: (m.name || m.id).toLowerCase(),
          providerLabel: resolveProviderName(providerKey),
          providerKey,
          thinking: isThinkingModel(m.id),
        });
      }
      grouped.set(providerKey, group);
    }
    const sortedKeys = Array.from(grouped.keys()).sort((a, b) => {
      if (a === "anthropic") return -1;
      if (b === "anthropic") return 1;
      return resolveProviderName(a).localeCompare(resolveProviderName(b));
    });
    const items: ModelItem[] = [{ kind: "auto" }];
    for (const key of sortedKeys) items.push(...(grouped.get(key) ?? []));
    return items;
  }, [fetchedModels, disabledProviders]);

  const displayItems = useMemo<ModelItem[]>(() => {
    if (!searchQuery.trim()) return allItems;
    return (allItems.filter((i) => i.kind === "model") as Extract<ModelItem, { kind: "model" }>[])
      .map((item) => ({
        item,
        score: Math.max(
          fuzzyScore(item.label, searchQuery),
          fuzzyScore(item.value, searchQuery),
          fuzzyScore(item.providerLabel, searchQuery),
        ),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }, [allItems, searchQuery]);

  // Scroll to current selection on open (instant)
  useLayoutEffect(() => {
    const idx = autoRoute
      ? 0
      : Math.max(0, allItems.findIndex((i) => i.kind === "model" && i.value === value));
    setScrollIndex(idx);
    requestAnimationFrame(() => {
      const child = trackRef.current?.children[idx] as HTMLElement | undefined;
      // offsetLeft is within the track; carousel padding-left shifts viewport by 96px
      // so scrollLeft 0 shows auto, scrollLeft = child.offsetLeft centers that model under pill
      if (carouselRef.current) {
        carouselRef.current.scrollLeft = (child?.offsetLeft ?? 0);
      }
    });
  }, []); 

  // Reset to start when search changes
  useEffect(() => {
    setScrollIndex(0);
    if (carouselRef.current) carouselRef.current.scrollLeft = 0;
  }, [searchQuery]);

  const currentProvider = useMemo(() => {
    const item = displayItems[scrollIndex];
    if (!item) return "";
    return item.kind === "auto" ? "pane" : item.providerLabel;
  }, [displayItems, scrollIndex]);

  // Track active index from scroll position
  const handleScroll = useCallback(() => {
    const el = carouselRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const slots = Array.from(track.children) as HTMLElement[];
    const scrollLeft = el.scrollLeft;
    let closest = 0;
    let minDist = Infinity;
    slots.forEach((slot, i) => {
      const dist = Math.abs(slot.offsetLeft - scrollLeft);
      if (dist < minDist) { minDist = dist; closest = i; }
    });
    setScrollIndex(closest);
  }, []);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    requestAnimationFrame(() => document.addEventListener("mousedown", handler));
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handleSelect = (item: ModelItem) => {
    if (item.kind === "auto") {
      onToggleAutoRoute(true);
    } else {
      if (autoRoute) onToggleAutoRoute(false);
      onChange(item.value, item.thinking, item.providerKey);
    }
    onClose();
  };

  const isActive = (item: ModelItem) =>
    item.kind === "auto" ? autoRoute : !autoRoute && item.value === value;

  return (
    <div ref={containerRef} className="flex items-center gap-2 w-full pointer-events-auto">
      {/* Search zone */}
      <div className="shrink-0 flex items-center">
        {searchMode ? (
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                if (searchQuery) setSearchQuery("");
                else setSearchMode(false);
              }
            }}
            placeholder="search..."
            className="bg-transparent font-mono text-pane-text outline-none
                       placeholder:text-pane-text-secondary/40 w-28"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          />
        ) : (
          <button
            onClick={() => setSearchMode(true)}
            className="flex items-center justify-center p-1.5
                       text-pane-text-secondary/40 hover:text-pane-text-secondary/70 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="10" height="10" rx="2" />
              <path d="M12 12l2.5 2.5" />
            </svg>
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="w-px h-3 bg-pane-border/30 shrink-0" />

      {/* Provider label */}
      <span
        className="shrink-0 font-mono text-pane-text-secondary/40 select-none whitespace-nowrap transition-all duration-200"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        {currentProvider}
      </span>

      {/* Divider */}
      <div className="w-px h-3 bg-pane-border/30 shrink-0" />

      {/* Carousel */}
      <div className="flex-1 min-w-0 relative">
        <div
          ref={carouselRef}
          onScroll={handleScroll}
          className="w-full overflow-x-scroll [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {/* Right fade */}
          <div
            className="absolute right-0 top-0 bottom-0 w-8 pointer-events-none z-10"
            style={{ background: "linear-gradient(to left, var(--pane-bg), transparent)" }}
          />
          <div ref={trackRef} className="flex items-center">
            {displayItems.map((item) => {
            const active = isActive(item);
            const label = item.kind === "auto" ? "auto" : item.label;

            return (
              <button
                key={item.kind === "auto" ? "__auto__" : item.value}
                onClick={() => handleSelect(item)}
                className={`shrink-0 flex items-center px-3 py-0.5 text-left transition-opacity hover:opacity-100 ${active ? "opacity-100" : "opacity-35"}`}
              >
                <span
                  className="font-mono block whitespace-nowrap"
                  style={{
                    fontSize: "var(--pane-font-size-xs)",
                    color: active ? "var(--pane-status-added)" : "var(--pane-text)",
                    lineHeight: 1.5,
                  }}
                >
                  {label}
                </span>
              </button>
            );
          })}
          </div>
        </div>
      </div>

      {/* Dismiss */}

      <button
        onClick={onClose}
        className="shrink-0 text-pane-text-secondary/30 hover:text-pane-text-secondary/60 transition-colors"
        style={{ fontSize: "14px", lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Thoughts picker — inline, inside the card ───────────────────────────────
//
// Triggered by typing "@m" in the textarea. Shows mind entries filtered by the
// text after "@m". Clicking an entry pastes its content directly into the textarea
// and closes the picker. No referencing, no tagging — just paste.

function ThoughtsPicker({
  query,
  onSelect,
  onDismiss,
}: {
  query: string;
  onSelect: (content: string) => void;
  onDismiss: () => void;
}) {
  const [mindEntries, setMindEntries] = useState<MindEntry[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    brainMindGetAll()
      .then((r) => setMindEntries(r.entries ?? []))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return mindEntries.slice(0, 8);
    return mindEntries.filter((m) => m.content.toLowerCase().includes(q)).slice(0, 8);
  }, [mindEntries, query]);

  useEffect(() => { setHighlighted(0); }, [query]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [highlighted]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!filtered.length) return;
      if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); setHighlighted((h) => Math.max(h - 1, 0)); }
      else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault(); e.stopPropagation();
        if (filtered[highlighted]) onSelect(filtered[highlighted].content);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [filtered, highlighted, onSelect, onDismiss]);

  if (!filtered.length) {
    return (
      <div className="px-5 py-2 border-t border-pane-border/20">
        <span className="font-mono text-pane-text-secondary/40" style={{ fontSize: "10px" }}>no thoughts</span>
      </div>
    );
  }

  return (
    <div className="border-t border-pane-border/20 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-1.5 flex flex-col gap-0.5" style={{ minHeight: "120px", maxHeight: "40vh" }}>
      {filtered.map((entry, idx) => (
        <button
          key={entry.id}
          ref={idx === highlighted ? activeRef : undefined}
          onClick={() => onSelect(entry.content)}
          onMouseEnter={() => setHighlighted(idx)}
          className={`w-full text-left px-3 py-1.5 rounded-md transition-colors font-mono ${
            idx === highlighted
              ? "bg-pane-text/[0.08] text-pane-text"
              : "text-pane-text-secondary hover:bg-pane-text/[0.03]"
          }`}
        >
          <span
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              fontSize: "var(--pane-font-size-xs)",
              lineHeight: 1.5,
            }}
          >
            {entry.content}
          </span>
        </button>
      ))}
    </div>
  );
}

export function InputBar({
  projectId,
  onSend,
  onAbort,
  isProcessing,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [modelPickerExpanded, setModelPickerExpanded] = useState(false);
  const [modePickerExpanded, setModePickerExpanded] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [caretPos, setCaretPos] = useState<{
    top: number;
    left: number;
    lineHeight: number;
  } | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);

  // Attach menu: closed → menu → thoughts
  const [attachMenu, setAttachMenu] = useState<"closed" | "menu" | "thoughts">("closed");

  // Reactive mode indicator — auto-detected from route preview
  const [detectedMode, setDetectedMode] = useState<DetectedMode | null>(null);
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  // Carry-forward: what mode was used on the last sent message.
  // Stays active until a strong transition signal overrides it.
  const [lastSentMode, setLastSentMode] = useState<string | null>(null);

  // Prefill from external sources (e.g., Lens "fix" button)
  useEffect(() => {
    const handler = (e: Event) => {
      const prompt = (e as CustomEvent).detail?.prompt;
      if (prompt) {
        setValue(prompt);
        // Focus the textarea so the user can review and send
        requestAnimationFrame(() => {
          const ta = document.querySelector<HTMLTextAreaElement>("[data-pane-input]");
          ta?.focus();
        });
      }
    };
    window.addEventListener("pane:prefill-prompt", handler);
    return () => window.removeEventListener("pane:prefill-prompt", handler);
  }, []);


  // Prepend mode directive: manual pill override > nothing.
  // Auto-detected mode is informational only — it does NOT prepend a directive
  // unless the user explicitly taps the pill to pin it.
  const buildPrompt = useCallback(
    (trimmed: string) => {
      // Manual override from pill tap — user explicitly chose this mode
      if (modeOverride) {
        const config = MODE_CONFIG[modeOverride];
        if (config?.directive) return config.directive + trimmed;
      }
      // Auto-detected: don't prepend anything — let the backend route naturally
      return trimmed;
    },
    [modeOverride],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretContainerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const todos = useProjectsStore(
    useShallow(
      (s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS,
    ),
  );
  const selectedModel = useWorkspaceStore((s) => s.selectedModel);
  const setSelectedModel = useWorkspaceStore((s) => s.setSelectedModel);
  const setHttpProvider = useWorkspaceStore((s) => s.setHttpProvider);
  const intentAutoRoute = useWorkspaceStore((s) => s.intentAutoRoute);
  const setIntentAutoRoute = useWorkspaceStore((s) => s.setIntentAutoRoute);

  // const intentRouting = useWorkspaceStore((s) => s.getEffectiveRouting());

  const routedModel = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.routedModel ?? null,
  );

  const projectRoot = useProjectsStore(
    (s) => s.projects.get(projectId)?.root ?? "",
  );

  // Handle model change and sync provider
  const handleModelChange = useCallback(
    (modelValue: string, thinking: boolean = false, provider?: string) => {
      setSelectedModel(modelValue, thinking, provider);
      if (provider) setHttpProvider(provider);
    },
    [setSelectedModel, setHttpProvider],
  );

  // ── Route preview: show predicted model as user types ──────────────────
  // Only active when smart routing is on. Debounced 300ms.
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!intentAutoRoute || isProcessing || value.trim().length < 3) {
      setRoutePreview(null);
      return;
    }

    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      previewRoute(value.trim(), projectId)
        .then(setRoutePreview)
        .catch(() => setRoutePreview(null));
    }, 300);

    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [value, intentAutoRoute, isProcessing, projectId]);

  // Mode classification with conversation carry-forward.
  // If we sent in a mode last turn, stay in it unless there's a strong transition signal.
  // This prevents "yeah plan it out" in a discuss session from switching to plan mode.
  useEffect(() => {
    if (modeOverride) return; // user tapped the pill — don't auto-update
    const trimmed = value.trim();
    if (trimmed.length < 5) {
      // Short text: show carry-forward mode if we have one, otherwise nothing
      if (lastSentMode) {
        const config = MODE_CONFIG[lastSentMode];
        if (config) setDetectedMode({ mode: lastSentMode, directive: config.directive, color: config.color });
      } else {
        setDetectedMode(null);
      }
      return;
    }

    // If we have a carry-forward mode, only break out on strong transition signals
    if (lastSentMode) {
      const transition = detectTransition(trimmed, lastSentMode);
      if (transition) {
        const config = MODE_CONFIG[transition];
        if (config) setDetectedMode({ mode: transition, directive: config.directive, color: config.color });
      } else {
        // Stay in the carry-forward mode
        const config = MODE_CONFIG[lastSentMode];
        if (config) setDetectedMode({ mode: lastSentMode, directive: config.directive, color: config.color });
      }
      return;
    }

    // No carry-forward — fresh classification
    const mode = routePreview ? mapRouteToMode(routePreview) : quickClassify(trimmed);
    const config = MODE_CONFIG[mode];
    if (config) {
      setDetectedMode({ mode, directive: config.directive, color: config.color });
    }
  }, [value, routePreview, modeOverride, lastSentMode]);

  // Clear override when input empties (but keep lastSentMode for carry-forward)
  useEffect(() => {
    if (value.trim().length < 3 && !lastSentMode) {
      setDetectedMode(null);
      setModeOverride(null);
    }
  }, [value, lastSentMode]);

  // Handle graceful fadeout of processing indicator.
  // Only fade out after real processing happened — not on initial mount.
  const wasProcessingRef = useRef(false);
  useEffect(() => {
    if (isProcessing) {
      wasProcessingRef.current = true;
      setIsFadingOut(false);
    } else if (wasProcessingRef.current) {
      wasProcessingRef.current = false;
      setIsFadingOut(true);
      const timer = setTimeout(() => setIsFadingOut(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [isProcessing]);

  // Update static caret position
  const updateCaret = useCallback(() => {
    const el = textareaRef.current;
    const container = caretContainerRef.current;
    if (!el || !container || document.activeElement !== el) {
      setCaretPos(null);
      return;
    }
    setCaretPos(measureCaretPos(el, container));
  }, []);

  // Reposition on every value change (covers typing)
  useEffect(() => {
    if (textareaFocused) updateCaret();
  }, [value, textareaFocused, updateCaret]);

  // Reposition on selection movement (arrows, mouse clicks, scroll)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const events = ["click", "keyup", "mouseup", "select", "scroll"];
    events.forEach((e) => el.addEventListener(e, updateCaret));
    return () => events.forEach((e) => el.removeEventListener(e, updateCaret));
  }, [updateCaret]);

  // Auto-focus when not processing
  useEffect(() => {
    if (!isProcessing && textareaRef.current && isConversationVisible()) {
      textareaRef.current.focus();
    }
  }, [isProcessing]);

  // Cmd+K focus
  useEffect(() => {
    const handler = () => {
      if (textareaRef.current && isConversationVisible()) {
        textareaRef.current.focus();
      }
    };
    window.addEventListener("pane:focus-input", handler);
    return () => window.removeEventListener("pane:focus-input", handler);
  }, []);

  // Auto-resize textarea — always floor at minH so it never collapses to one line.
  // Setting to "1px" first forces scrollHeight to report the true content height.
  // Runs on mount ([] dep) to stamp the initial height before first paint,
  // and on every value change to grow/shrink with content.
  const applyTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const minH = 56;
    const maxH = window.innerHeight * 0.4;
    // Don't collapse below minH — set to 1px only to measure scrollHeight,
    // then immediately restore to the correct height in the same frame.
    el.style.height = "1px";
    const overflowing = el.scrollHeight > maxH;
    el.style.height = Math.min(Math.max(el.scrollHeight, minH), maxH) + "px";
    // When overflowing, the browser's native caret scroll only guarantees the
    // caret lands within [scrollTop, scrollTop + clientHeight]. Force-scroll
    // to absolute bottom when typing at the end so content stays visible.
    if (overflowing && el.selectionEnd >= el.value.length - 1) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    applyTextareaHeight();
  }, [value, applyTextareaHeight]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const pos = e.target.selectionStart ?? next.length;
    setValue(next);
    // @m shortcut — opens thoughts picker directly
    if (attachMenu === "closed") {
      let wordStart = pos;
      while (wordStart > 0 && next[wordStart - 1] !== " " && next[wordStart - 1] !== "\n") wordStart--;
      if (next.slice(wordStart, pos) === "@m") {
        setValue(next.slice(0, wordStart) + next.slice(pos)); // strip @m
        setAttachMenu("thoughts");
      }
    }
  }, [attachMenu]);

  // Paste selected thought content into the textarea and close the picker.
  // The textarea is unmounted while thoughts is open, so we update state
  // directly and focus after remount.
  const handleThoughtSelect = useCallback((content: string) => {
    setValue(prev => prev ? `${prev} ${content}` : content);
    setAttachMenu("closed");
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          const sentMode = modeOverride || detectedMode?.mode || null;
          onSend(buildPrompt(trimmed), undefined, sentMode || undefined);
          // Carry mode forward to next turn — conversation is continuous
          setLastSentMode(sentMode);
          setValue("");
          setModeOverride(null);
          setDetectedMode(null);
        }
      }
      if (e.key === "Escape" && isProcessing) {
        e.preventDefault();
        onAbort();
      }
    },
    [value, isProcessing, onSend, onAbort, buildPrompt, modeOverride, detectedMode],
  );

  return (
    <div className="bg-transparent">
      {/* Processing indicator — only exists when active, no reserved space */}
      {(isProcessing || isFadingOut) && !todoPanelOpen && (
          <div
            className={`flex items-center gap-3 px-3 pb-3 ${isFadingOut ? "animate-fadeOut" : "animate-fadeIn"}`}
          >
            {/* Radiating strokes — gentle spin */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="text-pane-text-secondary/70 shrink-0 animate-gentle-spin"
            >
              <line x1="12" y1="2"     x2="12"    y2="6" />
              <line x1="16.24" y1="7.76"  x2="19.07" y2="4.93" />
              <line x1="18" y1="12"    x2="22"    y2="12" />
              <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
              <line x1="12" y1="18"    x2="12"    y2="22" />
              <line x1="7.76" y1="16.24"  x2="4.93"  y2="19.07" />
              <line x1="6"  y1="12"    x2="2"     y2="12" />
              <line x1="7.76" y1="7.76"   x2="4.93"  y2="4.93" />
            </svg>
            {/* Previous indicators — swap above SVG for either if needed
            — circle-pulse (breathing circle):
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="1.5"
                 className="text-pane-text-secondary shrink-0">
              <circle cx="12" cy="12" r="7" fill="none"
                      className="animate-circle-pulse"
                      style={{ strokeWidth: "var(--circle-stroke-width, 1.5)" }} />
            </svg>
            — radiate (staggered opacity ripple):
            use animate-radiate-N classes on each stroke
            */}
            {todos.length > 0 && (
              <button
                onClick={() => setTodoPanelOpen((v) => !v)}
                className="text-pane-text-secondary font-mono hover:text-pane-text btn-press shrink-0 truncate"
                style={{ fontSize: "var(--pane-font-size-sm)" }}
              >
                {(() => {
                  const completedCount = todos.filter(
                    (t) => t.status === "completed",
                  ).length;
                  const totalCount = todos.length;
                  const inProgressIdx = todos.findIndex(
                    (t) => t.status === "in_progress",
                  );
                  const currentIdx =
                    inProgressIdx !== -1 ? inProgressIdx : completedCount;

                  const displayIdx = Math.min(currentIdx, totalCount - 1);
                  const currentTask = todos[displayIdx];

                  if (completedCount === totalCount) return "done";
                  return `${completedCount + 1}/${totalCount} ${currentTask?.activeForm || currentTask?.content}`;
                })()}
              </button>
            )}
            <button
              onClick={onAbort}
              className="text-pane-error font-mono hover:text-pane-error/80 ml-auto btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              stop
            </button>
          </div>
        )}

      {todoPanelOpen && todos.length > 0 && (
        <TodoPanel
          projectId={projectId}
          onCollapse={() => setTodoPanelOpen(false)}
        />
      )}

      {/* One card. Textarea + thoughts picker + button bar in column. */}
      <div className="bg-pane-bg rounded-xl ring-1 ring-pane-border/40 relative flex flex-col">

        {attachMenu !== "thoughts" && <div ref={caretContainerRef} className="relative overflow-hidden">
          <textarea
            data-pane-input
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => { setTextareaFocused(true); updateCaret(); if (attachMenu === "menu") setAttachMenu("closed"); }}
            onBlur={() => { setTextareaFocused(false); setCaretPos(null); }}
            onScroll={() => { if (overlayRef.current && textareaRef.current) overlayRef.current.scrollTop = textareaRef.current.scrollTop; }}
            placeholder={isProcessing ? "" : "let's build..."}
            className="w-full bg-transparent text-pane-text font-mono
                       resize-none outline-none placeholder:text-pane-text-secondary
                       leading-[1.75] px-5 pt-4 pb-3 overflow-y-auto overflow-x-hidden"
            style={{
              fontSize: "var(--pane-font-size)",
              caretColor: "transparent",
              color: "transparent",
              minHeight: "56px",
              maxHeight: "40vh",
              height: "56px",
            }}
          />
          {/* Highlight overlay — mirrors textarea text */}
          <div
            ref={overlayRef}
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              overflow: "hidden",
              pointerEvents: "none",
              fontSize: "var(--pane-font-size)",
              lineHeight: "1.75",
              paddingTop: "1rem",
              paddingBottom: "0.75rem",
              paddingLeft: "1.25rem",
              paddingRight: "1.25rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', 'Fira Code', Consolas, monospace",
            }}
          >
            <span style={{ color: "var(--pane-text)" }}>{value}</span>
            {/* Invisible trailing character keeps scrollHeight stable */}
            <span aria-hidden> </span>
          </div>
          {textareaFocused && caretPos && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: caretPos.top,
                left: caretPos.left,
                width: 2,
                height: caretPos.lineHeight,
                background: "var(--pane-editor-cursor)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>}

        {/* Send — top right, only when textarea is visible */}
        {attachMenu !== "thoughts" && value.trim().length > 0 && (
          <button
            onClick={() => {
              const trimmed = value.trim();
              if (!trimmed) return;
              const sentMode = modeOverride || detectedMode?.mode || null;
              onSend(buildPrompt(trimmed), undefined, sentMode || undefined);
              setLastSentMode(sentMode);
              setValue("");
              setModeOverride(null);
              setDetectedMode(null);
            }}
            className="absolute top-1.5 right-1.5 z-10 w-9 h-9 flex items-center justify-center rounded-lg text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] transition-all duration-150 btn-press ring-1 ring-pane-border/40"
            title="Send (Enter)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 9 7-7 7 7" /><path d="M12 16V2" /><circle cx="12" cy="21" r="1" />
            </svg>
          </button>
        )}

        {/* Thoughts picker — replaces textarea, fills the same space */}
        {attachMenu === "thoughts" && (
          <ThoughtsPicker
            query=""
            onSelect={handleThoughtSelect}
            onDismiss={() => setAttachMenu("closed")}
          />
        )}

        {/* Button bar — attach (left) + mode + model (right), all in one row */}
        <div
          className="flex items-center gap-2 p-1.5 font-mono pointer-events-none"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {modelPickerExpanded ? (
            <ModelPickerExpanded
              value={selectedModel}
              autoRoute={intentAutoRoute}
              onChange={handleModelChange}
              onToggleAutoRoute={setIntentAutoRoute}
              onClose={() => setModelPickerExpanded(false)}
            />
          ) : (
            <>
              {/* Attach — first item, inherits font-mono + font-size-xs from this row */}
              {attachMenu === "menu" ? (
                <>
                  <button
                    onClick={() => setAttachMenu("thoughts")}
                    className="pointer-events-auto shrink-0 flex items-center px-3 py-0.5 opacity-35 hover:opacity-100 transition-opacity btn-press"
                  >
                    <span className="whitespace-nowrap" style={{ color: "var(--pane-text)", lineHeight: 1.5 }}>thoughts</span>
                  </button>
                  <button
                    onClick={async () => {
                      setAttachMenu("closed");
                      try {
                        const paths = await showFilePicker(projectRoot, projectRoot);
                        if (!paths || paths.length === 0) return;
                        const insertion = paths.map(p => `\`${p}\``).join(" ");
                        setValue(prev => prev ? `${prev} ${insertion}` : insertion);
                      } catch (err) { console.error('Failed to open file picker:', err); }
                    }}
                    className="pointer-events-auto shrink-0 flex items-center px-3 py-0.5 opacity-35 hover:opacity-100 transition-opacity btn-press"
                  >
                    <span className="whitespace-nowrap" style={{ color: "var(--pane-text)", lineHeight: 1.5 }}>path</span>
                  </button>
                  <button
                    onClick={() => setAttachMenu("closed")}
                    className="pointer-events-auto shrink-0 flex items-center px-2 py-0.5 opacity-35 hover:opacity-60 transition-opacity"
                    style={{ lineHeight: 1 }}
                  >
                    ×
                  </button>
                </>
              ) : (
                <div className="self-stretch shrink-0 flex items-center">
                  <button
                    onClick={() => setAttachMenu(attachMenu === "thoughts" ? "closed" : "menu")}
                    className="pointer-events-auto h-full aspect-square flex items-center justify-center rounded-md
                      bg-pane-bg ring-1 ring-pane-border/25
                      text-pane-text-secondary hover:text-pane-text btn-press transition-colors"
                  >
                    {attachMenu === "thoughts" ? (
                      <span style={{ lineHeight: 1 }}>×</span>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 2v16M2 10h16" strokeWidth="2" />
                      </svg>
                    )}
                  </button>
                </div>
              )}

              {/* Spacer — always present except when ModePickerExpanded takes the whole row */}
              {!modePickerExpanded && <div className="flex-1" />}
              {!isProcessing && (() => {
                const mode = modeOverride || detectedMode?.mode || lastSentMode || "execute";
                const config = MODE_CONFIG[mode];
                const color = config?.color || "var(--pane-text-secondary)";
                if (modePickerExpanded) {
                  return (
                    <ModePickerExpanded
                      activeMode={mode}
                      onSelect={(m) => setModeOverride(m)}
                      onClose={() => setModePickerExpanded(false)}
                    />
                  );
                }
                return (
                  <button
                    onClick={() => setModePickerExpanded(true)}
                    className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md shrink-0
                      bg-pane-bg ring-1 ring-pane-border/25
                      hover:text-pane-text btn-press transition-colors"
                    style={{ color }}
                  >
                    <span>{mode}</span>
                  </button>
                );
              })()}
              {routePreview && !isProcessing && (
                <span className="pointer-events-none opacity-40">
                  {routePreview.model}
                </span>
              )}
              <ContextUsageIndicator projectId={projectId} />
              <RateLimitIndicator />
              <div className="pointer-events-auto">
                <ModelPickerTrigger
                  value={selectedModel}
                  autoRoute={intentAutoRoute}
                  routedModel={routedModel}
                  isProcessing={isProcessing}
                  onClick={() => setModelPickerExpanded(true)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
