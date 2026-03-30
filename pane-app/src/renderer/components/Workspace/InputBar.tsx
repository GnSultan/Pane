import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useMindStore } from "../../stores/mind";
import { useShallow } from "zustand/react/shallow";
import { TodoPanel } from "./TodoPanel";
import { SlashMenu } from "../shared";
import type { Todo } from "../../lib/punk-types";
import {
  PROVIDER_MODELS,
  THINKING_ENGINES,
  BUILDING_ENGINES,
  isThinkingModel,
} from "../../lib/models";

const EMPTY_TODOS: Todo[] = [];

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
  onSend: (message: string) => void;
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
  const openRouterModels = useWorkspaceStore((s) => s.openRouterModels);

  const filteredProviderModels = useMemo(() => {
    const providers = Object.fromEntries(
      Object.entries(PROVIDER_MODELS)
        .map(([provider, models]) => {
          // Special case for OpenRouter: use enriched dynamic models with real provider grouping
          if (provider === "openrouter") {
            if (openRouterModels.length > 0) {
              const dynamicModels = openRouterModels.map((m) => {
                const hardcoded = models.find((h) => h.value === m.id);
                return {
                  value: m.id,
                  label: hardcoded ? hardcoded.label : m.name,
                  // Pass through enriched metadata from the backend filter
                  realProvider: m.provider,   // "Anthropic", "Google", etc. — used for grouping
                  inputCost:    m.input_cost,
                  outputCost:   m.output_cost,
                  tier:         m.tier,
                };
              });
              return [provider, dynamicModels];
            }
          }

          // Filter out any model starting with "auto-" as those are CLI-only routing hints
          const filtered = models.filter((m) => !m.value.startsWith("auto-"));
          return [provider, filtered];
        })
        .filter(([_, models]) => models && models.length > 0),
    );
    return providers;
  }, [openRouterModels]);

  // Determine backend source for a model based on provider
  const getBackendSource = useCallback((providerKey: string, modelValue: string): string => {
    // Claude Code CLI models
    if (providerKey === "anthropic") {
      return "claude-code";
    }
    // Gemini CLI models
    if (providerKey === "gemini") {
      return "gemini-cli";
    }
    // OpenRouter models (contain "/") go to HTTP API
    if (modelValue.includes("/")) {
      return "http-api";
    }
    // All other models go to HTTP API
    return "http-api";
  }, []);

  const allModels = useMemo(() => {
    const models: Array<{
      value: string;
      label: string;
      provider: string;
      providerKey: string;
      backendSource: string;
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
          // Use realProvider for grouping when available (OpenRouter models expose the upstream provider)
          const displayProvider = m.realProvider || providerKey;
          const engineEntry =
            THINKING_ENGINES.find(
              (e) => e.provider === providerKey && e.model === m.value,
            ) ||
            BUILDING_ENGINES.find(
              (e) => e.provider === providerKey && e.model === m.value,
            );
          const isThinking = engineEntry
            ? engineEntry.thinking
            : isThinkingModel(m.value);
          models.push({
            value:      m.value,
            label:      m.label,
            provider:   displayProvider,
            providerKey: providerKey,
            backendSource: getBackendSource(providerKey, m.value),
            thinking:   isThinking,
            inputCost:  m.inputCost,
            outputCost: m.outputCost,
          });
        });
      }
    });
    return models;
  }, [filteredProviderModels, getBackendSource]);

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
        const backendSourceScore = fuzzyScore(
          m.backendSource === "claude-code" ? "claude code cli" 
            : m.backendSource === "gemini-cli" ? "gemini cli"
            : "http api",
          query
        );
        const maxScore = Math.max(labelScore, valueScore, providerScore, backendSourceScore);
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
                {current!.backendSource === "claude-code" && (
                  <span className="w-1 h-1 rounded-full bg-pane-status-added/60" title="Claude Code CLI" />
                )}
                {current!.backendSource === "gemini-cli" && (
                  <span className="w-1 h-1 rounded-full bg-pane-terminal/60" title="Gemini CLI" />
                )}
                {current!.backendSource === "http-api" && (
                  <span className="w-1 h-1 rounded-full bg-pane-text-secondary/40" title="HTTP API" />
                )}
              </span>
            ) : (
              <span className="text-pane-text-secondary/60">smart routing</span>
            )
          ) : (
            <span className="flex items-center gap-1">
              {currentDisplay.label.toLowerCase()}
              {current && current.backendSource === "claude-code" && (
                <span className="w-1 h-1 rounded-full bg-pane-status-added/60" title="Claude Code CLI" />
              )}
              {current && current.backendSource === "gemini-cli" && (
                <span className="w-1 h-1 rounded-full bg-pane-terminal/60" title="Gemini CLI" />
              )}
              {current && current.backendSource === "http-api" && (
                <span className="w-1 h-1 rounded-full bg-pane-text-secondary/40" title="HTTP API" />
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

            {/* Individual Models grouped by backend source */}
            <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
              {Object.entries(
                filteredModels.reduce((acc, model) => {
                  if (!acc[model.backendSource]) acc[model.backendSource] = [];
                  acc[model.backendSource]?.push(model);
                  return acc;
                }, {} as Record<string, typeof filteredModels>),
              ).map(([backendSource, models]) => (
                <div key={backendSource} className="flex flex-col mb-2">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-pane-text-secondary/40 font-mono flex items-center gap-1.5">
                    {backendSource === "claude-code" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-pane-status-added/60" />
                    )}
                    {backendSource === "gemini-cli" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-pane-terminal/60" />
                    )}
                    {backendSource === "http-api" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-pane-text-secondary/40" />
                    )}
                    {backendSource === "claude-code" ? "Claude Code CLI"
                      : backendSource === "gemini-cli" ? "Gemini CLI"
                      : "HTTP API"}
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
                          {model.backendSource === "claude-code" && (
                            <span className="w-1 h-1 rounded-full bg-pane-status-added/60" title="Claude Code CLI" />
                          )}
                          {model.backendSource === "gemini-cli" && (
                            <span className="w-1 h-1 rounded-full bg-pane-terminal/60" title="Gemini CLI" />
                          )}
                          {model.backendSource === "http-api" && (
                            <span className="w-1 h-1 rounded-full bg-pane-text-secondary/40" title="HTTP API" />
                          )}
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

  // Slash-menu state
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const slashStartRef = useRef<number>(-1); // cursor position of the triggering /
  const mindEntries = useMindStore((s) => s.entries);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretContainerRef = useRef<HTMLDivElement>(null);

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

  // Detect `/` trigger and track query for slash-menu
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const pos = e.target.selectionStart ?? next.length;
    setValue(next);

    if (slashOpen) {
      const slashIdx = slashStartRef.current - 1; // index of the triggering /
      // Close if the slash was deleted or cursor moved before it
      if (next[slashIdx] !== "/" || pos < slashStartRef.current) {
        setSlashOpen(false);
      } else {
        // Update query: everything between the / and current cursor
        setSlashQuery(next.slice(slashStartRef.current, pos));
      }
    } else {
      // Look for a fresh / trigger: must be at start or preceded by whitespace
      if (next[pos - 1] === "/") {
        const charBefore = next[pos - 2];
        if (!charBefore || charBefore === " " || charBefore === "\n") {
          slashStartRef.current = pos; // query starts right after the /
          setSlashQuery("");
          setSlashOpen(true);
        }
      }
    }
  }, [slashOpen]);

  const handleSlashSelect = useCallback((content: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = slashStartRef.current;
    const slashPos = start - 1; // position of the / itself
    const cursorPos = ta.selectionStart ?? value.length;
    // Replace from the / up to the current cursor with the entry content
    const before = value.slice(0, slashPos);
    const after = value.slice(cursorPos);
    const next = before + content + after;
    setValue(next);
    setSlashOpen(false);
    // Restore focus and move cursor to end of inserted content
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = before.length + content.length;
      ta.setSelectionRange(newPos, newPos);
    });
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // When slash menu is open, Enter/Tab/Escape/Arrows are handled by SlashMenu's window listener
      if (slashOpen && (e.key === "Enter" || e.key === "Tab" || e.key === "Escape" || e.key === "ArrowDown" || e.key === "ArrowUp")) {
        return; // Let SlashMenu's capture listener handle it
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed) {
          onSend(trimmed);
          setValue("");
        }
      }
      if (e.key === "Escape" && isProcessing) {
        e.preventDefault();
        onAbort();
      }
    },
    [value, isProcessing, slashOpen, projectId, onSend, onAbort],
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
        {slashOpen && (
          <SlashMenu
            entries={mindEntries}
            query={slashQuery}
            onSelect={handleSlashSelect}
            onDismiss={() => setSlashOpen(false)}
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
              placeholder={isProcessing ? "" : "let's build..."}
              className="w-full bg-transparent text-pane-text font-mono
                         resize-none outline-none placeholder:text-pane-text-secondary
                         leading-[1.75] px-5 pt-4 overflow-y-auto overflow-x-hidden"
              style={{
                fontSize: "var(--pane-font-size)",
                caretColor: "transparent",
                minHeight: "120px",
                maxHeight: "40vh",
                height: "120px",
                paddingBottom: "44px",
              }}
            />
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
                onSend(trimmed); setValue("");
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
