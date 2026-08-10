import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useShallow } from "zustand/react/shallow";
import type { Todo } from "../../lib/punk-types";
import { isThinkingModel } from "../../lib/models";
import { showFilePicker, brainMindGetAll, brainMindAdd, type MindEntry } from "../../lib/tauri-commands";
import { useMindStore } from "../../stores/mind";
import { CaretTextArea } from "../shared";

const EMPTY_TODOS: Todo[] = [];

// ── Two-phase system ─────────────────────────────────────────────────────────
// think = discuss + brainstorm + plan (thinking model)
// build = execute the plan (execution model)
// Phase is sticky — persists across messages until explicitly changed.

const _PHASE_CYCLE = ["think", "build"] as const;
type PhaseName = typeof _PHASE_CYCLE[number];

const PHASE_CONFIG: Record<PhaseName, { color: string }> = {
  think: { color: "var(--pane-status-modified)" },
  build: { color: "var(--pane-status-added)" },
};

/**
 * Detect a strong phase transition signal from the user's message.
 * Only explicit action or pause phrases trigger a switch.
 * Weak references ("let's plan this later") are NOT transitions.
 */
function detectPhaseTransition(text: string, currentPhase: PhaseName): PhaseName | null {
  const t = text.trim().toLowerCase();

  // think → build: user approves a plan and wants action now
  if (currentPhase === "think") {
    if (/^(do it|go ahead|ship it|let'?s go|build it|execute|make it happen|yes do it|ok do it|start building|let'?s build|implement it|go for it)\s*[.!]?$/i.test(t)) {
      return "build";
    }
    if (t.length < 20 && /^(yes|yep|yup|ok|okay|sure|proceed|approved|lgtm|go)\s*[.!]?$/i.test(t)) {
      return "build";
    }
  }

  // build → think: user wants to stop and rethink
  if (currentPhase === "build") {
    if (/^(wait|stop|hold on|let'?s (talk|discuss|think|rethink)|actually|pause)\b/i.test(t)) {
      return "think";
    }
  }

  return null;
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
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectProvider = useProjectsStore(
    (s) => (activeProjectId ? s.projects.get(activeProjectId)?.selectedModelProvider : undefined) ?? null,
  );
  const wsProvider = useWorkspaceStore((s) => s.selectedModelProvider);
  // Per-project provider takes priority, matching how InputBar resolves the model.
  const provider = projectProvider ?? wsProvider;
  const info = useWorkspaceStore((s) => s.rateLimitByProvider[provider]);
  const setRateLimitForProvider = useWorkspaceStore((s) => s.setRateLimitForProvider);

  const resetEpochMs = info?.resetsAt ? info.resetsAt * 1000 : info?.overageResetsAt ? info.overageResetsAt * 1000 : null;

  // Auto-expire when reset window passes.
  useEffect(() => {
    if (!resetEpochMs) return;
    const delay = resetEpochMs - Date.now();
    if (delay <= 0) { setRateLimitForProvider(provider, null); return; }
    const t = setTimeout(() => setRateLimitForProvider(provider, null), delay);
    return () => clearTimeout(t);
  }, [resetEpochMs, setRateLimitForProvider, provider]);

  if (!info) return null;

  const pct = info.utilization != null ? Math.round(info.utilization * 100) : null;
  const isRejected = info.status === "rejected";
  const resetTime = resetEpochMs ? formatRelativeTime(resetEpochMs) : null;

  // Exhausted / rejected — short word, reset time.
  if (isRejected) {
    return (
      <span className="font-mono tabular-nums text-pane-error" style={{ fontSize: "var(--pane-font-size-xs)" }}>
        limit{resetTime && ` · ${resetTime}`}
      </span>
    );
  }

  // Always visible — color escalates as usage climbs.
  if (pct != null) {
    const color = pct >= 90 ? "text-pane-error" : pct >= 60 ? "text-[var(--pane-status-modified)]" : "text-pane-text-secondary/30";
    return (
      <span className={`font-mono tabular-nums ${color}`} style={{ fontSize: "var(--pane-font-size-xs)" }}>
        usage {pct}%
      </span>
    );
  }

  return null;
}


// ─── Static caret (no-blink) ─────────────────────────────────────────────────
//
// Chrome's caret blink is native — CSS `animation` on `caret-color` only works
// in Firefox. The reliable fix: hide the native caret with `caretColor: transparent`
// and render a static 2px div positioned via the Range API on the overlay text node.
//
// The mirror is a hidden div with identical typography/padding to the textarea.
// We insert text up to selectionStart, append a zero-width marker span, then
// read marker.offsetTop/offsetLeft as the caret coordinates.


interface InputBarProps {
  projectId: string;
  onSend: (message: string, minds?: Array<{ id: string }>, phase?: string) => void;
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
  gemini: "Gemini",
  "gemini-api": "Gemini API",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  kimi: "Kimi",
  stepfun: "StepFun",
  "z-ai": "Z.ai",
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
  plain,
}: {
  value: string;
  autoRoute: boolean;
  routedModel?: string | null;
  isProcessing?: boolean;
  onClick: () => void;
  plain?: boolean;
}) {
  const fetchedModels = useWorkspaceStore((s) => s.allModels);
  const label = useMemo(() => {
    if (autoRoute) {
      if (isProcessing && routedModel) {
        for (const models of Object.values(fetchedModels)) {
          const found = models?.find((m) => m.id === routedModel);
          if (found) return (found.name || found.id).toLowerCase();
        }
      }
      return "pane auto";
    }
    for (const models of Object.values(fetchedModels)) {
      const found = models?.find((m) => m.id === value);
      if (found) return (found.name || found.id).toLowerCase();
    }
    return value.toLowerCase() || "model";
  }, [value, autoRoute, routedModel, isProcessing, fetchedModels]);

  if (plain) {
    return (
      <button
        onClick={onClick}
        className="inline-flex items-center gap-1.5 text-pane-text-secondary btn-press select-none"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        <div className={`w-1.5 h-1.5 rounded-full transition-colors shrink-0 ${autoRoute ? "bg-pane-status-added" : "bg-pane-text-secondary"}`} />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
        bg-pane-bg ring-1 ring-pane-border/25
        text-pane-text-secondary btn-press select-none"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      <div className={`w-1.5 h-1.5 rounded-full transition-colors shrink-0 ${autoRoute ? "bg-pane-status-added" : "bg-pane-text-secondary"}`} />
      <span>{label}</span>
    </button>
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
  const curatedModels = useWorkspaceStore((s) => s.curatedModels);

  const allItems = useMemo<ModelItem[]>(() => {
    const hasCurated = curatedModels.length > 0;
    // Group by provider, Claude first, then alphabetical
    const grouped = new Map<string, ModelItem[]>();
    for (const [providerKey, models] of Object.entries(fetchedModels)) {
      if (!models || models.length === 0) continue;
      if (disabledProviders.includes(providerKey)) continue;
      const group: ModelItem[] = [];
      for (const m of models) {
        if (hasCurated && !curatedModels.includes(m.id)) continue;
        group.push({
          kind: "model",
          value: m.id,
          label: (m.name || m.id).toLowerCase(),
          providerLabel: resolveProviderName(providerKey),
          providerKey,
          thinking: isThinkingModel(m.id),
        });
      }
      if (group.length > 0) grouped.set(providerKey, group);
    }
    const sortedKeys = Array.from(grouped.keys()).sort((a, b) => {
      if (a === "anthropic") return -1;
      if (b === "anthropic") return 1;
      return resolveProviderName(a).localeCompare(resolveProviderName(b));
    });
    const items: ModelItem[] = [{ kind: "auto" }];
    for (const key of sortedKeys) items.push(...(grouped.get(key) ?? []));
    return items;
  }, [fetchedModels, disabledProviders, curatedModels]);

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
  const [modelPickerExpanded, setModelPickerExpanded] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [expandedSection, setExpandedSection] = useState<"none" | "input" | "todos">("none");
  const todosRef = useRef<HTMLDivElement>(null);

  // Attach menu: closed → menu → thoughts
  const [attachMenu, setAttachMenu] = useState<"closed" | "menu" | "thoughts">("closed");

  // Mind mode — redirects Enter to mind store instead of conversation
  const [isMindMode, setIsMindMode] = useState(false);

  // Phase system — sticky, derived from conversation store.
  // phaseOverride is a local tap (cleared after send to re-sync with store).
  const [phaseOverride, setPhaseOverride] = useState<PhaseName | null>(null);

  // Read sticky phase from conversation store — authoritative source of truth
  const storePhase = useProjectsStore(
    (s) => {
      const raw = s.projects.get(projectId)?.conversation.phase;
      if (raw === "think" || raw === "build") return raw as PhaseName;
      return "think" as PhaseName; // default to think for new conversations
    }
  );

  const currentPhase: PhaseName = phaseOverride ?? storePhase;

  // Prefill from external sources (e.g., Lens "fix" button)
  useEffect(() => {
    const handler = (e: Event) => {
      const prompt = (e as CustomEvent).detail?.prompt;
      if (prompt) {
        setValue(prompt);
        setExpandedSection("input");
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


  // No directive prepending needed — phase is passed as a separate field.
  const buildPrompt = useCallback((trimmed: string) => trimmed, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const todos = useProjectsStore(
    useShallow(
      (s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS,
    ),
  );
  // Per-project model: project-level overrides workspace default
  const wsSelectedModel = useWorkspaceStore((s) => s.selectedModel);
  const wsAutoEscalate = useWorkspaceStore((s) => s.autoEscalate);
  const projectModel = useProjectsStore((s) => s.projects.get(projectId)?.selectedModel ?? null);
  const projectAutoRoute = useProjectsStore((s) => s.projects.get(projectId)?.autoEscalate ?? null);
  const selectedModel = projectModel ?? wsSelectedModel;
  const autoEscalate = projectAutoRoute ?? wsAutoEscalate;
  const setSelectedModel = useWorkspaceStore((s) => s.setSelectedModel);
  const setHttpProvider = useWorkspaceStore((s) => s.setHttpProvider);
  const setAutoEscalate = useWorkspaceStore((s) => s.setAutoEscalate);

  const routedModel = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.routedModel ?? null,
  );

  const projectRoot = useProjectsStore(
    (s) => s.projects.get(projectId)?.root ?? "",
  );

  // Handle model change and sync provider + per-project model
  const handleModelChange = useCallback(
    (modelValue: string, thinking: boolean = false, provider?: string) => {
      setSelectedModel(modelValue, thinking, provider);
      if (provider) setHttpProvider(provider);
      // Also persist to project for per-project model isolation
      const ps = useProjectsStore.getState();
      ps.setProjectSelectedModel(projectId, modelValue, thinking, provider);
    },
    [setSelectedModel, setHttpProvider, projectId],
  );

  // Handle auto-route toggle — saves to both workspace (global default) and project
  const handleToggleAutoRoute = useCallback(
    (v: boolean) => {
      setAutoEscalate(v);
      const ps = useProjectsStore.getState();
      ps.setProjectAutoEscalate(projectId, v);
    },
    [setAutoEscalate, projectId],
  );

  // Phase transition detection — only updates phaseOverride on strong signals.
  // Weak references ("let's think about this") inside build phase do NOT switch.
  useEffect(() => {
    if (phaseOverride) return; // user already tapped the pill
    const trimmed = value.trim();
    if (trimmed.length < 3) return;
    const transition = detectPhaseTransition(trimmed, currentPhase);
    if (transition) setPhaseOverride(transition);
  }, [value, currentPhase, phaseOverride]);

  // Clear override when input is fully empty — a <3 threshold (intended for
  // auto-detected transitions) also killed manual pill toggles: user clicks
  // think→build, types the first character, and the override is cleared
  // before they've typed enough to be meaningful.
  useEffect(() => {
    if (value.trim().length === 0) setPhaseOverride(null);
  }, [value]);

  // Handle graceful fadeout of processing indicator.
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

  // Collapse to ghost state when clicking outside the card or todos panel.
  useEffect(() => {
    if (expandedSection === "none") return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const outsideCard = cardRef.current && !cardRef.current.contains(target);
      const outsideTodos = todosRef.current && !todosRef.current.contains(target);
      if (expandedSection === "input") {
        if (outsideCard && !value.trim()) setExpandedSection("none");
      } else if (expandedSection === "todos") {
        if (outsideTodos) setExpandedSection("none");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expandedSection, value]);

  // Auto-focus when input expands
  useEffect(() => {
    if (expandedSection === "input" && textareaRef.current && isConversationVisible()) {
      textareaRef.current.focus();
    }
  }, [expandedSection]);

  // Cmd+K focus
  useEffect(() => {
    const handler = () => {
      if (isConversationVisible()) {
        setExpandedSection("input");
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener("pane:focus-input", handler);
    return () => window.removeEventListener("pane:focus-input", handler);
  }, []);

  // Cmd+M — toggle mind mode from anywhere in conversation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "m") {
        if (!isConversationVisible()) return;
        e.preventDefault();
        if (expandedSection !== "input") setExpandedSection("input");
        setIsMindMode(prev => !prev);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedSection]);

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

  // ─── Mind mode callbacks ────────────────────────────────────────────

  // Save to mind store and exit mind mode
  const handleMindSave = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      const result = await brainMindAdd(trimmed, projectId);
      if (result?.entry) {
        useMindStore.getState().addEntry(result.entry);
      }
    } catch { /* silent */ }
    setValue("");
    setIsMindMode(false);
  }, [value, projectId]);

  // Toggle mind mode — also expand input if collapsed
  const toggleMindMode = useCallback(() => {
    if (expandedSection !== "input") setExpandedSection("input");
    setIsMindMode(prev => !prev);
  }, [expandedSection]);

  // ─────────────────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          if (isMindMode) {
            handleMindSave();
          } else {
            onSend(buildPrompt(trimmed), undefined, currentPhase);
            setValue("");
            setExpandedSection("none");
            setPhaseOverride(null);
          }
        }
      }
      if (e.key === "Escape") {
        if (isMindMode) {
          e.preventDefault();
          setIsMindMode(false);
          return;
        }
        if (isProcessing) {
          e.preventDefault();
          onAbort();
        }
      }
    },
    [value, isProcessing, isMindMode, onSend, onAbort, buildPrompt, currentPhase, handleMindSave],
  );

  return (
    <div className="bg-transparent">
      {/* Processing indicator — absolute like the ghost trigger, floats over scroll
          content with zero layout footprint and no background. Hidden once the
          user expands the input bar (expanded card takes over). */}
      {(isProcessing || isFadingOut) && expandedSection === "none" && (
        <div
          className={`absolute bottom-0 left-0 right-0 flex items-center gap-3 px-3 pb-3 bg-transparent ${isFadingOut ? "animate-fadeOut" : "animate-fadeIn"}`}
        >
          {/* Pane logo — gentle spin */}
          <svg
            width="26"
            height="26"
            viewBox="0 0 1080 1080"
            fill="currentColor"
            className="shrink-0 animate-gentle-spin"
            style={{ color: "var(--pane-accent)" }}
          >
            <rect x="537.64" y="716.95" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(1532.34 709.43) rotate(117.97)"/>
            <rect x="339.14" y="645.42" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(911.14 1351.24) rotate(162.97)"/>
            <rect x="249.37" y="454.48" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(239.05 1165.33) rotate(-152.03)"/>
            <rect x="320.9" y="255.98" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(95.77 779.63) rotate(-107.03)"/>
            <rect x="511.84" y="166.21" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(46.18 606.07) rotate(-62.03)"/>
            <rect x="710.34" y="237.74" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(-66.64 227.28) rotate(-17.03)"/>
            <rect x="800.11" y="428.68" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(342.42 -320.83) rotate(27.97)"/>
            <rect x="728.58" y="627.18" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(1219.73 -198.15) rotate(72.97)"/>
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
          {todos.length > 0 ? (
            <button
              onClick={() => setExpandedSection("todos")}
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
          ) : (
            /* Placeholder — shows status when no todos; text ember animation signals activity */
            <button
              onClick={() => setExpandedSection("input")}
              className="font-mono animate-text-ember text-left"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              working on it
            </button>
          )}
          <div className="ml-auto shrink-0 flex items-center gap-1.5">
            <RateLimitIndicator />
            {/* Mode pill — shows active phase in collapsed bar */}
            <button
              onClick={() => setExpandedSection("input")}
              className="font-mono btn-press shrink-0 px-2 py-0.5 rounded transition-colors"
              style={{ fontSize: "var(--pane-font-size-xs)", color: PHASE_CONFIG[currentPhase]?.color || "var(--pane-text-secondary)" }}
            >
              {currentPhase}
            </button>
            <ModelPickerTrigger
              value={selectedModel}
              autoRoute={autoEscalate}
              routedModel={routedModel}
              isProcessing={isProcessing}
              onClick={() => { setModelPickerExpanded(true); setExpandedSection("input"); }}
              plain
            />
          </div>
          <button
            onClick={onAbort}
            className="text-pane-error font-mono hover:text-pane-error/80 btn-press shrink-0"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            stop
          </button>
        </div>
      )}

      {/* Ghost trigger — absolute, zero layout footprint, floats over scroll content */}
      {expandedSection === "none" && !isProcessing && !isFadingOut && (
        <div
          className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-transparent font-mono px-5 py-3 pointer-events-none"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              onClick={() => setExpandedSection("input")}
              className="text-left text-pane-text-secondary/25 hover:text-pane-text-secondary/40 transition-colors"
            >
              let's build
            </button>
          </div>
          <div className="pointer-events-auto shrink-0 flex items-center gap-1.5">
            <RateLimitIndicator />
            {/* Mode pill — shows active phase in ghost trigger */}
            <button
              onClick={() => setExpandedSection("input")}
              className="font-mono btn-press shrink-0 px-2 py-0.5 rounded transition-colors"
              style={{ fontSize: "var(--pane-font-size-xs)", color: PHASE_CONFIG[currentPhase]?.color || "var(--pane-text-secondary)" }}
            >
              {currentPhase}
            </button>
            <ModelPickerTrigger
              value={selectedModel}
              autoRoute={autoEscalate}
              routedModel={routedModel}
              isProcessing={isProcessing}
              onClick={() => { setModelPickerExpanded(true); setExpandedSection("input"); }}
              plain
            />
          </div>
        </div>
      )}

      {/* Processing bar above expanded card — spinner + stop float above, InputBar stays clean */}
      {expandedSection === "input" && (isProcessing || isFadingOut) && attachMenu !== "thoughts" && (
        <div
          className={`flex items-center gap-3 px-3 pb-2 bg-transparent ${isFadingOut ? "animate-fadeOut" : "animate-fadeIn"}`}
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 1080 1080"
            fill="currentColor"
            className="shrink-0 animate-gentle-spin"
            style={{ color: "var(--pane-accent)" }}
          >
            <rect x="537.64" y="716.95" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(1532.34 709.43) rotate(117.97)"/>
            <rect x="339.14" y="645.42" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(911.14 1351.24) rotate(162.97)"/>
            <rect x="249.37" y="454.48" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(239.05 1165.33) rotate(-152.03)"/>
            <rect x="320.9" y="255.98" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(95.77 779.63) rotate(-107.03)"/>
            <rect x="511.84" y="166.21" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(46.18 606.07) rotate(-62.03)"/>
            <rect x="710.34" y="237.74" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(-66.64 227.28) rotate(-17.03)"/>
            <rect x="800.11" y="428.68" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(342.42 -320.83) rotate(27.97)"/>
            <rect x="728.58" y="627.18" width="30.52" height="196.84" rx="4.26" ry="4.26" transform="translate(1219.73 -198.15) rotate(72.97)"/>
          </svg>
          <span
            className="font-mono text-pane-text-secondary/40"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            working on it
          </span>
          <button
            onClick={onAbort}
            className="ml-auto text-pane-error font-mono hover:text-pane-error/80 btn-press shrink-0"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            stop
          </button>
        </div>
      )}

      {/* One card. Textarea + thoughts picker + button bar in column. */}
      {expandedSection === "input" && <div ref={cardRef} className="rounded-xl ring-1 relative flex flex-col ring-pane-border/40 mx-px mb-px">
        {attachMenu !== "thoughts" && (
          <CaretTextArea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={isMindMode ? "what's on your mind?" : "let's build..."}
            minHeight={56}
            maxHeight={window.innerHeight * 0.4}
            autoResize
            className="w-full"
            style={{
              padding: "1rem 1.25rem 0.75rem 1.25rem",
            }}
            onDropFiles={(paths) => {
              const ta = textareaRef.current;
              if (!ta) return;
              const insertion = paths.map(p => `\`${p}\``).join(" ");
              const pos = ta.selectionStart ?? ta.value.length;
              const newValue = ta.value.slice(0, pos) + (pos > 0 && !ta.value.slice(pos - 1, pos).endsWith(" ") ? " " : "") + insertion + " " + ta.value.slice(pos);
              setValue(newValue);
              // Restore cursor after the inserted paths
              const newCursorPos = pos + (pos > 0 && !ta.value.slice(pos - 1, pos).endsWith(" ") ? 1 : 0) + insertion.length + 1;
              requestAnimationFrame(() => {
                ta.focus();
                ta.setSelectionRange(newCursorPos, newCursorPos);
              });
            }}
          />
        )}

        {/* Send — top right, only when textarea is visible */}
        {attachMenu !== "thoughts" && value.trim().length > 0 && (
          <button
            onClick={() => {
              const trimmed = value.trim();
              if (!trimmed) return;
              if (isMindMode) {
                handleMindSave();
              } else {
                onSend(buildPrompt(trimmed), undefined, currentPhase);
                setValue("");
                setPhaseOverride(null);
              }
            }}
            className="absolute top-1.5 right-1.5 z-10 w-9 h-9 flex items-center justify-center rounded-lg text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] transition-all duration-150 btn-press ring-1 ring-pane-border/40"
            title={isMindMode ? "Save to mind (Enter)" : "Send (Enter)"}
          >
            {isMindMode ? (
              /* checkmark — save to mind */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              /* arrow — send to conversation */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 9 7-7 7 7" /><path d="M12 16V2" /><circle cx="12" cy="21" r="1" />
              </svg>
            )}
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

        {/* Button bar — attach (left) + mode + model (right), all in one row. */}
        <div
          className="flex items-center gap-2 p-1.5 font-mono pointer-events-none"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {modelPickerExpanded ? (
            <ModelPickerExpanded
              value={selectedModel}
              autoRoute={autoEscalate}
              onChange={handleModelChange}
              onToggleAutoRoute={handleToggleAutoRoute}
              onClose={() => setModelPickerExpanded(false)}
            />
          ) : (
            <>
              {/* Left group: attach + mind toggle */}
              <div className="shrink-0 flex items-center gap-3">
                {/* Attach (+) button */}
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
                  <button
                    onClick={() => setAttachMenu(attachMenu === "thoughts" ? "closed" : "menu")}
                    className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-md
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
                )}

                {/* Mind toggle — next to attach */}
                <button
                  onClick={toggleMindMode}
                  className={`pointer-events-auto w-8 h-8 flex items-center justify-center rounded-md btn-press transition-colors ring-1 ${
                    isMindMode
                      ? "text-pane-terminal bg-pane-bg ring-pane-border/25"
                      : "bg-pane-bg ring-pane-border/25 text-pane-text-secondary hover:text-pane-text"
                  }`}
                  title={isMindMode ? "Exit mind mode (⌘M)" : "Save to mind (⌘M)"}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                    style={isMindMode ? { filter: "drop-shadow(0 0 6px var(--pane-terminal))" } : undefined}
                  >
                    <circle cx="12" cy="12" r="9" fill={isMindMode ? "currentColor" : "none"} opacity={isMindMode ? 0.15 : 1} />
                    <circle cx="12" cy="12" r="3" fill={isMindMode ? "currentColor" : "none"} />
                  </svg>
                </button>
              </div>

              <div className="flex-1" />

              <RateLimitIndicator />

              {(() => {
                if (isMindMode) {
                  return (
                    <span
                      className="font-mono shrink-0 px-3 py-1.5 rounded-md"
                      style={{ fontSize: "var(--pane-font-size-sm)", color: "var(--pane-terminal)" }}
                    >
                      mind
                    </span>
                  );
                }
                const color = PHASE_CONFIG[currentPhase]?.color || "var(--pane-text-secondary)";
                if (isProcessing) {
                  return (
                    <span
                      className="font-mono shrink-0 px-3 py-1.5 rounded-md"
                      style={{ fontSize: "var(--pane-font-size-sm)", color }}
                    >
                      {currentPhase}
                    </span>
                  );
                }
                return (
                  <button
                    onClick={() => setPhaseOverride(currentPhase === "think" ? "build" : "think")}
                    className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md shrink-0
                      bg-pane-bg ring-1 ring-pane-border/25
                      hover:text-pane-text btn-press transition-colors"
                    style={{ color, fontSize: "var(--pane-font-size-sm)" }}
                  >
                    <span>{currentPhase}</span>
                  </button>
                );
              })()}
              <div className="pointer-events-auto">
                <ModelPickerTrigger
                  value={selectedModel}
                  autoRoute={autoEscalate}
                  routedModel={routedModel}
                  isProcessing={isProcessing}
                  onClick={() => setModelPickerExpanded(true)}
                />
              </div>
            </>
          )}
        </div>
      </div>}

      {/* Todos inside the same card + ring. No textarea, no button bar. */}
      {expandedSection === "todos" && todos.length > 0 && (
        <div ref={todosRef} className="rounded-xl ring-1 relative flex flex-col ring-pane-border/40 mx-px mb-px">
          <div className="space-y-1.5 px-5 py-4">
            {todos.map((todo, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="shrink-0 mt-[3px]">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    className={
                      todo.status === "in_progress"
                        ? "text-pane-text-secondary"
                        : todo.status === "completed"
                          ? "text-pane-text-secondary/25"
                          : "text-pane-text-secondary/15"
                    }
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="7"
                      fill="none"
                      strokeWidth="1.5"
                      className={todo.status === "in_progress" ? "animate-circle-pulse" : ""}
                      style={todo.status === "in_progress" ? { strokeWidth: 'var(--circle-stroke-width, 1.5)' } : undefined}
                    />
                  </svg>
                </div>
                <span
                  className={`font-mono leading-snug ${
                    todo.status === "completed"
                      ? "text-pane-text-secondary/35 line-through"
                      : todo.status === "in_progress"
                        ? "text-pane-text"
                        : "text-pane-text-secondary/50"
                  }`}
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                >
                  {todo.status === "in_progress"
                    ? todo.activeForm || todo.content
                    : todo.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
