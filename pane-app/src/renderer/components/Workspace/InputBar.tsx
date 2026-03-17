import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { TodoPanel } from "./TodoPanel";
import type { Todo } from "../../lib/claude-types";
import {
  PROVIDER_MODELS,
  THINKING_ENGINES,
  BUILDING_ENGINES,
  keyFromRoute,
  DEFAULT_BACKEND_ROUTING,
  getContextLimit,
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
  onChange,
  autoRoute,
  onToggleAutoRoute,
  isProcessing,
}: {
  value: string;
  onChange: (v: string, thinking?: boolean) => void;
  autoRoute: boolean;
  onToggleAutoRoute: (v: boolean) => void;
  isProcessing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const punkBackend = useWorkspaceStore((s) => s.punkBackend);
  const httpApiKeys = useWorkspaceStore((s) => s.httpApiKeys);
  const openRouterModels = useWorkspaceStore((s) => s.openRouterModels);
  const routing = useWorkspaceStore(useShallow((s) => s.getEffectiveRouting()));

  const filteredProviderModels = useMemo(() => {
    const isGeminiBackend = punkBackend === "gemini-cli";
    const providers = Object.fromEntries(
      Object.entries(PROVIDER_MODELS)
        .map(([provider, models]) => {
          // If we are on Gemini CLI, keep only the Gemini provider and keep auto models.
          if (isGeminiBackend) {
            if (provider !== "gemini") return [provider, []];
            return [provider, models];
          }

          // If we are NOT on Gemini CLI (e.g. HTTP), only show providers with keys.
          if (!httpApiKeys[provider]) return [provider, []];

          // Special case for OpenRouter: merge hardcoded with dynamically fetched models
          if (provider === "openrouter") {
            if (openRouterModels.length > 0) {
              // Convert fetched models to the expected format, merging with hardcoded labels if they match
              const dynamicModels = openRouterModels.map((m) => {
                const hardcoded = models.find((h) => h.value === m.id);
                return {
                  value: m.id,
                  label: hardcoded ? hardcoded.label : m.name,
                };
              });
              return [provider, dynamicModels];
            }
          }

          // Filter out any model starting with "auto-" as those are CLI-only.
          const filtered = models.filter((m) => !m.value.startsWith("auto-"));
          return [provider, filtered];
        })
        .filter(([_, models]) => models && models.length > 0),
    );
    return providers;
  }, [punkBackend, httpApiKeys, openRouterModels]);

  const allModels = useMemo(() => {
    const models: Array<{
      value: string;
      label: string;
      provider: string;
      thinking?: boolean;
    }> = [];
    Object.entries(filteredProviderModels).forEach(([provider, list]) => {
      if (Array.isArray(list)) {
        list.forEach((m: { value: string; label: string }) => {
          // Find if this model exists in THINKING_ENGINES or BUILDING_ENGINES to get its thinking flag,
          // otherwise use the helper to guess.
          const engineEntry =
            THINKING_ENGINES.find(
              (e) => e.provider === provider && e.model === m.value,
            ) ||
            BUILDING_ENGINES.find(
              (e) => e.provider === provider && e.model === m.value,
            );
          const isThinking = engineEntry
            ? engineEntry.thinking
            : isThinkingModel(m.value);
          models.push({ ...m, provider, thinking: isThinking });
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
        const maxScore = Math.max(labelScore, valueScore, providerScore);
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

  const activeRouting = (routing ||
    DEFAULT_BACKEND_ROUTING[punkBackend] ||
    DEFAULT_BACKEND_ROUTING["http"])!;

  const activeThinking =
    THINKING_ENGINES.find(
      (o) => keyFromRoute(o) === keyFromRoute(activeRouting.plan),
    ) ??
    THINKING_ENGINES.find(
      (o) =>
        keyFromRoute(o) ===
        keyFromRoute(
          DEFAULT_BACKEND_ROUTING[punkBackend]?.plan ??
            DEFAULT_BACKEND_ROUTING["http"]?.plan,
        ),
    )!;
  const activeBuilding =
    BUILDING_ENGINES.find(
      (o) => keyFromRoute(o) === keyFromRoute(activeRouting.execute),
    ) ??
    BUILDING_ENGINES.find(
      (o) =>
        keyFromRoute(o) ===
        keyFromRoute(
          DEFAULT_BACKEND_ROUTING[punkBackend]?.execute ??
            DEFAULT_BACKEND_ROUTING["http"]?.execute,
        ),
    )!;

  const thinkingLabel = activeThinking.label.split(" — ")[0]!.toLowerCase();
  const buildingLabel = activeBuilding.label.split(" — ")[0]!.toLowerCase();
  const isRedundant = thinkingLabel === buildingLabel;

  const displayLabel = useMemo(() => {
    if (isRedundant) return thinkingLabel;
    if (activeThinking.provider === activeBuilding.provider) {
      // Common provider: "gemini 3.1 pro" + "gemini 3.1 flash" -> "gemini 3.1 pro + flash"
      const tParts = thinkingLabel.split(" ");
      const bParts = buildingLabel.split(" ");
      let common = 0;
      while (
        common < tParts.length &&
        common < bParts.length &&
        tParts[common] === bParts[common]
      ) {
        common++;
      }
      if (common > 0) {
        const prefix = tParts.slice(0, common).join(" ");
        const tSuffix = tParts.slice(common).join(" ");
        const bSuffix = bParts.slice(common).join(" ");
        return `${prefix} ${tSuffix} + ${bSuffix}`;
      }
    }
    return `${thinkingLabel} + ${buildingLabel}`;
  }, [
    isRedundant,
    thinkingLabel,
    buildingLabel,
    activeThinking.provider,
    activeBuilding.provider,
  ]);

  const showSpecificModel =
    autoRoute && isProcessing && current && !current.value.startsWith("auto-");
  const labelToShow = showSpecificModel
    ? current.label.toLowerCase()
    : displayLabel;

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-pane-text btn-press select-none group"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        <div
          className={`w-1.5 h-1.5 rounded-full transition-colors ${autoRoute ? "bg-pane-status-added" : "bg-pane-text"}`}
        />
        <span className="flex items-center gap-1.5 transition-colors group-hover:text-pane-text">
          {autoRoute ? (
            <span className="flex items-center gap-1.5">
              <span className="text-pane-text-secondary/60">auto</span>
              <span className="hidden sm:inline-block transition-all duration-300">
                {labelToShow}
              </span>
            </span>
          ) : (
            currentDisplay.label.toLowerCase()
          )}
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 bg-pane-bg border border-pane-border/40 rounded-xl shadow-2xl overflow-hidden z-50 animate-fadeSlideUp">
          <div className="p-1.5 flex flex-col gap-0.5">
            {/* Smart Routing Toggle */}
            <button
              onClick={() => {
                onToggleAutoRoute(!autoRoute);
                setOpen(false);
              }}
              className={`flex items-center justify-between w-full px-3 py-2 rounded-md text-left transition-colors ${
                autoRoute
                  ? "bg-pane-text/[0.08] text-pane-text"
                  : "text-pane-text-secondary hover:bg-pane-text/[0.04] hover:text-pane-text"
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
                  if (!acc[model.provider]) acc[model.provider] = [];
                  acc[model.provider]?.push(model);
                  return acc;
                }, {} as Record<string, typeof filteredModels>),
              ).map(([provider, models]) => (
                <div key={provider} className="flex flex-col mb-2">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-pane-text-secondary/40 font-mono">
                    {provider || "unknown"}
                  </div>
                  {models?.map((model) => (
                    <button
                      key={model.value}
                      onClick={() => {
                        onChange(model.value, model.thinking);
                        setOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg font-mono text-left transition-colors ${
                        !autoRoute && model.value === value
                          ? "bg-pane-text/10 text-pane-text"
                          : "text-pane-text-secondary hover:bg-pane-text/[0.04] hover:text-pane-text"
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="font-mono text-[12px]">
                          {model.label.toLowerCase()}
                        </span>
                        {model.thinking && (
                          <span className="text-[9px] text-pane-status-added/60 uppercase tracking-tighter">
                            thinking mode
                          </span>
                        )}
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretContainerRef = useRef<HTMLDivElement>(null);

  const todos = useProjectsStore(
    useShallow(
      (s) => s.projects.get(projectId)?.conversation.todos ?? EMPTY_TODOS,
    ),
  );
  const pendingPlanApproval = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.pendingPlanApproval ?? false,
  );
  const selectedModel = useWorkspaceStore((s) => s.selectedModel);
  const setSelectedModel = useWorkspaceStore((s) => s.setSelectedModel);
  const setHttpProvider = useWorkspaceStore((s) => s.setHttpProvider);
  const intentAutoRoute = useWorkspaceStore((s) => s.intentAutoRoute);
  const setIntentAutoRoute = useWorkspaceStore((s) => s.setIntentAutoRoute);
  // const intentRouting = useWorkspaceStore((s) => s.getEffectiveRouting());

  const contextPressure = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.contextPressure ?? "none",
  );
  const contextTokens = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.contextTokens ?? 0,
  );
  const contextPercent = useMemo(() => {
    if (contextTokens <= 0) return 0;
    const limit = getContextLimit(selectedModel);
    return Math.min(Math.round((contextTokens / limit) * 100), 99);
  }, [contextTokens, selectedModel]);

  const routedModel = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.routedModel ?? null,
  );

  const [planRejected, setPlanRejected] = useState(false);

  // Handle model change and sync provider
  const handleModelChange = useCallback(
    (modelValue: string, thinking: boolean = false, provider?: string) => {
      setSelectedModel(modelValue, thinking, provider);
      if (provider) setHttpProvider(provider);
    },
    [setSelectedModel, setHttpProvider],
  );

  // Handle graceful fadeout of processing indicator
  // ... (rest of the component remains similar, but using the new ModelPicker)

  // Handle graceful fadeout of processing indicator
  useEffect(() => {
    if (!isProcessing && !isFadingOut) {
      setIsFadingOut(true);
      const timer = setTimeout(() => setIsFadingOut(false), 1500);
      return () => clearTimeout(timer);
    } else if (isProcessing) {
      setIsFadingOut(false);
    }
  }, [isProcessing, isFadingOut]);

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
    el.style.height = Math.min(Math.max(el.scrollHeight, minH), maxH) + "px";
  }, []);

  useEffect(() => {
    applyTextareaHeight();
  }, [value, applyTextareaHeight]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) return;
        const trimmed = value.trim();
        if (trimmed) {
          onSend(trimmed);
          setValue("");
          setPlanRejected(false);
        }
      }
      if (e.key === "Escape" && isProcessing) {
        e.preventDefault();
        onAbort();
      }
    },
    [value, isProcessing, onSend, onAbort],
  );

  const handleAcceptPlan = useCallback(() => {
    useProjectsStore.getState().setPendingPlanApproval(projectId, false);
    onSend("good to go");
  }, [projectId, onSend]);

  const handleRejectPlan = useCallback(() => {
    useProjectsStore.getState().setPendingPlanApproval(projectId, false);
    setPlanRejected(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [projectId]);

  return (
    <div className="bg-transparent">
      {/* Processing indicator — only exists when active, no reserved space */}
      {(isProcessing || isFadingOut) &&
        !pendingPlanApproval &&
        !todoPanelOpen && (
          <div
            className={`flex items-center gap-3 px-1 pb-3 ${isFadingOut ? "animate-fadeOut" : "animate-fadeIn"}`}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-pane-text-secondary shrink-0"
            >
              <circle
                cx="12"
                cy="12"
                r="7"
                fill="none"
                className="animate-circle-pulse"
                style={{ strokeWidth: "var(--circle-stroke-width, 1.5)" }}
              />
            </svg>
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

      {/* Plan approval */}
      {pendingPlanApproval && (
        <div className="px-1 pb-3 animate-fadeSlideUp">
          <div className="flex items-center gap-3">
            <span
              className="text-pane-text font-mono"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              plan above — proceed?
            </span>
            <button
              onClick={handleAcceptPlan}
              className="px-3 py-1 rounded font-mono text-pane-status-added
                         hover:bg-pane-status-added/10 btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              good to go
            </button>
            <button
              onClick={handleRejectPlan}
              className="px-3 py-1 rounded font-mono text-pane-text-secondary
                         hover:text-pane-text hover:bg-pane-text/[0.06] btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              revise
            </button>
            <button
              onClick={onAbort}
              className="text-pane-text-secondary font-mono hover:text-pane-text ml-auto btn-press"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              esc
            </button>
          </div>
        </div>
      )}

      {todoPanelOpen && todos.length > 0 && (
        <TodoPanel
          projectId={projectId}
          onCollapse={() => setTodoPanelOpen(false)}
        />
      )}

      {/* The unified card — textarea body + toolbar strip */}
      {!pendingPlanApproval && (
        <div className="bg-pane-bg rounded-xl ring-1 ring-pane-border/40 relative shadow-[0_0_12px_rgba(74,71,66,0.15)]">
          {/* Writing area — relative container anchors the static caret overlay */}
          <div
            ref={caretContainerRef}
            className="relative overflow-hidden"
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                setTextareaFocused(true);
                updateCaret();
              }}
              onBlur={() => {
                setTextareaFocused(false);
                setCaretPos(null);
              }}
              placeholder={
                isProcessing
                  ? ""
                  : planRejected
                    ? "what should change..."
                    : "let's build..."
              }
              className="w-full bg-transparent text-pane-text font-mono
                         resize-none outline-none placeholder:text-pane-text-secondary
                         leading-[1.75] px-5 pt-4 pb-3 overflow-y-auto overflow-x-hidden"
              style={{
                fontSize: "var(--pane-font-size)",
                caretColor: "transparent",
                minHeight: "96px",
                maxHeight: "40vh",
                height: "96px",
              }}
            />
            {/* Static amber cursor — replaces the native blinking caret */}
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

          {/* Send button - top right corner of card */}
          {value.trim().length > 0 && !isProcessing && (
            <button
              onClick={() => {
                const trimmed = value.trim();
                if (trimmed) {
                  onSend(trimmed);
                  setValue("");
                  setPlanRejected(false);
                }
              }}
              className="absolute top-2 right-2 w-9 h-9 flex items-center justify-center rounded-lg text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] transition-all duration-150 btn-press ring-1 ring-pane-border/40"
              title="Send message (Enter)"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m5 9 7-7 7 7" />
                <path d="M12 16V2" />
                <circle cx="12" cy="21" r="1" />
              </svg>
            </button>
          )}

          {/* Toolbar strip */}
          <div
            className="h-9 flex items-center px-5 shrink-0 bg-transparent font-mono text-pane-text-secondary"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {/* Add path button */}
            <button
              onClick={() => {
                try {
                  // Trigger file/folder picker
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.multiple = true;
                  // Try to enable directory selection (Electron/Tauri supports this)
                  input.webkitdirectory = true;
                  input.onchange = (e) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files && files.length > 0) {
                      // When selecting a folder with webkitdirectory, files will contain
                      // all files from that folder. We just want to show the folder name.
                      
                      // Extract unique top-level folder names from webkitRelativePath
                      const folderNames = new Set<string>();
                      
                      Array.from(files).forEach(f => {
                        if (f.webkitRelativePath) {
                          // webkitRelativePath is "folderName/file.txt" or "folderName/subfolder/file.txt"
                          const relativePath = f.webkitRelativePath;
                          const parts = relativePath.split('/');
                          if (parts.length > 0 && parts[0]) {
                            folderNames.add(parts[0]);
                          }
                        }
                      });
                      
                      // If we have folder names, use them with proper styling
                      if (folderNames.size > 0) {
                        const pathsText = Array.from(folderNames).map(p => {
                          // Prepend ./ so the path matches SPECIAL_REGEX and gets styled with text-pane-error
                          return `\`./${p}\``;
                        }).join('\n');
                        setValue(prev => prev ? `${prev}\n${pathsText}` : pathsText);
                      } else {
                        // Fallback for individual file selection
                        const paths = Array.from(files).map(f => {
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          const path = (f as any).path || f.name;
                          return `\`${path}\``;
                        });
                        const pathsText = paths.join('\n');
                        setValue(prev => prev ? `${prev}\n${pathsText}` : pathsText);
                      }
                    }
                  };
                  input.onerror = () => {
                    // Fallback for browsers that don't support directory selection
                    input.webkitdirectory = false;
                    input.click();
                  };
                  input.click();
                } catch (err) {
                  console.error('Failed to open file picker:', err);
                }
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-pane-text-secondary/50 hover:text-pane-text-secondary hover:bg-pane-text/[0.04] transition-colors btn-press shrink-0"
              title="Add file or folder path"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>add path</span>
            </button>
            
            {contextPressure !== "none" && (
              <span
                className={`ml-4 mr-auto transition-colors ${contextPressure === "high" ? "text-pane-error" : "text-pane-text-secondary/60"}`}
              >
                context {contextPercent}%
              </span>
            )}
            <div className="flex-1" />
            <ModelPicker
              value={isProcessing && routedModel ? routedModel : selectedModel}
              onChange={handleModelChange}
              autoRoute={intentAutoRoute}
              onToggleAutoRoute={setIntentAutoRoute}
              isProcessing={isProcessing}
            />
          </div>
        </div>
      )}
    </div>
  );
}
