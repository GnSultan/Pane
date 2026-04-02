import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { TodoPanel } from "./TodoPanel";
import ReferencePicker, { type ReferenceItem } from "../shared/ReferencePicker";
import type { Todo } from "../../lib/punk-types";
import {
  isThinkingModel,
} from "../../lib/models";
import { previewRoute, type RoutePreview } from "../../lib/tauri-commands";

const EMPTY_TODOS: Todo[] = [];

function RateLimitIndicator() {
  const info = useWorkspaceStore((s) => s.rateLimitInfo);
  if (!info) return null;
  const isWarning = info.status === "allowed_warning";
  const isRejected = info.status === "rejected";
  if (!isWarning && !isRejected) return null;

  const pct = info.utilization != null ? Math.round(info.utilization * 100) : null;
  const resetTime = info.resetsAt
    ? new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <span className={`font-mono tabular-nums ${isRejected ? "text-pane-error" : "text-pane-status-modified/70"}`} style={{ fontSize: "var(--pane-font-size-xs)" }}>
      {pct != null && <>{pct}% </>}{isRejected ? "limit reached" : "limit"}{resetTime && <> · resets {resetTime}</>}
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
  onSend: (message: string, minds?: Array<{ id: string }>) => void;
  onAbort: () => void;
  isProcessing: boolean;
}

function isConversationVisible(): boolean {
  const { activeProjectId, projects } = useProjectsStore.getState();
  if (!activeProjectId) return false;
  const project = projects.get(activeProjectId);
  return project?.mode === "conversation";
}

