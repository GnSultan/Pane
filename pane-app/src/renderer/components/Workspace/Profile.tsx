import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import { useProjectsStore } from "../../stores/projects";
import { useShallow } from "zustand/react/shallow";
import { motion, AnimatePresence } from "framer-motion";
import {
  engineKey,
  DEFAULT_BACKEND_ROUTING,
  type EngineOption,
  type PowerCombo,
  isThinkingModel,
  getContextWindowForModel,
} from "../../lib/models";
import {
  brainGetProfile,
  brainUpdateDNA,
  cloudLogin,
  cloudLogout,
  cloudGetUser,
  cloudGetStatus,
  cloudTriggerBackup,
  cloudRestore,
  paneClaudeLogin,
  paneClaudeLogout,
  paneClaudeAuthState,
  loadSettings,
  saveSettings,
  type CloudUser,
  type CloudStatus,
  type ClaudeAuthState,
  type McpServerConfig,
  type UserSettings,
} from "../../lib/tauri-commands";
import {
  MCP_CATALOG,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type CatalogServer,
} from "../../lib/mcp-catalog";
import {
  ACTION_DEFINITIONS,
  DEFAULT_BINDINGS,
  resolveBindings,
  formatBinding,
  eventToBinding,
  isModifierOnly,
  isReserved,
  findConflict,
  bindingsEqual,
  getActionLabel,
  type ActionId,
  type KeyBinding,
} from "../../lib/keybindings";

const isMac = navigator.platform.includes("Mac");
const mod = isMac ? "\u2318" : "Ctrl";

// ─── Shared UI ───────────────────────────────────────────────────────────────