function ModelPicker({
  value,
  routedModel,
  onChange,
  autoRoute,
  onToggleAutoRoute,
  isProcessing,
}: {
  value: string;
  routedModel?: string | null;
  onChange: (v: string, thinking?: boolean, provider?: string) => void;
  autoRoute: boolean;
  onToggleAutoRoute: (v: boolean) => void;
  isProcessing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const fetchedModels = useWorkspaceStore((s) => s.allModels);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);

  const filteredProviderModels = useMemo(() => {
    const providers: Record<string, Array<{
      value: string;
      label: string;
      realProvider?: string;
      inputCost?: number | null;
      outputCost?: number | null;
      tier?: number;
      contextLength?: number;
    }>> = {};
    for (const [provider, models] of Object.entries(fetchedModels)) {
      if (!models || models.length === 0) continue;
      if (disabledProviders.includes(provider)) continue;
      providers[provider] = models.map((m: any) => ({
        value: m.id,
        label: m.name || m.id,
        realProvider: m.provider,
        inputCost: m.input_cost,
        outputCost: m.output_cost,
        tier: m.tier,
        contextLength: m.context_length,
      }));
    }
    return providers;
  }, [fetchedModels, disabledProviders]);

  const providerDisplayName = useCallback((providerKey: string): string => {
    const names: Record<string, string> = {
      anthropic: "Claude Code",
      "anthropic-api": "Anthropic API",
      gemini: "Gemini CLI",
      "gemini-api": "Gemini API",
      deepseek: "DeepSeek",
      openrouter: "OpenRouter",
      kimi: "Kimi",
      stepfun: "StepFun",
    };
    return names[providerKey] || providerKey;
  }, []);

  const allModels = useMemo(() => {
    const models: Array<{
      value: string;
      label: string;
      provider: string;
      providerKey: string;
      thinking?: boolean;
      inputCost?: number | null;
      outputCost?: number | null;
    }> = [];
    Object.entries(filteredProviderModels).forEach(([providerKey, list]) => {
      if (Array.isArray(list)) {
        list.forEach((m: {
          value: string;
          label: string;
          realProvider?: string;
          inputCost?: number | null;
          outputCost?: number | null;
          tier?: number;
        }) => {
          const displayProvider = m.realProvider || providerKey;
          models.push({
            value:      m.value,
            label:      m.label,
            provider:   displayProvider,
            providerKey: providerKey,
            thinking:   isThinkingModel(m.value),
            inputCost:  m.inputCost,
            outputCost: m.outputCost,
          });
        });
      }
    });
    return models;
  }, [filteredProviderModels]);

  // Fuzzy search - matches characters in order but not necessarily consecutively
  // Also calculates a relevance score for sorting results
  const fuzzyScore = (text: string, query: string): number => {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase().trim();
    
    if (!lowerQuery) return 0;
    
    let score = 0;
    let queryIndex = 0;
    let lastMatchIndex = -1;
    
    for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
      if (lowerText[i] === lowerQuery[queryIndex]) {
        // Bonus for consecutive matches
        if (lastMatchIndex !== -1 && i === lastMatchIndex + 1) {
          score += 5;
        }
        // Bonus for matching at start
        if (i === 0 && queryIndex === 0) {
          score += 10;
        }
        // Bonus for matching after separator (e.g., "claude" in "claude-3.5-sonnet")
        if (lowerText[i - 1] === '-' || lowerText[i - 1] === ' ') {
          score += 8;
        }
        score += 1;
        lastMatchIndex = i;
        queryIndex++;
      }
    }
    
    // Bonus for exact match
    if (lowerText === lowerQuery) {
      score += 20;
    }
    
    return queryIndex === lowerQuery.length ? score : -1;
  };

  // Filter models based on search query
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return allModels;
    const query = searchQuery.toLowerCase().trim();
    
    // Score and filter models
    const scoredModels = allModels
      .map((m) => {
        const labelScore = fuzzyScore(m.label, query);
        const valueScore = fuzzyScore(m.value, query);
        const providerScore = fuzzyScore(m.provider, query);
        const providerNameScore = fuzzyScore(providerDisplayName(m.providerKey), query);
        const maxScore = Math.max(labelScore, valueScore, providerScore, providerNameScore);
        return { model: m, score: maxScore };
      })
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score) // Higher scores first
      .map(({ model }) => model);
    
    return scoredModels;
  }, [allModels, searchQuery]);

  const current = allModels.find((m) => m.value === value);
  const currentDisplay = current || { value: value, label: value || "Select" };

  // Collapse on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);


  // When smart routing is active and the router has chosen a model for this turn, show it.
  // Requires routedModel to be explicitly set — don't show selectedModel as a pre-routing guess.
  const showSpecificModel =
    autoRoute && isProcessing && !!routedModel && current && !current.value.startsWith("auto-");

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md
          bg-pane-bg ring-1 ring-pane-border/25
          text-pane-text-secondary btn-press select-none"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        <div
          className={`w-1.5 h-1.5 rounded-full transition-colors ${autoRoute ? "bg-pane-status-added" : "bg-pane-text-secondary"}`}
        />
        <span className="flex items-center gap-1.5 transition-colors group-hover:text-pane-text-secondary">
          {autoRoute ? (
            showSpecificModel ? (
              <span className="hidden sm:inline-block transition-all duration-300 flex items-center gap-1">
                {current!.label.toLowerCase()}
                <span className={`w-1 h-1 rounded-full ${current!.providerKey === "anthropic" ? "bg-pane-status-added/60" : current!.providerKey === "gemini" ? "bg-pane-terminal/60" : "bg-pane-text-secondary/40"}`} title={providerDisplayName(current!.providerKey)} />
              </span>
            ) : (
              <span className="text-pane-text-secondary/60">smart routing</span>
            )
          ) : (
            <span className="flex items-center gap-1">
              {currentDisplay.label.toLowerCase()}
              {current && (
                <span className={`w-1 h-1 rounded-full ${current.providerKey === "anthropic" ? "bg-pane-status-added/60" : current.providerKey === "gemini" ? "bg-pane-terminal/60" : "bg-pane-text-secondary/40"}`} title={providerDisplayName(current.providerKey)} />
              )}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 bg-pane-bg ring-1 ring-pane-border/40 rounded-xl z-50 animate-fadeSlideUp">
          <div className="p-1.5 flex flex-col gap-0.5">
            {/* Smart Routing Toggle */}
            <button
              onClick={() => {
                onToggleAutoRoute(!autoRoute);
                setOpen(false);
              }}
              className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-left transition-colors ${
                autoRoute
                  ? "text-pane-text ring-1 ring-pane-border/50"
                  : "text-pane-text-secondary hover:text-pane-text hover:ring-1 hover:ring-pane-border/35"
              }`}
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[13px] font-medium">
                  Smart Routing
                </span>
                <span className="text-[10px] text-pane-text-secondary/60">
                  Auto-pick best model
                </span>
              </div>
              {autoRoute && (
                <div className="w-1.5 h-1.5 rounded-full bg-pane-status-added" />
              )}
            </button>

            <div className="h-px bg-pane-border/30 my-1 mx-2" />

            {/* Individual Models grouped by provider */}
            <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
              {Object.entries(
                filteredModels.reduce((acc, model) => {
                  if (!acc[model.providerKey]) acc[model.providerKey] = [];
                  acc[model.providerKey]?.push(model);
                  return acc;
                }, {} as Record<string, typeof filteredModels>),
              ).map(([providerKey, models]) => (
                <div key={providerKey} className="flex flex-col mb-2">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-pane-text-secondary/40 font-mono flex items-center gap-1.5">
                    {providerKey === "anthropic" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-pane-status-added/60" />
                    )}
                    {providerKey === "gemini" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-pane-terminal/60" />
                    )}
                    {providerKey !== "anthropic" && providerKey !== "gemini" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-pane-text-secondary/40" />
                    )}
                    {providerDisplayName(providerKey)}
                  </div>
                  {models?.map((model) => (
                    <button
                      key={model.value}
                      onClick={() => {
                        if (autoRoute) onToggleAutoRoute(false);
                        onChange(model.value, model.thinking, model.providerKey);
                        setOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-mono text-left transition-colors ${
                        !autoRoute && model.value === value
                          ? "text-pane-text ring-1 ring-pane-border/50"
                          : "text-pane-text-secondary hover:text-pane-text hover:ring-1 hover:ring-pane-border/35"
                      }`}
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[12px]">
                            {model.label.toLowerCase()}
                          </span>
                          <span className={`w-1 h-1 rounded-full ${model.providerKey === "anthropic" ? "bg-pane-status-added/60" : model.providerKey === "gemini" ? "bg-pane-terminal/60" : "bg-pane-text-secondary/40"}`} title={providerDisplayName(model.providerKey)} />
                        </div>
                        <div className="flex items-center gap-2">
                          {model.thinking && (
                            <span className="text-[9px] text-pane-status-added/60 uppercase tracking-tighter">
                              thinking
                            </span>
                          )}
                          {model.inputCost != null && (
                            <span className="text-[9px] text-pane-terminal/50 font-mono tabular-nums">
                              ${model.inputCost} · ${model.outputCost}/m
                            </span>
                          )}
                        </div>
                      </div>
                      {!autoRoute && model.value === value && (
                        <div className="w-1.5 h-1.5 rounded-full bg-pane-text" />
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Search bar at bottom - fixed like InputBar */}
            <div className="sticky bottom-0 bg-pane-bg border-t border-pane-border/25">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <svg
                  className="w-3.5 h-3.5 text-pane-text-secondary/35 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="search models..."
                  className="flex-1 bg-transparent text-pane-text text-[11px] font-mono outline-none placeholder:text-pane-text-secondary/35"
                  autoFocus
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="text-pane-text-secondary/35 hover:text-pane-text-secondary/55 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
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
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [caretPos, setCaretPos] = useState<{
    top: number;
    left: number;
    lineHeight: number;
  } | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);

  // @-reference picker state (replaces old / slash system)
  const [refOpen, setRefOpen] = useState(false);
  const [refQuery, setRefQuery] = useState("");
  const [attachedMinds, setAttachedMinds] = useState<Array<{ id: string }>>([]);
  const refStartRef = useRef<number>(-1); // cursor position right after @

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
    const minH = 96;
    const maxH = window.innerHeight * 0.4;
    // Don't collapse below minH — set to 1px only to measure scrollHeight,
    // then immediately restore to the correct height in the same frame.
    el.style.height = "1px";
    const overflowing = el.scrollHeight > maxH;
    el.style.height = Math.min(Math.max(el.scrollHeight, minH), maxH) + "px";
    // When overflowing, the browser's native caret scroll only guarantees the
    // caret lands within [scrollTop, scrollTop + clientHeight] — it doesn't
    // account for the 44px button overlay. Force-scroll to absolute bottom when
    // typing at the end so paddingBottom actually shows below the last line.
    if (overflowing && el.selectionEnd >= el.value.length - 1) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    applyTextareaHeight();
  }, [value, applyTextareaHeight]);

  // Detect `@m…` trigger for mind reference-picker
  // Opens as soon as typed chars after @ are a prefix of "mind" (e.g. @m, @mi, @min, @mind)
  // Once @mind is fully typed, additional chars become the filter query
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const pos = e.target.selectionStart ?? next.length;
    setValue(next);
    const thoughtCount = (next.match(/@thought/g) ?? []).length;
    setAttachedMinds((prev) => thoughtCount < prev.length ? prev.slice(0, thoughtCount) : prev);

    if (refOpen) {
      // Picker is open — verify @<prefix-of-mind> is still intact behind cursor
      const atIdx = refStartRef.current;
      const typed = next.slice(atIdx + 1, pos); // chars after '@'
      const isMindPrefix = "mind".startsWith(typed) || typed.startsWith("mind");
      if (next[atIdx] !== "@" || !isMindPrefix || next[pos - 1] === "\n") {
        setRefOpen(false);
      } else {
        // Query starts after the "mind" portion is fully typed
        setRefQuery(typed.length > 4 ? typed.slice(4) : "");
      }
    } else {
      // Scan backwards from cursor to find word start
      let wordStart = pos;
      while (wordStart > 0 && next[wordStart - 1] !== " " && next[wordStart - 1] !== "\n") {
        wordStart--;
      }
      const word = next.slice(wordStart, pos);
      if (word.length >= 2 && word[0] === "@") {
        const typed = word.slice(1); // chars after '@'
        // Open if typed chars are a prefix of "mind" or extend beyond it
        if ("mind".startsWith(typed) || typed.startsWith("mind")) {
          refStartRef.current = wordStart;
          setRefQuery(typed.length > 4 ? typed.slice(4) : "");
          setRefOpen(true);
        }
      }
    }
  }, [refOpen]);

  const handleRefSelect = useCallback((item: ReferenceItem) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const atPos = refStartRef.current; // index of '@'
    const cursorPos = ta.selectionStart ?? value.length;
    const before = value.slice(0, atPos);
    const after = value.slice(cursorPos);
    const tag = "@thought";
    const next = before + tag + (after.startsWith(" ") ? after : " " + after);
    setValue(next);
    setAttachedMinds((prev) => [...prev, { id: item.label }]);
    setRefOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = before.length + tag.length;
      ta.setSelectionRange(newPos, newPos);
    });
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          onSend(trimmed, attachedMinds.length > 0 ? attachedMinds : undefined);
          setValue("");
          setAttachedMinds([]);
        }
      }
      if (e.key === "Escape" && isProcessing) {
        // Close the reference picker before aborting
        if (refOpen && refStartRef.current !== -1) {
          e.preventDefault();
          const ta = textareaRef.current;
          if (ta) {
            const before = value.slice(0, refStartRef.current);
            const after = value.slice(ta.selectionStart ?? value.length);
            setValue(before + after);
            setRefOpen(false);
            refStartRef.current = -1;
            requestAnimationFrame(() => {
              ta.focus();
              const newPos = before.length;
              ta.setSelectionRange(newPos, newPos);
            });
          }
          return;
        }
        e.preventDefault();
        onAbort();
      }
    },
    [value, isProcessing, refOpen, attachedMinds, onSend, onAbort],
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

      {/* One card. Textarea owns the whole surface. Buttons float inside it. */}
      <div className="bg-pane-bg rounded-xl ring-1 ring-pane-border/40 relative">
        {refOpen && (
          <ReferencePicker
            query={refQuery}
            onSelect={handleRefSelect}
            onDismiss={() => { setRefOpen(false); refStartRef.current = -1; }}
          />
        )}
          <div ref={caretContainerRef} className="relative overflow-hidden">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => { setTextareaFocused(true); updateCaret(); }}
              onBlur={() => { setTextareaFocused(false); setCaretPos(null); }}
              onScroll={() => { if (overlayRef.current && textareaRef.current) overlayRef.current.scrollTop = textareaRef.current.scrollTop; }}
              placeholder={isProcessing ? "" : "let's build..."}
              className="w-full bg-transparent text-pane-text font-mono
                         resize-none outline-none placeholder:text-pane-text-secondary
                         leading-[1.75] px-5 pt-4 overflow-y-auto overflow-x-hidden"
              style={{
                fontSize: "var(--pane-font-size)",
                caretColor: "transparent",
                color: "transparent",
                minHeight: "120px",
                maxHeight: "40vh",
                height: "120px",
                paddingBottom: "44px",
              }}
            />
            {/* Highlight overlay — mirrors textarea text, colors @thought tokens */}
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
                paddingBottom: "44px",
                paddingLeft: "1.25rem",
                paddingRight: "1.25rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', 'Fira Code', Consolas, monospace",
              }}
            >
              {value.split(/(@thought)/g).map((part, i) =>
                part === "@thought" ? (
                  <span key={i} style={{ color: "var(--pane-status-modified)", fontWeight: 500 }}>@thought</span>
                ) : (
                  <span key={i} style={{ color: "var(--pane-text)" }}>{part}</span>
                )
              )}
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
          </div>

          {/* Send — top right */}
          {value.trim().length > 0 && (
            <button
              onClick={() => {
                const trimmed = value.trim();
                if (!trimmed) return;
                onSend(trimmed, attachedMinds.length > 0 ? attachedMinds : undefined);
                setValue("");
                setAttachedMinds([]);
              }}
              className="absolute top-1.5 right-1.5 z-10 w-9 h-9 flex items-center justify-center rounded-lg text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] transition-all duration-150 btn-press ring-1 ring-pane-border/40"
              title="Send (Enter)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 9 7-7 7 7" /><path d="M12 16V2" /><circle cx="12" cy="21" r="1" />
              </svg>
            </button>
          )}

          {/* Buttons — absolute bottom, floating over the textarea, no background */}
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center gap-2 p-1.5 font-mono pointer-events-none"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            <button
              onClick={() => {
                try {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.multiple = true;
                  input.webkitdirectory = true;
                  input.onchange = (e) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files && files.length > 0) {
                      const folderNames = new Set<string>();
                      Array.from(files).forEach(f => {
                        if (f.webkitRelativePath) {
                          const parts = f.webkitRelativePath.split('/');
                          if (parts.length > 0 && parts[0]) folderNames.add(parts[0]);
                        }
                      });
                      if (folderNames.size > 0) {
                        const pathsText = Array.from(folderNames).map(p => `\`./${p}\``).join('\n');
                        setValue(prev => prev ? `${prev}\n${pathsText}` : pathsText);
                      } else {
                        const pathsText = Array.from(files).map(f => {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          return `\`${(f as any).path || f.name}\``;
                        }).join('\n');
                        setValue(prev => prev ? `${prev}\n${pathsText}` : pathsText);
                      }
                    }
                  };
                  input.onerror = () => { input.webkitdirectory = false; input.click(); };
                  input.click();
                } catch (err) { console.error('Failed to open file picker:', err); }
              }}
              className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md shrink-0
                bg-pane-bg ring-1 ring-pane-border/25
                text-pane-text-secondary/50 hover:text-pane-text-secondary btn-press transition-colors"
              title="Add file or folder path"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>add path</span>
            </button>

            <div className="flex-1" />

            {/* Route preview — shows predicted model when smart routing is on */}
            {routePreview && !isProcessing && (
              <div className="pointer-events-none flex items-center gap-1.5 text-[10px] text-[var(--pane-text-secondary)] font-mono opacity-60">
                <span>{routePreview.model}</span>
                <span className="opacity-40">·</span>
                <span className="opacity-60">{routePreview.taskType}</span>
              </div>
            )}

            <RateLimitIndicator />
            <div className="pointer-events-auto">
              <ModelPicker
                value={selectedModel}
                routedModel={routedModel}
                onChange={handleModelChange}
                autoRoute={intentAutoRoute}
                onToggleAutoRoute={setIntentAutoRoute}
                isProcessing={isProcessing}
              />
            </div>
          </div>
        </div>
    </div>
  );
}