function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex flex-col gap-0.5">
        <span
          className="text-pane-text font-mono"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {label}
        </span>
        {hint && (
          <span
            className="text-pane-text-secondary/50 font-mono"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {hint}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function FontSizeControl({
  value,
  onIncrease,
  onDecrease,
  onReset,
  unit = "px",
}: {
  value: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onReset: () => void;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onDecrease}
        className="w-7 h-7 flex items-center justify-center rounded text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] font-mono"
        style={{ fontSize: "var(--pane-font-size)" }}
      >
        -
      </button>
      <button
        onClick={onReset}
        className="min-w-10 h-7 flex items-center justify-center rounded px-1 text-pane-text font-mono hover:bg-pane-text/[0.04]"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
        title="Reset to default"
      >
        {value}
        {unit}
      </button>
      <button
        onClick={onIncrease}
        className="w-7 h-7 flex items-center justify-center rounded text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.06] font-mono"
        style={{ fontSize: "var(--pane-font-size)" }}
      >
        +
      </button>
    </div>
  );
}

// ─── Keybindings ─────────────────────────────────────────────────────────────

function KeybindingRow({
  actionId,
  binding,
  isDefault,
  isRecording,
  onStartRecording,
  onReset,
  message,
}: {
  actionId: ActionId;
  binding: KeyBinding;
  isDefault: boolean;
  isRecording: boolean;
  onStartRecording: () => void;
  onReset: () => void;
  message: string | null;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span
        className="text-pane-text-secondary font-mono"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        {getActionLabel(actionId)}
      </span>
      <div className="flex items-center gap-1.5">
        {message && (
          <span
            className="text-pane-error font-mono"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {message}
          </span>
        )}
        <button
          onClick={onStartRecording}
          className={`px-2.5 py-1 rounded font-mono ${isRecording ? "bg-pane-text/[0.12] text-pane-text ring-1 ring-pane-text/30" : "bg-pane-text/[0.06] text-pane-text-secondary hover:text-pane-text"}`}
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {isRecording ? "press keys..." : formatBinding(binding)}
        </button>
        {!isDefault && !isRecording && (
          <button
            onClick={onReset}
            className="text-pane-text-secondary/40 hover:text-pane-text-secondary"
            title="Reset to default"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M2.5 2.5L6 6m0 0l3.5 3.5M6 6l3.5-3.5M6 6L2.5 9.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function KeybindingsSection() {
  const keybindingsOverrides = useWorkspaceStore((s) => s.keybindings);
  const resolved = resolveBindings(keybindingsOverrides);
  const hasOverrides =
    keybindingsOverrides !== null &&
    Object.keys(keybindingsOverrides).length > 0;

  const [recordingAction, setRecordingAction] = useState<ActionId | null>(null);
  const [message, setMessage] = useState<{
    action: ActionId;
    text: string;
  } | null>(null);
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessage = useCallback((action: ActionId, text: string) => {
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    setMessage({ action, text });
    messageTimerRef.current = setTimeout(() => setMessage(null), 2000);
  }, []);

  useEffect(() => {
    if (recordingAction === null) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isModifierOnly(e)) return;
      if (e.key === "Escape") {
        setRecordingAction(null);
        return;
      }
      const binding = eventToBinding(e);
      if (isReserved(binding)) {
        showMessage(recordingAction, "reserved");
        return;
      }
      const conflict = findConflict(binding, resolved, recordingAction);
      if (conflict) {
        useWorkspaceStore.getState().resetKeybinding(conflict);
        showMessage(recordingAction, `unbound ${getActionLabel(conflict)}`);
      }
      const defaultBinding = DEFAULT_BINDINGS[recordingAction];
      if (bindingsEqual(binding, defaultBinding)) {
        useWorkspaceStore.getState().resetKeybinding(recordingAction);
      } else {
        useWorkspaceStore.getState().setKeybinding(recordingAction, binding);
      }
      setRecordingAction(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingAction, resolved, showMessage]);

  useEffect(() => {
    if (recordingAction === null) return;
    const handler = () => setRecordingAction(null);
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [recordingAction]);

  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg overflow-hidden transition-colors">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono hover:bg-pane-bg/50 transition-colors"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        <span className="flex items-center gap-2">
          <motion.svg
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-pane-text-secondary/40 group-hover:text-pane-text-secondary"
          >
            <path d="M3 4.5L6 7.5L9 4.5" />
          </motion.svg>
          <span>keyboard shortcuts</span>
        </span>
        <div className="flex items-center gap-2">
          {hasOverrides && (
            <span
              className="text-pane-text-secondary/60"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              modified
            </span>
          )}
          {hasOverrides && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                useWorkspaceStore.getState().resetAllKeybindings();
              }}
              className="text-pane-text-secondary hover:text-pane-text font-mono"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              reset all
            </button>
          )}
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="p-4 bg-pane-bg/30 border-t border-pane-border/30">
              {ACTION_DEFINITIONS.map((def) => {
                const isDefault =
                  !keybindingsOverrides || !(def.id in keybindingsOverrides);
                return (
                  <KeybindingRow
                    key={def.id}
                    actionId={def.id}
                    binding={resolved[def.id]}
                    isDefault={isDefault}
                    isRecording={recordingAction === def.id}
                    onStartRecording={() => {
                      setMessage(null);
                      setRecordingAction(def.id);
                    }}
                    onReset={() =>
                      useWorkspaceStore.getState().resetKeybinding(def.id)
                    }
                    message={message?.action === def.id ? message.text : null}
                  />
                );
              })}
              <div className="mt-3 pt-2 border-t border-pane-border/30">
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  {(
                    [
                      [`${mod}1-9`, "switch project"],
                      ["Enter", "send message"],
                      ["\u21E7Enter", "newline"],
                      ["Esc", "cancel / close"],
                    ] as const
                  ).map(([key, action]) => (
                    <div key={key} className="contents">
                      <span
                        className="text-pane-text-secondary font-mono text-right"
                        style={{ fontSize: "var(--pane-font-size-xs)" }}
                      >
                        {key}
                      </span>
                      <span
                        className="text-pane-text-secondary font-mono"
                        style={{ fontSize: "var(--pane-font-size-xs)" }}
                      >
                        {action}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
  }



// ─── AI Engines Section ───────────────────────────────────────────────────────

function EngineSelect({
  value,
  onChange,
  allModels = {},
  sdkModels = null,
  httpApiKeys = {},
  disabledProviders = [],
  curatedModels = [],
}: {
  value: string;
  onChange: (opt: EngineOption) => void;
  allModels?: Record<string, Array<{ id: string; name: string; context_length: number; input_cost?: number | null; output_cost?: number | null }>>;
  sdkModels?: import("../../lib/punk-types").SdkModel[] | null;
  httpApiKeys?: Record<string, string>;
  disabledProviders?: string[];
  curatedModels?: string[];
}) {
  // Provider display labels
  const providerLabel = useCallback((provider: string): string => {
    const labels: Record<string, string> = {
      anthropic: "Claude",
      "anthropic-api": "Anthropic API",
      gemini: "Gemini",
      "gemini-api": "Gemini API",
      deepseek: "DeepSeek",
      openrouter: "OpenRouter",
      kimi: "Kimi",
      stepfun: "StepFun",
      xiaomi: "Xiaomi MiMo",
      "z-ai": "Z.ai",
    };
    return labels[provider] || provider;
  }, []);

  const groupedOptions = useMemo(() => {
    const groups: Record<string, EngineOption[]> = {};
    const hasCurated = curatedModels.length > 0;

    const isDisabled = (p: string) => disabledProviders.includes(p);

    // Track native provider model IDs so OpenRouter can deduplicate
    const nativeModelIds = new Set<string>();

    // Helper: look up pricing from allModels for a provider+id
    const pricingFor = (provider: string, id: string) => {
      const pm = allModels[provider]?.find((m) => m.id === id);
      return { inputCost: pm?.input_cost ?? null, outputCost: pm?.output_cost ?? null };
    };

    // 1. Build anthropic group from SDK models (Claude Code backend) when available
    if (sdkModels && sdkModels.length > 0 && !isDisabled("anthropic")) {
      groups["anthropic"] = sdkModels.map((m) => {
        nativeModelIds.add(m.value);
        const pricing = pricingFor("anthropic", m.value);
        return {
          label: m.displayName || m.value,
          provider: "anthropic",
          model: m.value,
          thinking: false,
          requiresKey: "anthropic",
          contextWindow: getContextWindowForModel("anthropic", m.value),
          inputCost: pricing.inputCost,
          outputCost: pricing.outputCost,
        };
      });
    }

    // 2. Build groups from dynamically fetched allModels (non-OpenRouter first)
    for (const [provider, models] of Object.entries(allModels)) {
      if (!models || models.length === 0) continue;
      if (provider === "openrouter") continue;
      if (groups[provider]) continue;
      if (isDisabled(provider)) continue;

      // Base provider for key lookup: "anthropic-api" → "anthropic"
      const baseProvider = provider.replace(/-api$/, "");
      // CLI backends removed — Anthropic and Gemini are always available via API backend
      const isUsable =
        baseProvider === "anthropic" || baseProvider === "gemini" ||
        !!httpApiKeys?.[baseProvider];
      if (!isUsable) continue;

      groups[provider] = models.map((m) => {
        nativeModelIds.add(m.id);
        return {
          label: m.name || m.id,
          provider,
          model: m.id,
          thinking: isThinkingModel(m.id),
          requiresKey: provider,
          contextWindow: m.context_length || getContextWindowForModel(provider, m.id),
          inputCost: m.input_cost ?? null,
          outputCost: m.output_cost ?? null,
        };
      });
    }

    // 3. OpenRouter — only show models NOT already available from native providers
    const orModels = allModels["openrouter"];
    if (orModels && orModels.length > 0 && !!httpApiKeys?.["openrouter"] && !isDisabled("openrouter")) {
      const nativeProviderPrefixes = new Set<string>();
      if (groups["anthropic"] || groups["anthropic-api"]) nativeProviderPrefixes.add("anthropic/");
      if (groups["deepseek"]) nativeProviderPrefixes.add("deepseek/");
      if (groups["xiaomi"]) nativeProviderPrefixes.add("xiaomi/");
      if (groups["gemini"] || groups["gemini-api"]) { nativeProviderPrefixes.add("google/"); nativeProviderPrefixes.add("gemini/"); }

      const filtered = orModels.filter((m) => {
        for (const prefix of nativeProviderPrefixes) {
          if (m.id.startsWith(prefix)) return false;
        }
        return true;
      });

      if (filtered.length > 0) {
        groups["openrouter"] = filtered.map((m) => ({
          label: m.name || m.id,
          provider: "openrouter",
          model: m.id,
          thinking: isThinkingModel(m.id),
          requiresKey: "openrouter",
          contextWindow: m.context_length || getContextWindowForModel("openrouter", m.id),
          inputCost: m.input_cost ?? null,
          outputCost: m.output_cost ?? null,
        }));
      }
    }

    // Filter by curated models when set
    if (hasCurated) {
      const valueParts = value.split("::");
      const currentModel = valueParts[1]; // already-selected model is always visible
      for (const providerKey of Object.keys(groups)) {
        const opts = groups[providerKey];
        if (!opts) continue;
        const filtered = opts.filter(
          (opt) => curatedModels.includes(opt.model) || opt.model === currentModel
        );
        if (filtered.length === 0) {
          delete groups[providerKey];
        } else {
          groups[providerKey] = filtered;
        }
      }
    }

    return groups;
  }, [allModels, sdkModels, httpApiKeys, disabledProviders, curatedModels, value]);

  const [isOpen, setIsOpen] = useState(false);

  // Find currently selected option
  const currentOption = useMemo(() => {
    const parts = value.split("::");
    const provider = parts[0];
    const model = parts[1];
    if (provider && model && groupedOptions[provider]) {
      return groupedOptions[provider].find((o) => o.model === model) ?? null;
    }
    return null;
  }, [value, groupedOptions]);

  const handleSelect = (opt: EngineOption) => {
    onChange(opt);
    setIsOpen(false);
  };

  return (
    <div
      className={`rounded-md border transition-all duration-200 w-96 ${
        isOpen
          ? 'border-[var(--pane-border-soft)] bg-pane-bg/60'
          : 'border-transparent hover:border-[var(--pane-border-soft)]'
      }`}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 text-pane-text-secondary font-mono hover:text-pane-text w-full text-left h-10 leading-none px-4"
        style={{ fontSize: "var(--pane-font-size-sm)" }}
      >
        {currentOption ? (
          <span className="flex-1 truncate flex items-center gap-1.5">
            <span style={{ color: "var(--pane-accent)" }}>{providerLabel(currentOption.provider)}</span>
            <span>{currentOption.label}</span>
          </span>
        ) : (
          <span className="flex-1 truncate">select...</span>
        )}
      </button>

      {isOpen && (
        <div className="border-t border-[var(--pane-border-soft)] px-4 py-3 max-h-[400px] overflow-y-auto">
          {Object.entries(groupedOptions).map(([provider, opts]) => (
            <div key={provider}>
              <div
                className="font-mono text-pane-text-secondary/30 tracking-wider uppercase mb-1"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                {providerLabel(provider)}
              </div>
              {opts.map((opt: EngineOption) => {
                const isSelected = engineKey(opt) === value;
                const pricing = opt.inputCost != null && opt.outputCost != null
                  ? ` · ${opt.inputCost}/${opt.outputCost}/M`
                  : "";
                return (
                  <button
                    key={engineKey(opt)}
                    onClick={() => handleSelect(opt)}
                    className={`w-full text-left px-4 py-1.5 font-mono transition-colors flex items-center gap-2 rounded-md ${
                      isSelected
                        ? "bg-pane-text/[0.08] text-pane-status-added"
                        : "text-pane-text hover:bg-pane-text/[0.03]"
                    }`}
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    <span className="truncate flex-1">{opt.label}</span>
                    {pricing && (
                      <span className="shrink-0 text-pane-text-secondary/30 whitespace-nowrap">
                        {pricing}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PaneAutoSection({
  httpApiKeys,
}: {
  httpApiKeys: Record<string, string>;
}) {
  const combo = useWorkspaceStore(useShallow((s) => s.getEffectiveCombo()));
  const allModels = useWorkspaceStore((s) => s.allModels);
  const sdkModels = useWorkspaceStore((s) => s.sdkModels);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);
  const curatedModels = useWorkspaceStore((s) => s.curatedModels);
  const refreshAllModels = useWorkspaceStore((s) => s.refreshAllModels);

  // All providers use API keys (CLI backends have been removed).
  // A provider is usable if it has an API key set OR if it's anthropic/gemini
  // (which the API backend handles with its own key management).
  const isProviderUsable = (provider: string) => {
    const base = provider.replace(/-api$/, "");
    return base === "anthropic" || base === "gemini" || !!httpApiKeys?.[base];
  };

  // Build a flat list of all usable engines from dynamic data for auto-heal
  const usableEngines = useMemo(() => {
    const engines: EngineOption[] = [];
    for (const [provider, models] of Object.entries(allModels)) {
      if (!models || models.length === 0) continue;
      if (!isProviderUsable(provider)) continue;
      if (disabledProviders.includes(provider)) continue;
      models.forEach((m) => engines.push({
        label: m.name || m.id,
        provider,
        model: m.id,
        thinking: isThinkingModel(m.id),
        requiresKey: provider,
        contextWindow: m.context_length,
      }));
    }
    return engines;
  }, [allModels, httpApiKeys, disabledProviders]);

  const autoRoute = useWorkspaceStore((s) => s.autoEscalate);
  const setPowerCombo = useWorkspaceStore((s) => s.setPowerCombo);
  const setAutoEscalate = useWorkspaceStore((s) => s.setAutoEscalate);

  // Sync combo changes to active project for per-project override
  const syncComboToProject = useCallback((combo: PowerCombo) => {
    const ps = useProjectsStore.getState();
    const activeProjectId = ps.activeProjectId;
    if (activeProjectId) {
      ps.setProjectPowerCombo(activeProjectId, combo);
    }
  }, []);

  const syncAutoRouteToProject = useCallback((auto: boolean) => {
    const ps = useProjectsStore.getState();
    const activeProjectId = ps.activeProjectId;
    if (activeProjectId) {
      ps.setProjectAutoEscalate(activeProjectId, auto);
    }
  }, []);

  // Auto-heal: when availability changes, reset any combo slot pointing to an unusable provider.
  useEffect(() => {
    const firstUsable = usableEngines[0];
    if (!firstUsable) return;

    const current = combo;
    const updates: Partial<PowerCombo> = {};

    if (current?.thinking && !isProviderUsable(current.thinking.provider)) {
      updates.thinking = { provider: firstUsable.provider, model: firstUsable.model, thinking: firstUsable.thinking };
    }
    if (current?.execution && !isProviderUsable(current.execution.provider)) {
      updates.execution = { provider: firstUsable.provider, model: firstUsable.model, thinking: firstUsable.thinking };
    }

    if (Object.keys(updates).length > 0) {
      const healed = { ...current, ...updates } as PowerCombo;
      setPowerCombo(healed);
      syncComboToProject(healed);
    }
  }, [httpApiKeys, usableEngines, syncComboToProject]);

  const handleThinkingChange = (opt: EngineOption) => {
    const isReasoningProvider =
      opt.provider === "openrouter" || opt.provider === "kimi" ||
      opt.provider === "xiaomi" || opt.provider === "deepseek" ||
      opt.provider === "z-ai";
    const newCombo: PowerCombo = {
      thinking: { provider: opt.provider, model: opt.model, thinking: opt.thinking || isReasoningProvider },
      execution: combo?.execution || DEFAULT_BACKEND_ROUTING["api"]!.execution,
    };
    setPowerCombo(newCombo);
    syncComboToProject(newCombo);
  };

  const handleBuildingChange = (opt: EngineOption) => {
    const newCombo: PowerCombo = {
      thinking:  combo?.thinking  || DEFAULT_BACKEND_ROUTING["api"]!.thinking,
      execution: { provider: opt.provider, model: opt.model, thinking: opt.thinking },
    };
    setPowerCombo(newCombo);
    syncComboToProject(newCombo);
  };

  const handleAutoRouteToggle = () => {
    const next = !autoRoute;
    setAutoEscalate(next);
    syncAutoRouteToProject(next);
  };

  const resolveEngine = (
    current: { provider: string; model: string; thinking: boolean } | undefined,
  ): EngineOption => {
    const target = current || DEFAULT_BACKEND_ROUTING["api"]!.thinking;
    if (!target) return usableEngines[0] || { label: "none", provider: "", model: "", thinking: false, requiresKey: "" };

    // Try usableEngines (already built from allModels + sdkModels)
    const found = usableEngines.find(
      (o) => o.provider === target.provider && o.model === target.model,
    );
    if (found) return found;

    // Try allModels directly (provider may be usable but model just not in usableEngines list)
    const providerModels = allModels[target.provider];
    if (providerModels) {
      const m = providerModels.find((m) => m.id === target.model);
      if (m) {
        return {
          label: m.name || m.id,
          provider: target.provider,
          model: m.id,
          thinking: target.thinking || false,
          requiresKey: target.provider,
          contextWindow: m.context_length,
          inputCost: m.input_cost ?? null,
          outputCost: m.output_cost ?? null,
        };
      }
    }

    // Model not found in any fetched data — show it anyway with its raw ID
    return {
      label: target.model,
      provider: target.provider,
      model: target.model,
      thinking: target.thinking || false,
      requiresKey: target.provider,
    };
  };

  const thinkingEngine = resolveEngine(combo?.thinking);
  const buildingEngine = resolveEngine(combo?.execution);

  // All providers use API keys — CLI backends have been removed.
  // Anthropic and Gemini are always available via the API backend.
  const missingThinkingKey = !isProviderUsable(thinkingEngine.provider);
  const missingBuildingKey = !isProviderUsable(buildingEngine.provider);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-pane-text-secondary/40 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
          engine routing
        </span>
        <button
          onClick={() => refreshAllModels()}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-pane-border/20 hover:bg-pane-text/[0.03] text-pane-text-secondary hover:text-pane-text transition-all duration-200"
          style={{ fontSize: "10px" }}
        >
          <div className="w-1 h-1 rounded-full bg-pane-status-added animate-pulse" />
          refresh
        </button>
      </div>
        <SettingRow
          label="smart routing"
          hint="Pane picks the right engine for each message"
        >
          <button
            onClick={handleAutoRouteToggle}
            className={`flex items-center gap-1.5 font-mono transition-colors ${
              autoRoute
                ? "text-pane-terminal"
                : "text-pane-text-secondary/50 hover:text-pane-text-secondary"
            }`}
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            <div
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                autoRoute ? "bg-pane-terminal" : "bg-pane-text-secondary/30"
              }`}
            />
            {autoRoute ? "on" : "off"}
          </button>
        </SettingRow>

        {autoRoute && (
          <>
            <div className="py-3 flex flex-col gap-2">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-0.5">
                  <span
                    className="text-pane-text font-mono"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    when thinking
                  </span>
                  <span
                    className="text-pane-text-secondary/50 font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    planning, brainstorming, verification
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <EngineSelect
                    allModels={allModels}
                    sdkModels={sdkModels}
                    httpApiKeys={httpApiKeys}
                    disabledProviders={disabledProviders}
                    curatedModels={curatedModels}
                    value={engineKey(thinkingEngine)}
                    onChange={handleThinkingChange}
                  />
                  {(thinkingEngine.provider === "openrouter" ||
                    thinkingEngine.provider === "kimi") && (
                    <div className="flex items-center gap-1.5 ml-1">
                      <input
                        type="checkbox"
                        checked={thinkingEngine.thinking}
                        onChange={(e) => {
                          handleThinkingChange({
                            ...thinkingEngine,
                            thinking: e.target.checked,
                          });
                        }}
                        className="w-3.5 h-3.5 rounded border-pane-border/40 bg-pane-surface text-pane-accent focus:ring-0 outline-none"
                      />
                      <span
                        className="text-pane-text-secondary font-mono"
                        style={{ fontSize: "var(--pane-font-size-xs)" }}
                      >
                        R1
                      </span>
                    </div>
                  )}
                </div>
              </div>
              {missingThinkingKey && (
                <span
                  className="text-pane-error font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  ⚠ missing API key for {thinkingEngine.requiresKey} — add key below
                </span>
              )}
            </div>

            <div className="py-3 flex flex-col gap-2">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-0.5">
                  <span
                    className="text-pane-text font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    when building
                  </span>
                  <span
                    className="text-pane-text-secondary/50 font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    writing code, making changes
                  </span>
                </div>
                <EngineSelect
                  allModels={allModels}
                  sdkModels={sdkModels}
                  httpApiKeys={httpApiKeys}
                  disabledProviders={disabledProviders}
                  curatedModels={curatedModels}
                  value={engineKey(buildingEngine)}
                  onChange={handleBuildingChange}
                />
              </div>
              {missingBuildingKey && (
                <span
                  className="text-pane-error font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  ⚠ missing API key for {buildingEngine.requiresKey} — add key below
                </span>
              )}
            </div>


            <div className="py-2">
              <span
                className="text-pane-text-secondary/40 font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                type /plan, /exec or /explain to override per message
              </span>
            </div>
          </>
        )}
      </div>
  );
}

// ─── API Keys Section ─────────────────────────────────────────────────────────

// API key provider configuration
interface ApiKeyProvider {
  key: string;
  label: string;
  placeholder: string;
  docsUrl: string;
  showBaseUrl?: boolean;
  defaultBaseUrl?: string;
}

function ClaudeSignInCard() {
  const [auth, setAuth] = useState<ClaudeAuthState>({ authenticated: false, account: null });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    paneClaudeAuthState().then(setAuth).catch(() => {});
  }, []);

  useEffect(() => {
    const cleanup = window.electronAPI.on("pane-claude-signin", (raw: unknown) => {
      const data = raw as { type?: string; output?: string[] } | undefined;
      if (data?.type === "status" && data.output?.length) {
        setStatus(data.output[data.output.length - 1] ?? null);
      }
    });
    return () => cleanup?.();
  }, []);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const result = await paneClaudeLogin();
      if (result.success) {
        setAuth({ authenticated: true, account: result.account ?? null });
        setStatus(null);
      } else {
        setError(result.error || "sign in failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "sign in failed");
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await paneClaudeLogout().catch(() => {});
    setAuth({ authenticated: false, account: null });
    setStatus(null);
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2 pb-3 border-b border-pane-border/20 mb-3">
      <span
        className="text-pane-text-secondary/30 font-mono tracking-wider px-0.5"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        claude.ai subscription
      </span>

      {auth.authenticated ? (
        <div className="flex items-center justify-between px-1">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-pane-text font-mono text-xs truncate">
              {auth.account?.email ?? "signed in"}
            </span>
            {auth.account?.billingType && (
              <span className="text-pane-text-secondary/40 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                {auth.account.billingType}
              </span>
            )}
          </div>
          <button
            onClick={handleSignOut}
            className="text-pane-text-secondary/50 hover:text-pane-text font-mono transition-colors shrink-0 ml-3"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            sign out
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 px-1">
          <button
            onClick={handleSignIn}
            disabled={loading}
            className="text-left text-pane-text font-mono hover:text-pane-accent transition-colors disabled:opacity-40"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {loading ? (status ?? "signing in…") : "sign in with claude.ai"}
          </button>
          {error && (
            <span className="text-red-400/70 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Z.ai Coding Plan Tier Selector ──────────────────────────────────────────
// Lets the user pick their Z.ai Coding Plan (Lite/Pro/Max) so Pane can compute
// quota utilization. Stored in settings.json as zai_plan_tier.
const ZAI_TIERS = [
  { value: "lite", label: "Lite", fiveHour: "2k", weekly: "10k" },
  { value: "pro", label: "Pro", fiveHour: "12k", weekly: "60k" },
  { value: "max", label: "Max", fiveHour: "28k", weekly: "140k" },
] as const;

function ZaiPlanTierSelector() {
  const [tier, setTier] = useState<string>("");

  useEffect(() => {
    window.electronAPI?.invoke("read-settings")
      .then((s: unknown) => {
        const settings = (s && typeof s === "object" ? s : null) as Record<string, unknown> | null;
        setTier((settings?.zai_plan_tier as string) || "");
      })
      .catch(() => {});
  }, []);

  const handleChange = (newTier: string) => {
    const next = newTier === tier ? "" : newTier;
    setTier(next);
    window.electronAPI?.invoke("write-settings", { zai_plan_tier: next }).catch(() => {});
  };

  return (
    <div className="flex items-center gap-2 pl-4 border-l border-pane-border/20">
      <span
        className="text-pane-text-secondary/40 font-mono whitespace-nowrap"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        plan
      </span>
      <div className="flex items-center gap-1">
        {ZAI_TIERS.map((t) => (
          <button
            key={t.value}
            onClick={() => handleChange(t.value)}
            className={`px-2 py-0.5 rounded-md font-mono transition-colors ${
              tier === t.value
                ? "text-pane-text bg-pane-text/10 ring-1 ring-pane-border/40"
                : "text-pane-text-secondary/40 hover:text-pane-text-secondary/70"
            }`}
            style={{ fontSize: "var(--pane-font-size-xs)" }}
            title={`5h: ${t.fiveHour} credits · weekly: ${t.weekly} credits`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!tier && (
        <span
          className="text-pane-text-secondary/25 font-mono italic"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          select for quota tracking
        </span>
      )}
    </div>
  );
}

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  { key: "gemini", label: "Google Gemini", placeholder: "AI...", docsUrl: "https://aistudio.google.com/app/apikey", showBaseUrl: true, defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  { key: "deepseek", label: "DeepSeek", placeholder: "sk-...", docsUrl: "https://platform.deepseek.com/api_keys", showBaseUrl: true, defaultBaseUrl: "https://api.deepseek.com/v1/chat/completions" },
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-...", docsUrl: "https://console.anthropic.com/settings/keys", showBaseUrl: true, defaultBaseUrl: "https://api.anthropic.com/v1/messages" },
  { key: "openrouter", label: "OpenRouter", placeholder: "sk-or-...", docsUrl: "https://openrouter.ai/keys", showBaseUrl: true, defaultBaseUrl: "https://openrouter.ai/api/v1/chat/completions" },
  { key: "xiaomi", label: "Xiaomi MiMo", placeholder: "sk-...", docsUrl: "https://platform.xiaomimimo.com/", showBaseUrl: true, defaultBaseUrl: "https://api.xiaomimimo.com/v1" },
  { key: "kimi", label: "Kimi (Moonshot)", placeholder: "sk-...", docsUrl: "https://platform.moonshot.cn/", showBaseUrl: true, defaultBaseUrl: "https://api.moonshot.cn/v1/chat/completions" },
  { key: "z-ai", label: "Z.ai (GLM)", placeholder: "sk-...", docsUrl: "https://z.ai/manage-apikey/apikey-list", showBaseUrl: true, defaultBaseUrl: "https://api.z.ai/api/paas/v4/chat/completions" },
  { key: "tavily", label: "Tavily Search", placeholder: "tvly-...", docsUrl: "https://tavily.com/#api" },
  { key: "openai", label: "OpenAI (Voice)", placeholder: "sk-...", docsUrl: "https://platform.openai.com/api-keys" },
  { key: "jina", label: "Jina AI", placeholder: "jina_...", docsUrl: "https://jina.ai/embeddings/" },
];

function ApiKeysSection({
  httpApiKeys,
  onKeyChange,
  httpBaseUrls = {},
  onBaseUrlChange,
}: {
  httpApiKeys: Record<string, string>;
  onKeyChange: (provider: string, key: string) => void;
  httpBaseUrls?: Record<string, string>;
  onBaseUrlChange?: (provider: string, url: string) => void;
}) {
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [expandedActive, setExpandedActive] = useState<string | null>(null);
  const [expandedAvailable, setExpandedAvailable] = useState<string | null>(null);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);
  const toggleProvider = useWorkspaceStore((s) => s.toggleProvider);
  const inputRef = useRef<HTMLInputElement>(null);

  const toggleKeyFor = (key: string) =>
    (key === "anthropic" || key === "gemini") ? `${key}-api` : key;

  const ProviderToggle = ({ toggleKey, label }: { toggleKey: string; label: string }) => {
    const off = disabledProviders.includes(toggleKey);
    return (
      <div
        role="switch"
        aria-checked={!off}
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          toggleProvider(toggleKey);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            toggleProvider(toggleKey);
          }
        }}
        className={`w-6 h-3.5 rounded-full relative transition-colors shrink-0 cursor-pointer ${off ? "bg-pane-text-secondary/20" : "bg-pane-status-added/60"}`}
        title={off ? `enable ${label}` : `disable ${label}`}
      >
        <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${off ? "left-0.5" : "left-[11px]"}`} />
      </div>
    );
  };

  const activeProviders = API_KEY_PROVIDERS.filter((p) => !!httpApiKeys[p.key]);
  const availableProviders = API_KEY_PROVIDERS.filter((p) => !httpApiKeys[p.key]);

  return (
    <div className="flex flex-col gap-4">
      {/* Active providers */}
      {activeProviders.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span
            className="text-pane-text-secondary/30 font-mono tracking-wider px-0.5"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            active
          </span>
          {activeProviders.map((p) => {
            const { key, label, placeholder, docsUrl, showBaseUrl, defaultBaseUrl } = p;
            const toggleKey = toggleKeyFor(key);
            const val = httpApiKeys[key] || "";
            const baseUrl = httpBaseUrls[key] || "";
            const isExpanded = expandedActive === key;
            const isVisible = visible[key] ?? false;
            const isOff = disabledProviders.includes(toggleKey);

            return (
              <div key={key} className={`rounded-lg overflow-hidden ring-1 ring-pane-border/30 transition-colors ${isOff ? "opacity-40" : ""}`}>
                {/* Collapsed header */}
                <button
                  onClick={() => setExpandedActive(isExpanded ? null : key)}
                  className="flex items-center justify-between w-full py-2 px-3 bg-pane-bg hover:bg-pane-bg/80 active:bg-pane-bg/60 transition-all"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <motion.svg
                      animate={{ rotate: isExpanded ? 90 : 0 }}
                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      className="text-pane-text-secondary/30 shrink-0"
                    >
                      <path d="M3 2L6 5L3 8" />
                    </motion.svg>
                    <span
                      className="text-pane-text font-mono truncate"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {label}
                    </span>
                    <span
                      className="text-pane-text-secondary/25 font-mono shrink-0"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      ••••{val.slice(-4)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    <a
                      href={docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-pane-text-secondary/25 hover:text-pane-text-secondary font-mono transition-colors"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ↗
                    </a>
                    <ProviderToggle toggleKey={toggleKey} label={label} />
                  </div>
                </button>

                {/* Expanded content */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="p-3 pt-2 border-t border-pane-border/30 bg-pane-bg/30 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <input
                            type={isVisible ? "text" : "password"}
                            value={val}
                            onChange={(e) => onKeyChange(key, e.target.value)}
                            placeholder={placeholder}
                            className="flex-1 px-2 py-1 rounded-lg font-mono text-pane-text border border-pane-border/40 hover:border-pane-border outline-none placeholder:text-pane-text-secondary/25 bg-transparent"
                            style={{ fontSize: "var(--pane-font-size-xs)" }}
                          />
                          {val && (
                            <button
                              onClick={() => setVisible((v) => ({ ...v, [key]: !v[key] }))}
                              className="text-pane-text-secondary/40 hover:text-pane-text-secondary shrink-0"
                            >
                              {isVisible ? (
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                                  <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                                  <circle cx="7" cy="7" r="1.5" />
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                                  <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                                  <circle cx="7" cy="7" r="1.5" />
                                  <path d="M2 2l10 10" />
                                </svg>
                              )}
                            </button>
                          )}
                        </div>
                        {showBaseUrl && (
                          <div className="flex items-center gap-2 pl-4 border-l border-pane-border/20">
                            <span
                              className="text-pane-text-secondary/40 font-mono whitespace-nowrap"
                              style={{ fontSize: "var(--pane-font-size-xs)" }}
                            >
                              base url
                            </span>
                            <input
                              type="text"
                              value={baseUrl}
                              onChange={(e) => onBaseUrlChange?.(key, e.target.value)}
                              placeholder={defaultBaseUrl || "https://..."}
                              className="flex-1 px-2 py-0.5 rounded-lg font-mono text-pane-text-secondary border border-pane-border/20 hover:border-pane-border/40 outline-none placeholder:text-pane-text-secondary/20 bg-transparent"
                              style={{ fontSize: "var(--pane-font-size-xs)" }}
                            />
                          </div>
                        )}
                        {key === "z-ai" && <ZaiPlanTierSelector />}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      {/* Available providers */}
      {availableProviders.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span
            className="text-pane-text-secondary/30 font-mono tracking-wider px-0.5"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            available
          </span>
          {availableProviders.map((p) => {
            const { key, label, placeholder, docsUrl, showBaseUrl, defaultBaseUrl } = p;
            const isExpanded = expandedAvailable === key;

            return (
              <div key={key} className={`rounded-lg overflow-hidden ring-1 transition-colors ${isExpanded ? "ring-pane-border/30" : "ring-pane-border/10 hover:ring-pane-border/20"}`}>
                {/* Compact row — click to expand */}
                <button
                  onClick={() => setExpandedAvailable(isExpanded ? null : key)}
                  className={`flex items-center justify-between w-full py-2 px-3 transition-all ${isExpanded ? "bg-pane-bg" : "bg-pane-bg/30 hover:bg-pane-bg/50 active:bg-pane-bg/60"}`}
                >
                  <div className="flex items-center gap-2">
                    <motion.svg
                      animate={{ rotate: isExpanded ? 90 : 0 }}
                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      className="text-pane-text-secondary/15 shrink-0"
                    >
                      <path d="M3 2L6 5L3 8" />
                    </motion.svg>
                    <span
                      className="text-pane-text-secondary/50 font-mono"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {label}
                    </span>
                  </div>
                  <a
                    href={docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-pane-text-secondary/15 hover:text-pane-text-secondary/50 font-mono transition-colors"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    get key ↗
                  </a>
                </button>

                {/* Expanded fields — appears when clicked */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="p-3 pt-2 border-t border-pane-border/30 bg-pane-bg/30 flex flex-col gap-2">
                        <input
                          ref={inputRef}
                          type="password"
                          value={httpApiKeys[key] || ""}
                          onChange={(e) => onKeyChange(key, e.target.value)}
                          placeholder={placeholder}
                          autoFocus
                          className="flex-1 px-2 py-1 rounded-lg font-mono text-pane-text border border-pane-border/40 hover:border-pane-border outline-none placeholder:text-pane-text-secondary/25 bg-transparent"
                          style={{ fontSize: "var(--pane-font-size-xs)" }}
                        />
                        {showBaseUrl && (
                          <div className="flex items-center gap-2 pl-4 border-l border-pane-border/20">
                            <span
                              className="text-pane-text-secondary/40 font-mono whitespace-nowrap"
                              style={{ fontSize: "var(--pane-font-size-xs)" }}
                            >
                              base url
                            </span>
                            <input
                              type="text"
                              value={httpBaseUrls[key] || ""}
                              onChange={(e) => onBaseUrlChange?.(key, e.target.value)}
                              placeholder={defaultBaseUrl || "https://..."}
                              className="flex-1 px-2 py-0.5 rounded-lg font-mono text-pane-text-secondary border border-pane-border/20 hover:border-pane-border/40 outline-none placeholder:text-pane-text-secondary/20 bg-transparent"
                              style={{ fontSize: "var(--pane-font-size-xs)" }}
                            />
                          </div>
                        )}
                        <span
                          className="text-pane-text-secondary/25 font-mono"
                          style={{ fontSize: "var(--pane-font-size-xs)" }}
                        >
                          paste your key — it saves automatically
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {activeProviders.length === 0 && availableProviders.length === 0 && (
        <span
          className="text-pane-text-secondary/30 font-mono"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          no providers
        </span>
      )}

      <span
        className="text-pane-text-secondary/30 font-mono"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        saved automatically
      </span>
    </div>
  );
}

// ─── Curated Models Section ──────────────────────────────────────────────────

function CuratedModelsSection() {
  const curatedModels = useWorkspaceStore((s) => s.curatedModels);
  const addCuratedModel = useWorkspaceStore((s) => s.addCuratedModel);
  const removeCuratedModel = useWorkspaceStore((s) => s.removeCuratedModel);
  const allModels = useWorkspaceStore((s) => s.allModels);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);

  const [search, setSearch] = useState("");
  const [manualId, setManualId] = useState("");
  const [added, setAdded] = useState(false);

  // Build flat list of all available models (non-disabled providers)
  const availableModels = useMemo(() => {
    const list: { id: string; name: string; provider: string; label: string; inputCost: number | null; outputCost: number | null }[] = [];
    for (const [providerKey, models] of Object.entries(allModels)) {
      if (!models || models.length === 0) continue;
      if (disabledProviders.includes(providerKey)) continue;
      for (const m of models) {
        list.push({
          id: m.id,
          name: m.name || m.id,
          provider: providerKey,
          label: providerKey === "anthropic" || providerKey === "anthropic-api" ? "Claude" :
                 providerKey === "gemini" || providerKey === "gemini-api" ? "Gemini" :
                 providerKey === "deepseek" ? "DeepSeek" :
                 providerKey === "openrouter" ? "OpenRouter" :
                 providerKey === "kimi" ? "Kimi" :
                 providerKey === "stepfun" ? "StepFun" :
                 providerKey === "xiaomi" ? "Xiaomi" : providerKey,
          inputCost: m.input_cost,
          outputCost: m.output_cost,
        });
      }
    }
    return list;
  }, [allModels, disabledProviders]);

  // Filter available by search
  const filteredAvailable = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return availableModels.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.label.toLowerCase().includes(q)
    ).slice(0, 50); // cap at 50 for performance
  }, [availableModels, search]);

  // Resolve curated model names from available data
  const curatedWithDetails = useMemo(() => {
    return curatedModels.map((id) => {
      const found = availableModels.find((m) => m.id === id);
      return found || { id, name: id, provider: "", label: "", inputCost: null, outputCost: null };
    });
  }, [curatedModels, availableModels]);

  const handleAddManual = () => {
    const id = manualId.trim();
    if (!id) return;
    addCuratedModel(id);
    setManualId("");
    setAdded(true);
    setTimeout(() => setAdded(false), 1500);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Your Models list */}
      {curatedModels.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span
            className="text-pane-text-secondary/30 font-mono tracking-wider px-0.5"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            your models ({curatedModels.length})
          </span>
          <div className="flex flex-col gap-1">
            {curatedWithDetails.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-pane-bg/40 ring-1 ring-pane-border/20">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="text-pane-text-secondary/20 font-mono shrink-0"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {m.label || "—"}
                  </span>
                  <span
                    className="font-mono text-pane-text truncate"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {m.name}
                  </span>
                </div>
                <button
                  onClick={() => removeCuratedModel(m.id)}
                  className="text-pane-text-secondary/30 hover:text-pane-status-removed transition-colors shrink-0 ml-2"
                  title="remove"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {curatedModels.length === 0 && (
        <span
          className="text-pane-text-secondary/30 font-mono"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          no models selected — all available models will show in the picker
        </span>
      )}

      {/* Separator */}
      <div className="border-t border-pane-border/20" />

      {/* Browse all */}
      <div className="flex flex-col gap-2">
        <span
          className="text-pane-text-secondary/30 font-mono tracking-wider px-0.5"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          browse all
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search models..."
          className="w-full px-2.5 py-1.5 rounded-lg font-mono text-pane-text border border-pane-border/40 hover:border-pane-border outline-none placeholder:text-pane-text-secondary/25 bg-transparent"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        />
        {search && filteredAvailable.length > 0 && (
          <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
            {filteredAvailable.map((m) => {
              const alreadyAdded = curatedModels.includes(m.id);
              return (
                <div
                  key={m.id}
                  className="flex items-center justify-between py-1.5 px-2.5 rounded-lg hover:bg-pane-bg/40 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="text-pane-text-secondary/20 font-mono shrink-0"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {m.label}
                    </span>
                    <span
                      className="font-mono text-pane-text truncate"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {m.name}
                    </span>
                    {(m.inputCost != null && m.outputCost != null) && (
                      <span
                        className="text-pane-text-secondary/20 font-mono shrink-0"
                        style={{ fontSize: "var(--pane-font-size-xs)" }}
                      >
                        ${m.inputCost}/M · ${m.outputCost}/M
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => alreadyAdded ? removeCuratedModel(m.id) : addCuratedModel(m.id)}
                    className={`shrink-0 ml-2 transition-colors ${alreadyAdded ? 'text-pane-status-added hover:text-pane-status-removed' : 'text-pane-text-secondary/40 hover:text-pane-status-added'}`}
                    title={alreadyAdded ? "remove" : "add"}
                  >
                    {alreadyAdded ? (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M3 6h6" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M6 2v8M2 6h8" />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {search && filteredAvailable.length === 0 && (
          <span
            className="text-pane-text-secondary/30 font-mono"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            no models match "{search}"
          </span>
        )}
      </div>

      {/* Add by ID */}
      <div className="flex flex-col gap-2">
        <span
          className="text-pane-text-secondary/30 font-mono tracking-wider px-0.5"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          add by id
        </span>
        <div className="flex items-center gap-2">
          <input
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddManual(); }}
            placeholder="e.g. anthropic/claude-sonnet-4-5-20250929"
            className="flex-1 px-2.5 py-1.5 rounded-lg font-mono text-pane-text border border-pane-border/40 hover:border-pane-border outline-none placeholder:text-pane-text-secondary/25 bg-transparent"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          />
          <button
            onClick={handleAddManual}
            disabled={!manualId.trim()}
            className="px-3 py-1.5 rounded-lg font-mono text-pane-text-secondary bg-pane-bg/40 ring-1 ring-pane-border/30 hover:ring-pane-border/50 transition-colors disabled:opacity-30"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {added ? "added" : "add"}
          </button>
        </div>
        <span
          className="text-pane-text-secondary/25 font-mono"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          paste any model id — it'll appear in the picker even if it hasn't been fetched yet
        </span>
      </div>
    </div>
  );
}

// ─── MCP Servers Section ──────────────────────────────────────────────────────

/** View mode for the add-server flow. */
type McpAddMode = "idle" | "catalog" | "manual";

/** Builds a McpServerConfig from a catalog entry + user inputs. */
function buildCatalogConfig(
  entry: CatalogServer,
  inputValues: Record<string, string>,
): McpServerConfig {
  const env: Record<string, string> = { ...(entry.fixedEnv || {}) };
  const finalArgs = [...entry.args];

  for (const input of entry.inputs) {
    const val = inputValues[input.envKey]?.trim();
    if (!val) continue;

    if (input.envKey === "_PATH_ARG") {
      // Path/connection-string servers: append as trailing positional argument
      finalArgs.push(val);
    } else if (input.envKey === "_HEADER_ARG") {
      // mcp-remote servers with static auth: pass as --header argument.
      // Static Authorization headers bypass the OAuth browser flow entirely.
      finalArgs.push("--header");
      finalArgs.push(
        input.headerTemplate
          ? input.headerTemplate.replace("{value}", val)
          : val,
      );
    } else {
      env[input.envKey] = val;
    }
  }

  const config: McpServerConfig = {
    command: entry.command,
    args: finalArgs,
    enabled: true,
  };
  if (Object.keys(env).length > 0) config.env = env;
  return config;
}

// ── Voice section ─────────────────────────────────────────────────────────
// Realtime voice settings: which voice Pane speaks with + live preview.
// Voices verified against the realtime-conversations guide (Aug 2026):
// alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
const VOICE_OPTIONS: Array<{ id: string; note: string }> = [
  { id: "alloy", note: "neutral · balanced" },
  { id: "ash", note: "calm · grounded" },
  { id: "ballad", note: "expressive · warm" },
  { id: "coral", note: "bright · friendly" },
  { id: "echo", note: "clear · steady" },
  { id: "sage", note: "soft · thoughtful" },
  { id: "shimmer", note: "airy · upbeat" },
  { id: "verse", note: "versatile · neutral" },
  { id: "marin", note: "natural · recommended" },
  { id: "cedar", note: "warm · recommended" },
];

function VoiceSection() {
  const [voice, setVoice] = useState<string>("marin");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    loadSettings()
      .then((s: UserSettings) => {
        const v = (s as { voice_settings?: { voice?: string } }).voice_settings?.voice;
        if (v) setVoice(v);
      })
      .catch(() => undefined);
  }, []);

  const pick = (id: string): void => {
    setVoice(id);
    setTestError(null);
    saveSettings({ voice_settings: { voice: id } } as unknown as Partial<UserSettings>)
      .catch((err: unknown) => console.error("[voice] failed to save voice setting:", err));
  };

  const test = async (): Promise<void> => {
    if (testing || playing) return;
    setTesting(true);
    setTestError(null);
    try {
      const res = (await electronAPI.invoke("voice_preview", { voice })) as {
        ok: boolean;
        audioB64?: string;
        error?: string;
      };
      if (!res.ok || !res.audioB64) {
        setTestError(res.error ?? "preview failed");
        setTesting(false);
        return;
      }
      // CSP media-src allows blob: but not data: — decode base64 into a Blob.
      const bin = atob(res.audioB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mp3" }));
      const el = new Audio(url);
      audioRef.current = el;
      el.onended = () => {
        URL.revokeObjectURL(url);
        setPlaying(false);
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        setPlaying(false);
        setTestError("playback failed — click test again");
      };
      setTesting(false);
      setPlaying(true);
      await el.play();
    } catch (err: unknown) {
      setTesting(false);
      setPlaying(false);
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        {VOICE_OPTIONS.map((v) => {
          const selected = v.id === voice;
          return (
            <button
              key={v.id}
              onClick={() => pick(v.id)}
              className={`flex items-baseline justify-between gap-2 px-3 py-2 rounded-md text-left font-mono btn-press transition-colors ring-1 ${
                selected
                  ? "bg-pane-accent/10 ring-pane-accent/40 text-pane-text"
                  : "bg-pane-bg ring-pane-border/25 text-pane-text-secondary hover:text-pane-text"
              }`}
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              <span>{v.id}</span>
              <span className="text-pane-text-secondary/50" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                {v.note}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mt-1">
        <button
          onClick={() => void test()}
          disabled={testing || playing}
          className={`font-mono btn-press px-3 py-1.5 rounded-md ring-1 transition-colors ${
            testing || playing
              ? "text-pane-text-secondary/40 ring-pane-border/25"
              : "text-pane-accent ring-pane-accent/40 hover:bg-pane-accent/10"
          }`}
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {testing ? "testing…" : playing ? "playing…" : `test ${voice}`}
        </button>
        {testError && (
          <span className="text-pane-error font-mono truncate" style={{ fontSize: "var(--pane-font-size-xs)" }} title={testError}>
            {testError}
          </span>
        )}
      </div>
      <span className="text-pane-text-secondary/50 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
        changing voice reconnects an active session · needs an openai key in providers
      </span>
    </div>
  );
}

function McpServersSection() {
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  const [loading, setLoading] = useState(true);
  const [addMode, setAddMode] = useState<McpAddMode>("idle");
  const [installing, setInstalling] = useState<CatalogServer | null>(null);
  const [installInputs, setInstallInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Manual entry state
  const [newName, setNewName] = useState("");
  const [newCommand, setNewCommand] = useState("");
  const [newArgs, setNewArgs] = useState("");
  const [newEnv, setNewEnv] = useState("");

  useEffect(() => {
    loadSettings()
      .then((s: UserSettings) => {
        setServers(s.mcp_servers || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const persistServers = useCallback((updated: Record<string, McpServerConfig>) => {
    setServers(updated);
    saveSettings({ mcp_servers: updated }).catch((err: unknown) => {
      console.error("[mcp] Failed to save server config:", err);
    });
  }, []);

  const handleToggle = (name: string) => {
    const existing = servers[name];
    if (!existing) return;
    persistServers({
      ...servers,
      [name]: { ...existing, enabled: existing.enabled === false ? true : false },
    });
  };

  const handleDelete = (name: string) => {
    const updated = { ...servers };
    delete updated[name];
    persistServers(updated);
  };

  // ── Catalog install ──────────────────────────────────────────────────

  const startInstall = (entry: CatalogServer) => {
    setError(null);
    setInstalling(entry);
    setInstallInputs({});
    // If the server has no required inputs, install immediately
    if (entry.inputs.length === 0) {
      confirmInstall(entry, {});
    }
  };

  const confirmInstall = (
    entry: CatalogServer,
    inputs: Record<string, string>,
  ) => {
    setError(null);
    // Check required inputs
    for (const input of entry.inputs) {
      if (!inputs[input.envKey]?.trim()) {
        setError(`${input.label} is required.`);
        return;
      }
    }

    // Use catalog id as server name, suffix if collision
    let name = entry.id;
    let suffix = 1;
    while (servers[name]) {
      name = `${entry.id}-${++suffix}`;
    }

    const config = buildCatalogConfig(entry, inputs);
    persistServers({ ...servers, [name]: config });
    setInstalling(null);
    setInstallInputs({});
  };

  // ── Manual add ───────────────────────────────────────────────────────

  const handleManualAdd = () => {
    setError(null);
    const name = newName.trim();
    if (!name) { setError("Server name is required."); return; }
    if (!newCommand.trim()) { setError("Command is required."); return; }
    if (servers[name]) { setError(`A server named "${name}" already exists.`); return; }

    const config: McpServerConfig = {
      command: newCommand.trim(),
      enabled: true,
    };

    const parsedArgs = newArgs.trim().match(/(?:[^\s"]+|"[^"]*")+/g);
    if (parsedArgs) {
      config.args = parsedArgs.map((a: string) => a.replace(/^"|"$/g, ""));
    }

    if (newEnv.trim()) {
      const envObj: Record<string, string> = {};
      for (const line of newEnv.trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          envObj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
      if (Object.keys(envObj).length > 0) config.env = envObj;
    }

    persistServers({ ...servers, [name]: config });
    setAddMode("idle");
    setNewName("");
    setNewCommand("");
    setNewArgs("");
    setNewEnv("");
  };

  if (loading) {
    return (
      <div className="text-pane-text-secondary/40 font-mono py-4" style={{ fontSize: "var(--pane-font-size-xs)" }}>
        loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p
        className="text-pane-text-secondary/50 font-mono leading-relaxed"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        Connect external MCP servers (Figma, GitHub, Notion, etc.). Their tools become available to the model. Changes take effect on the next message.
      </p>

      {/* Existing servers */}
      {Object.entries(servers).length > 0 && (
        <div className="flex flex-col gap-2">
          {Object.entries(servers).map(([name, config]) => {
            return (
              <div
                key={name}
                className="flex items-center justify-between py-2 px-3 rounded-md bg-pane-text/[0.03] ring-1 ring-pane-border/20"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span
                    className="text-pane-text font-mono truncate"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    {name}
                  </span>
                  <span
                    className="text-pane-text-secondary/40 font-mono truncate"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {config.command} {(config.args || []).join(" ")}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => handleToggle(name)}
                    className={`w-4 h-4 rounded-full transition-all duration-200 ${
                      config.enabled !== false
                        ? "bg-pane-accent ring-2 ring-pane-accent/30"
                        : "bg-transparent ring-1 ring-pane-text/20 hover:ring-pane-text/40"
                    }`}
                    title={config.enabled !== false ? "Enabled" : "Disabled"}
                  />
                  <button
                    onClick={() => handleDelete(name)}
                    className="text-pane-text-secondary/40 hover:text-pane-error transition-colors font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                    title="Remove server"
                  >
                    remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Install flow: catalog browser or credential form */}
      {installing ? (
        <div className="flex flex-col gap-3 py-3 px-4 rounded-md bg-pane-text/[0.03] ring-1 ring-pane-border/20">
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <span
                className="text-pane-text font-mono"
                style={{ fontSize: "var(--pane-font-size-sm)" }}
              >
                {installing.name}
              </span>
              <span
                className="text-pane-text-secondary/40 font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                {installing.description}
              </span>
            </div>
            <button
              onClick={() => { setInstalling(null); setError(null); }}
              className="text-pane-text-secondary/40 hover:text-pane-text-secondary/70 transition-colors font-mono"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              cancel
            </button>
          </div>

          {error && (
            <span className="text-pane-error font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
              {error}
            </span>
          )}

          {installing.inputs.length > 0 && (
            <div className="flex flex-col gap-3">
              {installing.inputs.map((input) => (
                <div key={input.envKey} className="flex flex-col gap-1">
                  <label
                    className="text-pane-text-secondary/60 font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {input.label}
                  </label>
                  <input
                    type={input.secret !== false ? "password" : "text"}
                    placeholder={input.placeholder}
                    value={installInputs[input.envKey] || ""}
                    onChange={(e) =>
                      setInstallInputs((prev) => ({ ...prev, [input.envKey]: e.target.value }))
                    }
                    className="w-full bg-transparent outline-none text-pane-text font-mono placeholder:text-pane-text-secondary/30 border-b border-pane-border/30 focus:border-pane-accent/50 transition-colors pb-1"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                    autoFocus={installing.inputs[0]?.envKey === input.envKey}
                  />
                  {input.obtainUrl && (
                    <a
                      href={input.obtainUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-pane-accent/70 hover:text-pane-accent font-mono transition-colors"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      {input.obtainLabel || "Get key →"}
                    </a>
                  )}
                </div>
              ))}
              <button
                onClick={() => confirmInstall(installing, installInputs)}
                className="text-pane-accent font-mono hover:text-pane-accent/80 transition-colors text-left"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                install
              </button>
            </div>
          )}
        </div>
      ) : addMode === "catalog" ? (
        <div className="flex flex-col gap-3 py-2">
          {/* Catalog browser */}
          {CATEGORY_ORDER.map((cat) => {
            const entries = MCP_CATALOG.filter((e) => e.category === cat);
            if (entries.length === 0) return null;
            return (
              <div key={cat} className="flex flex-col gap-1.5">
                <span
                  className="text-pane-text-secondary/30 font-mono uppercase tracking-wider"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  {CATEGORY_LABELS[cat]}
                </span>
                {entries.map((entry) => {
                  const alreadyInstalled = entry.id in servers;
                  return (
                    <button
                      key={entry.id}
                      onClick={() => startInstall(entry)}
                      disabled={alreadyInstalled}
                      className="flex items-start gap-2.5 py-2 px-3 rounded-md text-left transition-all duration-150 group disabled:opacity-30 disabled:cursor-not-allowed hover:bg-pane-text/[0.04] ring-1 ring-pane-border/10 hover:ring-pane-border/30"
                    >
                      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-pane-text font-mono"
                            style={{ fontSize: "var(--pane-font-size-sm)" }}
                          >
                            {entry.name}
                          </span>
                          {entry.official && (
                            <span
                              className="text-pane-accent/40 font-mono"
                              style={{ fontSize: "9px" }}
                            >
                              official
                            </span>
                          )}
                        </div>
                        <span
                          className="text-pane-text-secondary/40 font-mono leading-snug"
                          style={{ fontSize: "var(--pane-font-size-xs)" }}
                        >
                          {entry.description}
                        </span>
                      </div>
                      <span
                        className="text-pane-text-secondary/30 group-hover:text-pane-accent font-mono shrink-0 mt-0.5"
                        style={{ fontSize: "var(--pane-font-size-xs)" }}
                      >
                        {alreadyInstalled ? "✓" : "+"}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          <button
            onClick={() => setAddMode("idle")}
            className="text-pane-text-secondary/40 font-mono hover:text-pane-text-secondary/70 transition-colors text-left pt-1"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            close
          </button>
        </div>
      ) : addMode === "manual" ? (
        <div className="flex flex-col gap-2 py-2 px-3 rounded-md bg-pane-text/[0.03] ring-1 ring-pane-border/20">
          {error && (
            <span className="text-pane-error font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
              {error}
            </span>
          )}
          <input
            type="text"
            placeholder="server name (e.g. figma)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full bg-transparent outline-none text-pane-text font-mono placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
            autoFocus
          />
          <input
            type="text"
            placeholder="command (e.g. npx)"
            value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            className="w-full bg-transparent outline-none text-pane-text font-mono placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
          <input
            type="text"
            placeholder='arguments (e.g. -y figma-developer-mcp --stdio)'
            value={newArgs}
            onChange={(e) => setNewArgs(e.target.value)}
            className="w-full bg-transparent outline-none text-pane-text font-mono placeholder:text-pane-text-secondary/30"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
          <textarea
            placeholder={"environment variables (one per line):\nFIGMA_API_KEY=fig_...\nGITHUB_TOKEN=ghp_..."}
            value={newEnv}
            onChange={(e) => setNewEnv(e.target.value)}
            rows={3}
            className="w-full bg-transparent outline-none text-pane-text font-mono placeholder:text-pane-text-secondary/30 resize-none"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleManualAdd}
              className="text-pane-accent font-mono hover:text-pane-accent/80 transition-colors"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              add
            </button>
            <button
              onClick={() => { setAddMode("idle"); setError(null); }}
              className="text-pane-text-secondary/40 font-mono hover:text-pane-text-secondary/70 transition-colors"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => setAddMode("catalog")}
            className="text-pane-text-secondary/50 hover:text-pane-accent font-mono transition-colors text-left flex items-center gap-2"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            + browse servers
          </button>
          <button
            onClick={() => setAddMode("manual")}
            className="text-pane-text-secondary/30 hover:text-pane-text-secondary/60 font-mono transition-colors text-left"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            + add custom server
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Cloud Section ────────────────────────────────────────────────────────────

const electronAPI = window.electronAPI;

type SyncPhase = "idle" | "compressing" | "encrypting" | "uploading" | "complete" | "error" |
  "finding" | "downloading" | "decrypting" | "restoring";

function CloudSection() {
  const [user, setUser] = useState<CloudUser | null>(null);
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [syncPhase, setSyncPhase] = useState<SyncPhase>("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Load initial state
  useEffect(() => {
    cloudGetUser().then(setUser).catch(() => {});
    cloudGetStatus().then(setStatus).catch(() => {});
  }, []);

  // Listen for auth changes from main process
  useEffect(() => {
    const unlisten = electronAPI.on("cloud-auth-changed", (u: CloudUser | null) => {
      setUser(u);
      if (u) {
        cloudGetStatus().then(setStatus).catch(() => {});
      } else {
        setStatus(null);
      }
    });
    return () => { if (typeof unlisten === "function") unlisten(); };
  }, []);

  // Listen for sync progress
  useEffect(() => {
    const unlisten = electronAPI.on("cloud-sync-progress", (data: { phase: SyncPhase; message?: string }) => {
      setSyncPhase(data.phase);
      if (data.phase === "complete") {
        // Refresh status after successful sync
        cloudGetStatus().then(setStatus).catch(() => {});
        setTimeout(() => setSyncPhase("idle"), 2000);
      }
      if (data.phase === "error") {
        setSyncError(data.message || "Backup failed");
        setTimeout(() => setSyncPhase("idle"), 4000);
      }
    });
    return () => { if (typeof unlisten === "function") unlisten(); };
  }, []);

  const handleLogin = async () => {
    setLoggingIn(true);
    setSyncError(null);
    try {
      const u = await cloudLogin();
      setUser(u);
      if (u) cloudGetStatus().then(setStatus).catch(() => {});
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await cloudLogout().catch(() => {});
    setUser(null);
    setStatus(null);
    setSyncPhase("idle");
    setSyncError(null);
  };

  const handleBackupNow = async () => {
    setSyncError(null);
    setSyncPhase("compressing");
    try {
      await cloudTriggerBackup();
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : "Backup failed");
      setSyncPhase("idle");
    }
  };

  const handleRestore = async () => {
    if (!confirm("Restore from cloud? This will overwrite your local data.")) return;
    setSyncError(null);
    setRestoring(true);
    setSyncPhase("finding");
    try {
      await cloudRestore();
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : "Restore failed");
      setSyncPhase("idle");
    } finally {
      setRestoring(false);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "never";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  const phaseLabel: Record<SyncPhase, string> = {
    idle: "",
    compressing: "compressing…",
    encrypting: "encrypting…",
    uploading: "uploading…",
    complete: "done",
    error: "failed",
    finding: "finding backup…",
    downloading: "downloading…",
    decrypting: "decrypting…",
    restoring: "restoring…",
  };

  const isSyncing = syncPhase !== "idle" && syncPhase !== "complete" && syncPhase !== "error";

  if (!user) {
    // Logged-out state
    return (
      <div className="flex flex-col gap-4">
        <p
          className="text-pane-text-secondary/60 font-mono leading-relaxed"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          back up your session, memory, and brain to pane cloud. encrypted before it leaves your machine.
        </p>
        <button
          onClick={handleLogin}
          disabled={loggingIn}
          className="flex items-center gap-2.5 self-start px-4 py-2 rounded-lg bg-pane-text/[0.06] hover:bg-pane-text/[0.10] active:bg-pane-text/[0.13] text-pane-text font-mono disabled:opacity-40 disabled:cursor-default transition-colors"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          {loggingIn ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="animate-spin opacity-60">
              <path d="M7 1.5A5.5 5.5 0 0112.5 7" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          )}
          {loggingIn ? "opening browser…" : "sign in with github"}
        </button>
        {syncError && (
          <span
            className="text-pane-error font-mono"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {syncError}
          </span>
        )}
      </div>
    );
  }

  // Logged-in state
  return (
    <div className="flex flex-col gap-4">
      {/* User row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {user.avatar_url ? (
            <img
              src={user.avatar_url}
              alt=""
              className="w-6 h-6 rounded-full ring-1 ring-pane-border/30"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-pane-text/[0.08] flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="7" r="4" />
                <path d="M5.5 21a7.5 7.5 0 0115 0" />
              </svg>
            </div>
          )}
          <span
            className="text-pane-text font-mono"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {user.github_login}
          </span>
        </div>
        <button
          onClick={handleLogout}
          className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono transition-colors"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          sign out
        </button>
      </div>

      {/* Status rows */}
      <div className="flex flex-col gap-1 py-2 border-t border-b border-pane-border/20">
        <SettingRow label="last backup">
          <span
            className="text-pane-text-secondary/60 font-mono"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {formatDate(status?.last_backup ?? null)}
          </span>
        </SettingRow>
        <SettingRow label="storage used">
          <span
            className="text-pane-text-secondary/60 font-mono"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {status ? `${status.storage_mb} MB` : "—"}
          </span>
        </SettingRow>
        <SettingRow label="backups stored">
          <span
            className="text-pane-text-secondary/60 font-mono"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          >
            {status?.backup_count ?? "—"}
          </span>
        </SettingRow>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleBackupNow}
          disabled={isSyncing || restoring}
          className="px-3 py-1.5 rounded-lg font-mono text-pane-text bg-pane-text/[0.06] hover:bg-pane-text/[0.10] active:bg-pane-text/[0.13] disabled:opacity-40 disabled:cursor-default transition-colors"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          back up now
        </button>
        <button
          onClick={handleRestore}
          disabled={isSyncing || restoring}
          className="px-3 py-1.5 rounded-lg font-mono text-pane-text-secondary/60 hover:text-pane-text hover:bg-pane-text/[0.06] disabled:opacity-40 disabled:cursor-default transition-colors"
          style={{ fontSize: "var(--pane-font-size-sm)" }}
        >
          restore
        </button>
        {(isSyncing || syncPhase === "complete") && (
          <span
            className="text-pane-terminal font-mono"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            {phaseLabel[syncPhase]}
          </span>
        )}
      </div>

      {syncError && (
        <span
          className="text-pane-error font-mono"
          style={{ fontSize: "var(--pane-font-size-xs)" }}
        >
          {syncError}
        </span>
      )}
    </div>
  );
}

// ─── Main Profile View ────────────────────────────────────────────────────────

import { TokenAnalytics } from "./TokenAnalytics";

// Accordion Section Component
function AccordionSection({
  title,
  icon,
  children,
  isExpanded,
  onToggle,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg overflow-hidden ring-1 ring-pane-border/30 transition-colors">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full group py-2 px-4 bg-pane-bg hover:bg-pane-bg/80 active:bg-pane-bg/60 transition-all"
      >
        <div className="flex items-center gap-3">
          {icon && <div className="text-pane-text-secondary/60">{icon}</div>}
          <span className="text-pane-text font-mono" style={{ fontSize: "var(--pane-font-size-sm)" }}>
            {title}
          </span>
        </div>
        <motion.svg
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-pane-text-secondary/40 group-hover:text-pane-text-secondary"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </motion.svg>
      </button>
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="p-4 bg-pane-bg/30 border-t border-pane-border/30">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Profile() {
  const theme = useWorkspaceStore((s) => s.theme);
  const fontSize = useWorkspaceStore((s) => s.fontSize);
  const panelFontSize = useWorkspaceStore((s) => s.panelFontSize);
  const editorFontSize = useWorkspaceStore((s) => s.editorFontSize);
  const fontWeight = useWorkspaceStore((s) => s.fontWeight);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const completionSound = useWorkspaceStore((s) => s.completionSound);
  const setCompletionSound = useWorkspaceStore((s) => s.setCompletionSound);
  const punkBackend = useWorkspaceStore((s) => s.punkBackend);
  const httpApiKeys = useWorkspaceStore((s) => s.httpApiKeys);
  const setHttpApiKeys = useWorkspaceStore((s) => s.setHttpApiKeys);
  const httpBaseUrls = useWorkspaceStore((s) => s.httpBaseUrls);
  const setHttpBaseUrls = useWorkspaceStore((s) => s.setHttpBaseUrls);

  const [dnaString, setDnaString] = useState("");
  const dnaSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Accordion state - only one section expanded at a time
  const [expandedSection, setExpandedSection] = useState<string | null>("identity");

  // All backends use the HTTP API (CLI backends have been removed)

  useEffect(() => {
    brainGetProfile()
      .then(({ profile }) => {
        if (profile) {
          setDnaString(profile.dna || "");
        }
      })
      .catch(() => {});
  }, []);

  // API key changes go straight to the store.
  // useSettingsPersistence watches the store and saves automatically.
  const handleApiKeyChange = (provider: string, key: string) => {
    setHttpApiKeys({ ...httpApiKeys, [provider]: key });
  };

  const handleBaseUrlChange = (provider: string, url: string) => {
    setHttpBaseUrls({ ...httpBaseUrls, [provider]: url });
  };

  const handleDnaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDnaString(e.target.value);
      if (dnaSaveRef.current) clearTimeout(dnaSaveRef.current);
      dnaSaveRef.current = setTimeout(() => {
        brainUpdateDNA(e.target.value).catch(() => {});
      }, 800);
    },
    [],
  );

  // Icon components for each section
  const icons = {
    identity: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
    rules: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
    aiBackend: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M9 9h6v6H9z" />
      </svg>
    ),
    paneAuto: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    apiKeys: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
    appearance: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="M4.93 4.93l1.41 1.41" />
        <path d="M17.66 17.66l1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="M6.34 17.66l-1.41 1.41" />
        <path d="M19.07 4.93l-1.41 1.41" />
      </svg>
    ),
    cloud: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
      </svg>
    ),
    claude: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
    usage: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20V10" />
        <path d="M18 20V4" />
        <path d="M6 20v-4" />
      </svg>
    ),
    integrations: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11a9 9 0 0118 0" />
        <path d="M12 11V2" />
        <path d="M8 22h8" />
        <path d="M12 22v-6" />
      </svg>
    ),
    models: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    voice: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    ),
  };

  return (
    <div
      className="h-full overflow-y-auto overflow-x-hidden px-12 pt-8 pb-48 relative"
    >
      <div className="mx-auto w-full max-w-4xl flex flex-col gap-y-8">
        {/* DNA Section */}
        <AccordionSection
          title="identity"
          icon={icons.identity}
          isExpanded={expandedSection === "identity"}
          onToggle={() => setExpandedSection(expandedSection === "identity" ? null : "identity")}
        >
          <textarea
            value={dnaString}
            onChange={handleDnaChange}
            placeholder="your developer dna — what the model sees about how you work..."
            rows={6}
            className="w-full font-mono text-pane-text bg-transparent outline-none resize-none placeholder:text-pane-text-secondary/30 leading-[1.75]"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
          <span
            className="text-pane-text-secondary/50 font-mono mt-2 block"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            this is exactly what every model sees about you — edit directly, no compilation needed
          </span>
        </AccordionSection>

        {/* Usage Section */}
        <AccordionSection
          title="usage & spend"
          icon={icons.usage}
          isExpanded={expandedSection === "usage"}
          onToggle={() => setExpandedSection(expandedSection === "usage" ? null : "usage")}
        >
          <TokenAnalytics projectId={null} isExpanded={expandedSection === "usage"} />
        </AccordionSection>

        {/* AI Engines Section */}
        <AccordionSection
          title="pane auto"
          icon={icons.paneAuto}
          isExpanded={expandedSection === "paneAuto"}
          onToggle={() => setExpandedSection(expandedSection === "paneAuto" ? null : "paneAuto")}
        >
          <PaneAutoSection httpApiKeys={httpApiKeys} />
        </AccordionSection>



        {/* API Keys Section */}
        {punkBackend === "api" && (
          <AccordionSection
            title="providers"
            icon={icons.apiKeys}
            isExpanded={expandedSection === "apiKeys"}
            onToggle={() => setExpandedSection(expandedSection === "apiKeys" ? null : "apiKeys")}
          >
            <ClaudeSignInCard />
            <ApiKeysSection
              httpApiKeys={httpApiKeys}
              onKeyChange={handleApiKeyChange}
              httpBaseUrls={httpBaseUrls}
              onBaseUrlChange={handleBaseUrlChange}
            />
          </AccordionSection>
        )}

        {/* Voice Section */}
        <AccordionSection
          title="voice"
          icon={icons.voice}
          isExpanded={expandedSection === "voice"}
          onToggle={() => setExpandedSection(expandedSection === "voice" ? null : "voice")}
        >
          <VoiceSection />
        </AccordionSection>

        {/* Curate Models Section */}
        {punkBackend === "api" && (
          <AccordionSection
            title="curate models"
            icon={icons.models}
            isExpanded={expandedSection === "curatedModels"}
            onToggle={() => setExpandedSection(expandedSection === "curatedModels" ? null : "curatedModels")}
          >
            <CuratedModelsSection />
          </AccordionSection>
        )}

        {/* Appearance Section */}
        <AccordionSection
          title="appearance"
          icon={icons.appearance}
          isExpanded={expandedSection === "appearance"}
          onToggle={() => setExpandedSection(expandedSection === "appearance" ? null : "appearance")}
        >
          <div className="flex flex-col gap-0">
            {/* Theme — circles preview each theme's actual bg/text colors */}
            <div className="flex items-center justify-between py-4">
              <span
                className="text-pane-text-secondary/50 font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                theme
              </span>
              <div className="flex items-center gap-3">
                {([
                  { id: "system" as const, bg: "linear-gradient(135deg, #1C1B1A 50%, #F4F2EC 50%)", ring: "#A8A59E" },
                  { id: "dark" as const, bg: "#1C1B1A", ring: "#D8D5CE" },
                  { id: "light" as const, bg: "#F4F2EC", ring: "#1A1918" },
                  { id: "pure" as const, bg: "#FFFFFF", ring: "#0A0A0A" },
                  { id: "glass" as const, bg: "transparent", ring: "#D8D5CE" },
                ]).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="w-4 h-4 rounded-full transition-all duration-200"
                    style={{
                      background: t.bg,
                      backgroundSize: "cover",
                      boxShadow: theme === t.id
                        ? `0 0 0 2px ${t.ring}`
                        : `0 0 0 1px ${t.ring}40`,
                      border: t.id === "glass" ? "0.5px solid rgba(255,255,255,0.15)" : "none",
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Separator */}
            <div className="border-t border-pane-border/20" />

            {/* Text size — four rows: chat, weight, editor, panel */}
            <div className="flex flex-col gap-3 py-4">
              <div className="flex items-center justify-between">
                <span
                  className="text-pane-text-secondary/50 font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  text size
                </span>
                <FontSizeControl
                  value={fontSize}
                  onIncrease={() => useWorkspaceStore.getState().increaseFontSize()}
                  onDecrease={() => useWorkspaceStore.getState().decreaseFontSize()}
                  onReset={() => useWorkspaceStore.getState().resetFontSize()}
                />
              </div>
              <div className="flex items-center justify-between">
                <span
                  className="text-pane-text-secondary/50 font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  weight
                </span>
                <FontSizeControl
                  value={fontWeight}
                  onIncrease={() => useWorkspaceStore.getState().increaseFontWeight()}
                  onDecrease={() => useWorkspaceStore.getState().decreaseFontWeight()}
                  onReset={() => useWorkspaceStore.getState().resetFontWeight()}
                  unit=""
                />
              </div>
              <div className="flex items-center justify-between">
                <span
                  className="text-pane-text-secondary/50 font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  editor
                </span>
                <FontSizeControl
                  value={editorFontSize}
                  onIncrease={() => useWorkspaceStore.getState().increaseEditorFontSize()}
                  onDecrease={() => useWorkspaceStore.getState().decreaseEditorFontSize()}
                  onReset={() => useWorkspaceStore.getState().resetEditorFontSize()}
                />
              </div>
              <div className="flex items-center justify-between">
                <span
                  className="text-pane-text-secondary/50 font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  panel
                </span>
                <FontSizeControl
                  value={panelFontSize}
                  onIncrease={() => useWorkspaceStore.getState().increasePanelFontSize()}
                  onDecrease={() => useWorkspaceStore.getState().decreasePanelFontSize()}
                  onReset={() => useWorkspaceStore.getState().resetPanelFontSize()}
                />
              </div>
            </div>

            {/* Separator */}
            <div className="border-t border-pane-border/20" />

            {/* Sound — three dots: none / subtle / present. Active dot uses accent color. Clicking plays immediately */}
            <div className="flex items-center justify-between py-4">
              <span
                className="text-pane-text-secondary/50 font-mono"
                style={{ fontSize: "var(--pane-font-size-xs)" }}
              >
                sound
              </span>
              <div className="flex items-center gap-3">
                {[
                  { id: "none", label: "none" },
                  { id: "Tink", label: "subtle" },
                  { id: "Pop", label: "present" },
                ].map((s) => {
                  const isActive = s.id === "Pop"
                    ? completionSound !== "none" && completionSound !== "Tink"
                    : completionSound === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => {
                        setCompletionSound(s.id);
                        if (s.id !== "none") {
                          window.electronAPI.invoke("play_sound", { sound: s.id });
                        }
                      }}
                      className={`w-4 h-4 rounded-full transition-all duration-200 ${
                        isActive
                          ? "bg-pane-accent ring-2 ring-pane-accent/30"
                          : "bg-transparent ring-1 ring-pane-text/20 hover:ring-pane-text/40"
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </AccordionSection>

        {/* Shortcuts Section */}
        <AccordionSection
          title="shortcuts"
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
            </svg>
          }
          isExpanded={expandedSection === "shortcuts"}
          onToggle={() => setExpandedSection(expandedSection === "shortcuts" ? null : "shortcuts")}
        >
          <KeybindingsSection />
        </AccordionSection>

        {/* MCP Servers Section */}
        <AccordionSection
          title="integrations"
          icon={icons.integrations}
          isExpanded={expandedSection === "integrations"}
          onToggle={() => setExpandedSection(expandedSection === "integrations" ? null : "integrations")}
        >
          <McpServersSection />
        </AccordionSection>

        {/* Cloud Section */}
        <AccordionSection
          title="pane cloud"
          icon={icons.cloud}
          isExpanded={expandedSection === "cloud"}
          onToggle={() => setExpandedSection(expandedSection === "cloud" ? null : "cloud")}
        >
          <CloudSection />
        </AccordionSection>


      </div>
    </div>
  );
}
