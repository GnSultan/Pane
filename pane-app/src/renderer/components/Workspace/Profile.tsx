import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { motion, AnimatePresence } from "framer-motion";
import {
  engineKey,
  DEFAULT_BACKEND_ROUTING,
  type EngineOption,
  type IntentRouting,
  isThinkingModel,
  getContextWindowForModel,
} from "../../lib/models";
import {
  brainUpdateIdentity,
  brainSaveAvatar,
  brainGetProfile,
  brainUpdateRules,
  brainUpdatePhilosophy,
  reinitializePunkBackend,
  getBackendAvailability,
  getClaudeAuthState,
  claudeSignin,
  claudeSignout,
  cloudLogin,
  cloudLogout,
  cloudGetUser,
  cloudGetStatus,
  cloudTriggerBackup,
  cloudRestore,
  type ClaudeAuthState,
  type CloudUser,
  type CloudStatus,
} from "../../lib/tauri-commands";
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
}: {
  value: string;
  onChange: (opt: EngineOption) => void;
  allModels?: Record<string, Array<{ id: string; name: string; context_length: number; input_cost?: number | null; output_cost?: number | null }>>;
  sdkModels?: import("../../lib/punk-types").SdkModel[] | null;
  httpApiKeys?: Record<string, string>;
  disabledProviders?: string[];
}) {
  // Provider display labels
  const providerLabel = useCallback((provider: string): string => {
    const labels: Record<string, string> = {
      anthropic: "Claude",
      "anthropic-api": "Anthropic API",
      gemini: "Gemini CLI",
      "gemini-api": "Gemini API",
      deepseek: "DeepSeek",
      openrouter: "OpenRouter",
      kimi: "Kimi",
      stepfun: "StepFun",
      xiaomi: "Xiaomi MiMo",
    };
    return labels[provider] || provider;
  }, []);

  const groupedOptions = useMemo(() => {
    const groups: Record<string, EngineOption[]> = {};
    const isGeminiBackend = useWorkspaceStore.getState().punkBackend === "gemini";
    const isClaudeBackend = useWorkspaceStore.getState().punkBackend === "claude-code";

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
      const isUsable =
        provider === "anthropic" ? isClaudeBackend :
        provider === "gemini" ? isGeminiBackend :
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

    return groups;
  }, [allModels, sdkModels, httpApiKeys, disabledProviders]);

  return (
    <select
      value={value}
      onChange={(e) => {
        const parts = e.target.value.split("::");
        const provider = parts[0];
        const model = parts[1];
        if (provider && model && provider in groupedOptions) {
          const group = groupedOptions[provider];
          if (group) {
            const opt = group.find((o: EngineOption) => o.model === model);
            if (opt) onChange(opt);
          }
        }
      }}
      className="px-3 py-1.5 rounded-xl font-mono bg-pane-surface text-pane-text border border-pane-border/40 hover:border-pane-border outline-none max-w-[220px]"
      style={{ fontSize: "var(--pane-font-size-sm)" }}
    >
      {Object.entries(groupedOptions).map(([provider, opts]) => (
        <optgroup key={provider} label={provider} className="bg-pane-bg">
          {opts.map((opt: EngineOption) => {
            const pricing = opt.inputCost != null && opt.outputCost != null
              ? ` · $${opt.inputCost}/$${opt.outputCost}/M`
              : "";
            return (
              <option key={engineKey(opt)} value={engineKey(opt)}>
                [{providerLabel(opt.provider)}] {opt.label}{pricing}
              </option>
            );
          })}
        </optgroup>
      ))}
    </select>
  );
}

function AiEnginesSection({
  httpApiKeys,
}: {
  httpApiKeys: Record<string, string>;
}) {
  const routing = useWorkspaceStore(useShallow((s) => s.getEffectiveRouting()));
  const allModels = useWorkspaceStore((s) => s.allModels);
  const sdkModels = useWorkspaceStore((s) => s.sdkModels);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);
  const refreshAllModels = useWorkspaceStore((s) => s.refreshAllModels);

  // For transparent routing, we show all engines but need to know which are usable
  // CLI providers (anthropic for Claude Code, gemini for Gemini CLI) are always usable if installed
  // HTTP providers need API keys
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [geminiAvailable, setGeminiAvailable] = useState(false);

  useEffect(() => {
    getBackendAvailability()
      .then((availability) => {
        setClaudeCodeAvailable(availability.claude);
        setGeminiAvailable(availability.gemini);
      })
      .catch(() => {
        setClaudeCodeAvailable(false);
        setGeminiAvailable(false);
      });
  }, []);

  // Build a flat list of all usable engines from dynamic data for auto-heal
  const usableEngines = useMemo(() => {
    const engines: EngineOption[] = [];
    // SDK models for anthropic
    if (sdkModels && sdkModels.length > 0 && claudeCodeAvailable && !disabledProviders.includes("anthropic")) {
      sdkModels.forEach((m) => engines.push({
        label: m.displayName || m.value,
        provider: "anthropic",
        model: m.value,
        thinking: false,
        requiresKey: "anthropic",
      }));
    }
    // allModels for everything else
    for (const [provider, models] of Object.entries(allModels)) {
      if (!models || models.length === 0) continue;
      if (provider === "anthropic" && engines.some((e) => e.provider === "anthropic")) continue;
      const baseProvider = provider.replace(/-api$/, "");
      const isUsable =
        provider === "anthropic" ? claudeCodeAvailable :
        provider === "gemini" ? geminiAvailable :
        !!httpApiKeys?.[baseProvider];
      if (!isUsable) continue;
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
  }, [allModels, sdkModels, claudeCodeAvailable, geminiAvailable, httpApiKeys, disabledProviders]);

  const autoRoute = useWorkspaceStore((s) => s.intentAutoRoute);
  const setIntentRouting = useWorkspaceStore((s) => s.setIntentRouting);

  // Auto-heal: when availability changes (CLI installed/uninstalled, keys added/removed),
  // reset any slot that points to a provider that is no longer usable.
  useEffect(() => {
    const isProviderUsable = (provider: string) => {
      // Claude Code CLI handles anthropic provider
      if (provider === "anthropic") return claudeCodeAvailable;
      // Gemini CLI handles gemini provider
      if (provider === "gemini") return geminiAvailable;
      // HTTP providers need API keys
      return !!httpApiKeys?.[provider];
    };

    const firstUsable = usableEngines[0];

    // Nothing we can do if there are no usable engines at all
    if (!firstUsable) return;

    const current = routing;
    const updates: Partial<IntentRouting> = {};

    if (current?.plan && !isProviderUsable(current.plan.provider)) {
      updates.plan = { provider: firstUsable.provider, model: firstUsable.model, thinking: firstUsable.thinking };
    }
    if (current?.execute && !isProviderUsable(current.execute.provider)) {
      updates.execute = { provider: firstUsable.provider, model: firstUsable.model, thinking: firstUsable.thinking };
    }
    if (current?.explain && !isProviderUsable(current.explain.provider)) {
      updates.explain = { provider: firstUsable.provider, model: firstUsable.model, thinking: firstUsable.thinking };
    }
    if (current?.other && !isProviderUsable(current.other.provider)) {
      updates.other = { provider: firstUsable.provider, model: firstUsable.model, thinking: firstUsable.thinking };
    }

    if (Object.keys(updates).length > 0) {
      setIntentRouting({ ...current, ...updates } as IntentRouting);
    }
    // Only re-run when availability changes
  }, [httpApiKeys, claudeCodeAvailable, geminiAvailable]);

  const setIntentAutoRoute = useWorkspaceStore((s) => s.setIntentAutoRoute);

  const handleThinkingChange = (opt: EngineOption) => {
    const isReasoningProvider =
      opt.provider === "openrouter" ||
      opt.provider === "kimi" ||
      opt.provider === "xiaomi" ||
      opt.provider === "deepseek";

    const next = {
      plan: {
        provider: opt.provider,
        model: opt.model,
        thinking: opt.thinking || isReasoningProvider,
      },
      execute: routing?.execute || DEFAULT_BACKEND_ROUTING["api"]!.execute,
      explain: routing?.explain || DEFAULT_BACKEND_ROUTING["api"]!.explain,
      other: routing?.other || DEFAULT_BACKEND_ROUTING["api"]!.other,
    };
    setIntentRouting(next);
    // Reinitialize to apply routing changes
    reinitializePunkBackend("api").catch(() => {});
  };

  const handleBuildingChange = (opt: EngineOption) => {
    const next = {
      plan: routing?.plan || DEFAULT_BACKEND_ROUTING["api"]!.plan,
      execute: {
        provider: opt.provider,
        model: opt.model,
        thinking: opt.thinking,
      },
      explain: routing?.explain || DEFAULT_BACKEND_ROUTING["api"]!.explain,
      other: routing?.other || DEFAULT_BACKEND_ROUTING["api"]!.other,
    };
    setIntentRouting(next);
    // Reinitialize to apply routing changes
    reinitializePunkBackend("api").catch(() => {});
  };

  const handleExplainChange = (opt: EngineOption) => {
    const next = {
      plan: routing?.plan || DEFAULT_BACKEND_ROUTING["api"]!.plan,
      execute: routing?.execute || DEFAULT_BACKEND_ROUTING["api"]!.execute,
      explain: {
        provider: opt.provider,
        model: opt.model,
        thinking: opt.thinking,
      },
      other: routing?.other || DEFAULT_BACKEND_ROUTING["api"]!.other,
    };
    setIntentRouting(next);
    // Reinitialize to apply routing changes
    reinitializePunkBackend("api").catch(() => {});
  };

  const handleOtherChange = (opt: EngineOption) => {
    const next = {
      plan: routing?.plan || DEFAULT_BACKEND_ROUTING["api"]!.plan,
      execute: routing?.execute || DEFAULT_BACKEND_ROUTING["api"]!.execute,
      explain: routing?.explain || DEFAULT_BACKEND_ROUTING["api"]!.explain,
      other: {
        provider: opt.provider,
        model: opt.model,
        thinking: opt.thinking,
      },
    };
    setIntentRouting(next);
    // Reinitialize to apply routing changes
    reinitializePunkBackend("api").catch(() => {});
  };

  const handleAutoRouteToggle = () => {
    setIntentAutoRoute(!autoRoute);
    // Reinitialize to apply routing changes
    reinitializePunkBackend("api").catch(() => {});
  };

  const resolveEngine = (
    current: { provider: string; model: string; thinking: boolean } | undefined,
  ): EngineOption => {
    const routingDefault = DEFAULT_BACKEND_ROUTING["api"];
    const target = current || routingDefault?.plan;
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

  const thinkingEngine = resolveEngine(routing?.plan);
  const buildingEngine = resolveEngine(routing?.execute);
  const explainingEngine = resolveEngine(routing?.explain);
  const otherEngine = resolveEngine(routing?.other);

  // Check if each engine's provider is usable
  const isProviderUsable = (provider: string) => {
    if (provider === "anthropic") return claudeCodeAvailable;
    if (provider === "gemini") return geminiAvailable;
    return !!httpApiKeys[provider];
  };

  const missingThinkingKey = !isProviderUsable(thinkingEngine.provider);
  const missingBuildingKey = !isProviderUsable(buildingEngine.provider);
  const missingExplainingKey = !isProviderUsable(explainingEngine.provider);
  const missingOtherKey = !isProviderUsable(otherEngine.provider);

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
              <div className="flex items-center justify-between">
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
                    architecture, design, decisions
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <EngineSelect
                    allModels={allModels}
                    sdkModels={sdkModels}
                    httpApiKeys={httpApiKeys}
                    disabledProviders={disabledProviders}
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
                  ⚠ {thinkingEngine.provider === "anthropic" ? "Claude not connected" : thinkingEngine.provider === "gemini" ? "Gemini CLI not installed" : `no API key for ${thinkingEngine.requiresKey}`} — {thinkingEngine.provider === "anthropic" ? "sign in below" : thinkingEngine.provider === "gemini" ? "install CLI" : "add key below"}
                </span>
              )}
            </div>

            <div className="py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span
                    className="text-pane-text font-mono"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
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
                  value={engineKey(buildingEngine)}
                  onChange={handleBuildingChange}
                />
              </div>
              {missingBuildingKey && (
                <span
                  className="text-pane-error font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  ⚠ {buildingEngine.provider === "anthropic" ? "Claude not connected" : buildingEngine.provider === "gemini" ? "Gemini CLI not installed" : `no API key for ${buildingEngine.requiresKey}`} — {buildingEngine.provider === "anthropic" ? "sign in below" : buildingEngine.provider === "gemini" ? "install CLI" : "add key below"}
                </span>
              )}
            </div>

            <div className="py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span
                    className="text-pane-text font-mono"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    when explaining
                  </span>
                  <span
                    className="text-pane-text-secondary/50 font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    understanding code, walkthroughs
                  </span>
                </div>
                <EngineSelect
                  allModels={allModels}
                  sdkModels={sdkModels}
                  httpApiKeys={httpApiKeys}
                  disabledProviders={disabledProviders}
                  value={engineKey(explainingEngine)}
                  onChange={handleExplainChange}
                />
              </div>
              {missingExplainingKey && (
                <span
                  className="text-pane-error font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  ⚠ {explainingEngine.provider === "anthropic" ? "Claude not connected" : explainingEngine.provider === "gemini" ? "Gemini CLI not installed" : `no API key for ${explainingEngine.requiresKey}`} — {explainingEngine.provider === "anthropic" ? "sign in below" : explainingEngine.provider === "gemini" ? "install CLI" : "add key below"}
                </span>
              )}
            </div>

            <div className="py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <span
                    className="text-pane-text font-mono"
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    everything else
                  </span>
                  <span
                    className="text-pane-text-secondary/50 font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    chat, questions, general tasks
                  </span>
                </div>
                <EngineSelect
                  allModels={allModels}
                  sdkModels={sdkModels}
                  httpApiKeys={httpApiKeys}
                  disabledProviders={disabledProviders}
                  value={engineKey(otherEngine)}
                  onChange={handleOtherChange}
                />
              </div>
              {missingOtherKey && (
                <span
                  className="text-pane-error font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  ⚠ {otherEngine.provider === "anthropic" ? "Claude not connected" : otherEngine.provider === "gemini" ? "Gemini CLI not installed" : `no API key for ${otherEngine.requiresKey}`} — {otherEngine.provider === "anthropic" ? "sign in below" : otherEngine.provider === "gemini" ? "install CLI" : "add key below"}
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

// API key providers — each has a key input field
const API_KEY_PROVIDERS = [
  { key: "gemini", label: "Google Gemini", placeholder: "AI...", docsUrl: "https://aistudio.google.com/app/apikey" },
  { key: "deepseek", label: "DeepSeek", placeholder: "sk-...", docsUrl: "https://platform.deepseek.com/api_keys" },
  { key: "anthropic", label: "Anthropic", placeholder: "sk-ant-...", docsUrl: "https://console.anthropic.com/settings/keys" },
  { key: "openrouter", label: "OpenRouter", placeholder: "sk-or-...", docsUrl: "https://openrouter.ai/keys" },
  { key: "xiaomi", label: "Xiaomi MiMo", placeholder: "sk-...", docsUrl: "https://platform.xiaomimimo.com/", showBaseUrl: true },
] as const;

// Gemini CLI — external, needs install
const CLI_PROVIDERS = [
  { key: "gemini", label: "Gemini CLI", description: "gemini cli" },
] as const;

function ApiKeysSection({
  httpApiKeys,
  onKeyChange,
  httpBaseUrls = {},
  onBaseUrlChange,
  claudeCodeAvailable = false,
  geminiAvailable: _geminiAvailable = false,
}: {
  httpApiKeys: Record<string, string>;
  onKeyChange: (provider: string, key: string) => void;
  httpBaseUrls?: Record<string, string>;
  onBaseUrlChange?: (provider: string, url: string) => void;
  claudeCodeAvailable?: boolean;
  geminiAvailable?: boolean;
}) {
  void _geminiAvailable; // passed through from parent, reserved for future use
  const sdkAccount = useWorkspaceStore((s) => s.sdkAccount);
  void (claudeCodeAvailable && sdkAccount != null); // reserved for per-provider auth gating
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);
  const toggleProvider = useWorkspaceStore((s) => s.toggleProvider);

  const ProviderToggle = ({ toggleKey, label }: { toggleKey: string; label: string }) => {
    const off = disabledProviders.includes(toggleKey);
    return (
      <button
        onClick={() => toggleProvider(toggleKey)}
        className={`w-6 h-3.5 rounded-full relative transition-colors ${off ? "bg-pane-text-secondary/20" : "bg-pane-status-added/60"}`}
        title={off ? `enable ${label}` : `disable ${label}`}
      >
        <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${off ? "left-0.5" : "left-[11px]"}`} />
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {API_KEY_PROVIDERS.map((p) => {
          const { key, label, placeholder, docsUrl } = p;
          const showBaseUrl = (p as any).showBaseUrl;
          const toggleKey = (key === "anthropic" || key === "gemini") ? `${key}-api` : key;
          const val = httpApiKeys[key] || "";
          const baseUrl = httpBaseUrls[key] || "";
          const hasKey = !!val;
          const isVisible = visible[key] ?? false;
          const isOff = hasKey && disabledProviders.includes(toggleKey);
          return (
            <div key={key} className={`py-2 flex flex-col gap-1 ${isOff ? "opacity-40" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {hasKey && <ProviderToggle toggleKey={toggleKey} label={label} />}
                  <span
                    className="text-pane-text font-mono"
                    style={{ fontSize: "var(--pane-font-size-xs)" }}
                  >
                    {label}
                  </span>
                </div>
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-pane-text-secondary/40 hover:text-pane-text-secondary font-mono"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  get key ↗
                </a>
              </div>
              <div className="flex flex-col gap-2">
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
                      onClick={() =>
                        setVisible((v) => ({ ...v, [key]: !v[key] }))
                      }
                      className="text-pane-text-secondary/40 hover:text-pane-text-secondary shrink-0"
                      title={isVisible ? "Hide" : "Show"}
                    >
                      {isVisible ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                        >
                          <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                          <circle cx="7" cy="7" r="1.5" />
                        </svg>
                      ) : (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinecap="round"
                        >
                          <path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                          <circle cx="7" cy="7" r="1.5" />
                          <path d="M2 2l10 10" />
                        </svg>
                      )}
                    </button>
                  )}
                  {val && (
                    <span
                      className="text-pane-text-secondary/30 font-mono shrink-0"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    >
                      ••••{val.slice(-4)}
                    </span>
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
                      placeholder="https://api.xiaomimimo.com/v1"
                      className="flex-1 px-2 py-0.5 rounded-lg font-mono text-pane-text-secondary border border-pane-border/20 hover:border-pane-border/40 outline-none placeholder:text-pane-text-secondary/20 bg-transparent"
                      style={{ fontSize: "var(--pane-font-size-xs)" }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <span
        className="text-pane-text-secondary/40 font-mono"
        style={{ fontSize: "var(--pane-font-size-xs)" }}
      >
        saved automatically
      </span>
    </div>
  );
}

// ─── Cloud Section ────────────────────────────────────────────────────────────

const electronAPI = (window as any).electronAPI;

type SyncPhase = "idle" | "compressing" | "encrypting" | "uploading" | "complete" |
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
    const unlisten = electronAPI.on("cloud-sync-progress", (data: { phase: SyncPhase }) => {
      setSyncPhase(data.phase);
      if (data.phase === "complete") {
        // Refresh status after successful sync
        cloudGetStatus().then(setStatus).catch(() => {});
        setTimeout(() => setSyncPhase("idle"), 2000);
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
    } catch (err: any) {
      setSyncError(err?.message || "Login failed");
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
    } catch (err: any) {
      setSyncError(err?.message || "Backup failed");
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
    } catch (err: any) {
      setSyncError(err?.message || "Restore failed");
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
    finding: "finding backup…",
    downloading: "downloading…",
    decrypting: "decrypting…",
    restoring: "restoring…",
  };

  const isSyncing = syncPhase !== "idle" && syncPhase !== "complete";

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

function formatResetTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return "now";
  // Show full date + time for the profile (e.g., "Apr 9 · 11:00 AM")
  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
  const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${dateStr} · ${timeStr}`;
}

export function Profile() {
  const profileName = useWorkspaceStore((s) => s.profileName);
  const profileBio = useWorkspaceStore((s) => s.profileBio);
  const profileRole = useWorkspaceStore((s) => s.profileRole);
  const avatarDataUrl = useWorkspaceStore((s) => s.profileAvatarDataUrl);
  const theme = useWorkspaceStore((s) => s.theme);
  const fontSize = useWorkspaceStore((s) => s.fontSize);
  const panelFontSize = useWorkspaceStore((s) => s.panelFontSize);
  const editorFontSize = useWorkspaceStore((s) => s.editorFontSize);
  const fontWeight = useWorkspaceStore((s) => s.fontWeight);
  const setTheme = useWorkspaceStore((s) => s.setTheme);
  const completionSound = useWorkspaceStore((s) => s.completionSound);
  const setCompletionSound = useWorkspaceStore((s) => s.setCompletionSound);
  const playCompletionSound = useWorkspaceStore((s) => s.playCompletionSound);
  const punkBackend = useWorkspaceStore((s) => s.punkBackend);
  const httpApiKeys = useWorkspaceStore((s) => s.httpApiKeys);
  const setHttpApiKeys = useWorkspaceStore((s) => s.setHttpApiKeys);
  const httpBaseUrls = useWorkspaceStore((s) => s.httpBaseUrls);
  const setHttpBaseUrls = useWorkspaceStore((s) => s.setHttpBaseUrls);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const identitySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [philosophy, setPhilosophy] = useState("");
  const [rules, setRules] = useState("");
  const philosophySaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Accordion state - only one section expanded at a time
  const [expandedSection, setExpandedSection] = useState<string | null>("identity");

  // Detect which CLI backends are available in PATH
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [geminiAvailable, setGeminiAvailable] = useState(false);
  const [claudeAuthState, setClaudeAuthState] = useState<ClaudeAuthState | null>(null);
  const [claudeSigningIn, setClaudeSigningIn] = useState(false);
  const [claudeSigninStatus, setClaudeSigninStatus] = useState<string[]>([]);
  const sdkAccount = useWorkspaceStore((s) => s.sdkAccount);
  const rateLimitInfo = useWorkspaceStore((s) => s.rateLimitInfo);
  // Authenticated if direct auth check says so OR if SDK account arrived via prefetch.
  // Direct check is the source of truth — SDK account supplements it with extra fields.
  const isClaudeAuthenticated =
    claudeAuthState?.authenticated === true || (claudeCodeAvailable && sdkAccount != null);
  const disabledProviders = useWorkspaceStore((s) => s.disabledProviders);
  const toggleProvider = useWorkspaceStore((s) => s.toggleProvider);

  useEffect(() => {
    // Check backend availability (is the CLI installed?)
    getBackendAvailability()
      .then((availability) => {
        setClaudeCodeAvailable(availability.claude);
        setGeminiAvailable(availability.gemini);
        useWorkspaceStore.getState().setBackendAvailability({
          claudeCode: availability.claude,
          geminiCli: availability.gemini,
        });
      })
      .catch(() => {
        setClaudeCodeAvailable(false);
        setGeminiAvailable(false);
      });

    // Read Claude auth state directly from ~/.claude.json — no session needed.
    // This gives us the real signed-in/out state immediately, regardless of
    // whether the SDK prefetch has fired yet.
    getClaudeAuthState()
      .then(setClaudeAuthState)
      .catch(() => setClaudeAuthState({ authenticated: false, account: null }));
  }, []);

  useEffect(() => {
    const cleanup = (window as any).electronAPI.on("pane-claude-signin", (data: any) => {
      if (data.type === "status") {
        if (data.output?.length) setClaudeSigninStatus(data.output);
      }
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    brainGetProfile()
      .then(({ profile }) => {
        if (profile) {
          setPhilosophy(profile.philosophy || "");
          setRules(profile.rules || "");
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

  const saveIdentity = useCallback((field: string, value: string) => {
    if (identitySaveRef.current) clearTimeout(identitySaveRef.current);
    identitySaveRef.current = setTimeout(() => {
      brainUpdateIdentity({ [field]: value }).catch(() => {});
    }, 500);
  }, []);

  const handleAvatarClick = useCallback(
    () => fileInputRef.current?.click(),
    [],
  );

  const handleAvatarChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        useWorkspaceStore.getState().setProfileAvatarDataUrl(dataUrl);
        await brainSaveAvatar(dataUrl.split(",")[1]!, file.type).catch(
          () => {},
        );
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    },
    [],
  );

  const handlePhilosophyChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPhilosophy(e.target.value);
      if (philosophySaveRef.current) clearTimeout(philosophySaveRef.current);
      philosophySaveRef.current = setTimeout(() => {
        brainUpdatePhilosophy(e.target.value).catch(() => {});
      }, 800);
    },
    [],
  );

  const handleRulesChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setRules(e.target.value);
      if (philosophySaveRef.current) clearTimeout(philosophySaveRef.current);
      philosophySaveRef.current = setTimeout(() => {
        brainUpdateRules(e.target.value).catch(() => {});
      }, 800);
    },
    [],
  );

  const initials = profileName
    ? profileName
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "";

  // Icon components for each section
  const icons = {
    identity: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="7" r="4" />
        <path d="M5.5 21a7.5 7.5 0 0115 0" />
      </svg>
    ),
    philosophy: (
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
    aiEngines: (
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
  };

  return (
    <div
      className="h-full overflow-y-auto overflow-x-hidden px-12 pt-8 pb-48 relative"
      data-no-drag
    >
      <div className="max-w-xl mx-auto flex flex-col gap-y-8">
        {/* Identity Section */}
        <AccordionSection
          title="identity"
          icon={icons.identity}
          isExpanded={expandedSection === "identity"}
          onToggle={() => setExpandedSection(expandedSection === "identity" ? null : "identity")}
        >
          <div className="flex flex-col items-center gap-4">
            <button
              onClick={handleAvatarClick}
              className="relative w-20 h-20 rounded-full overflow-hidden bg-pane-bg ring-1 ring-pane-border/40 hover:ring-pane-text/20 transition-shadow group"
              title="Change photo"
            >
              {avatarDataUrl ? (
                <img
                  src={avatarDataUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {initials ? (
                    <span className="font-mono text-pane-text text-lg font-medium">
                      {initials}
                    </span>
                  ) : (
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 28 28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      className="text-pane-text-secondary/40"
                    >
                      <circle cx="14" cy="11" r="5" />
                      <path d="M4 26c0-5.523 4.477-10 10-10s10 4.477 10 10" />
                    </svg>
                  )}
                </div>
              )}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="white"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <circle cx="8" cy="8" r="2.5" />
                  <path d="M2.5 6.5V5a1.5 1.5 0 011.5-1.5h1.5M12 3.5h1.5A1.5 1.5 0 0115 5v1.5M13.5 11v1.5a1.5 1.5 0 01-1.5 1.5h-1.5M4 14H2.5A1.5 1.5 0 011 12.5V11" />
                </svg>
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleAvatarChange}
            />

            <input
              type="text"
              value={profileName}
              onChange={(e) => {
                useWorkspaceStore.getState().setProfileName(e.target.value);
                saveIdentity("name", e.target.value);
              }}
              placeholder="your name"
              className="w-full text-center font-mono text-pane-text bg-transparent outline-none text-lg placeholder:text-pane-text-secondary/30"
            />
            <input
              type="text"
              value={profileRole}
              onChange={(e) => {
                useWorkspaceStore.getState().setProfileRole(e.target.value);
                saveIdentity("role", e.target.value);
              }}
              placeholder="role"
              className="w-full text-center font-mono text-pane-text-secondary bg-transparent outline-none placeholder:text-pane-text-secondary/30"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            />
            <textarea
              value={profileBio}
              onChange={(e) => {
                useWorkspaceStore.getState().setProfileBio(e.target.value);
                saveIdentity("bio", e.target.value);
              }}
              placeholder="about you"
              rows={2}
              className="w-full text-center font-mono text-pane-text-secondary bg-transparent outline-none resize-none placeholder:text-pane-text-secondary/30 leading-[1.75]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            />
          </div>
        </AccordionSection>

        {/* Claude Section */}
        <AccordionSection
          title="claude"
          icon={icons.claude}
          isExpanded={expandedSection === "claude"}
          onToggle={() => setExpandedSection(expandedSection === "claude" ? null : "claude")}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isClaudeAuthenticated ? "bg-pane-status-added" : "bg-pane-text-secondary/30"}`} />
                <span
                  className={`font-mono ${isClaudeAuthenticated ? "text-[var(--pane-status-added)]" : "text-pane-text-secondary"}`}
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  {isClaudeAuthenticated
                    ? (
                        // Priority: direct auth displayName > direct auth email > SDK email > "connected"
                        claudeAuthState?.account?.displayName ||
                        claudeAuthState?.account?.email ||
                        sdkAccount?.email ||
                        (sdkAccount as any)?.organization ||
                        "connected"
                      )
                    : "not signed in"}
                </span>
              </div>
              {isClaudeAuthenticated ? (
                <button
                  onClick={() =>
                    claudeSignout()
                      .then(() => {
                        setClaudeAuthState({ authenticated: false, account: null });
                        useWorkspaceStore.getState().setSdkInfo(null, null);
                        useWorkspaceStore.getState().setRateLimitInfo(null);
                      })
                      .catch(() => {})
                  }
                  className="font-mono text-pane-text-secondary/60 hover:text-pane-text-secondary transition-colors"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  sign out
                </button>
              ) : (
                <button
                  onClick={() => {
                    if (claudeSigningIn) return;
                    setClaudeSigningIn(true);
                    setClaudeSigninStatus([]);
                    claudeSignin()
                      .then((result) => {
                        if (result?.success) {
                          // Refresh auth state from ~/.claude.json
                          getClaudeAuthState().then((state) => {
                            if (state) setClaudeAuthState(state);
                          }).catch(() => {});
                          // Also trigger prefetch to update SDK account info
                          reinitializePunkBackend("claude-code").catch(() => {});
                        }
                      })
                      .catch(() => {})
                      .finally(() => {
                        setClaudeSigningIn(false);
                        setClaudeSigninStatus([]);
                      });
                  }}
                  className="font-mono text-pane-text-secondary hover:text-pane-text transition-colors"
                  style={{ fontSize: "var(--pane-font-size-xs)" }}
                >
                  {claudeSigningIn ? "signing in…" : "sign in"}
                </button>
              )}
            </div>

            {!isClaudeAuthenticated && claudeSigningIn && claudeSigninStatus.length > 0 && (
              <div className="flex flex-col gap-1">
                {claudeSigninStatus.map((line, i) => (
                  <span key={i} className="font-mono text-pane-text-secondary/60 break-all" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                    {line}
                  </span>
                ))}
              </div>
            )}

            {isClaudeAuthenticated && (() => {
              // Show billing type from direct auth (most reliable) or SDK account
              const billing =
                claudeAuthState?.account?.billingType ||
                (sdkAccount as any)?.billingType ||
                null;
              const plan =
                sdkAccount?.subscription ||
                (sdkAccount as any)?.subscriptionType ||
                (sdkAccount as any)?.planType ||
                (billing === "stripe_subscription" ? "max" : null) ||
                null;
              return plan ? (
                <div className="flex items-center justify-between">
                  <span className="font-mono text-pane-text-secondary" style={{ fontSize: "var(--pane-font-size-xs)" }}>plan</span>
                  <span className="font-mono text-[var(--pane-status-added)]" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                    {plan}
                  </span>
                </div>
              ) : null;
            })()}

            {isClaudeAuthenticated && (() => {
              // Always render the usage bar — 0% baseline when no data has
              // arrived yet so we can see the moment it starts climbing.
              const util = rateLimitInfo?.utilization ?? 0;
              const pct = Math.round(util * 100);
              const hasData = rateLimitInfo?.utilization != null;
              const barColor =
                util >= 0.85 ? "bg-pane-error" :
                util >= 0.7  ? "bg-pane-status-modified" :
                "bg-pane-status-added";
              const textColor =
                util >= 0.85 ? "text-pane-error" :
                util >= 0.7  ? "text-[var(--pane-status-modified)]" :
                hasData      ? "text-[var(--pane-status-added)]" :
                "text-pane-text-secondary/40";
              return (
                <>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-pane-text-secondary" style={{ fontSize: "var(--pane-font-size-xs)" }}>session</span>
                    <span className={`font-mono tabular-nums ${textColor}`} style={{ fontSize: "var(--pane-font-size-xs)" }}>
                      {pct}%
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-pane-text/[0.06] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  {rateLimitInfo?.resetsAt != null && (
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-pane-text-secondary" style={{ fontSize: "var(--pane-font-size-xs)" }}>resets</span>
                      <span className="font-mono text-[var(--pane-status-added)] tabular-nums" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                        {formatResetTime(rateLimitInfo.resetsAt)}
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </AccordionSection>

        {/* Usage Section */}
        <AccordionSection
          title="usage & spend"
          icon={icons.usage}
          isExpanded={expandedSection === "usage"}
          onToggle={() => setExpandedSection(expandedSection === "usage" ? null : "usage")}
        >
          <TokenAnalytics projectId={null} />
        </AccordionSection>

        {/* Philosophy Section */}
        <AccordionSection
          title="philosophy"
          icon={icons.philosophy}
          isExpanded={expandedSection === "philosophy"}
          onToggle={() => setExpandedSection(expandedSection === "philosophy" ? null : "philosophy")}
        >
          <textarea
            value={philosophy}
            onChange={handlePhilosophyChange}
            placeholder="your design principles..."
            rows={4}
            className="w-full font-mono text-pane-text bg-transparent outline-none resize-none placeholder:text-pane-text-secondary/30 leading-[1.75]"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
        </AccordionSection>

        {/* Rules Section */}
        <AccordionSection
          title="rules"
          icon={icons.rules}
          isExpanded={expandedSection === "rules"}
          onToggle={() => setExpandedSection(expandedSection === "rules" ? null : "rules")}
        >
          <textarea
            value={rules}
            onChange={handleRulesChange}
            placeholder={
              "always use bun\nnever auto-commit\nprefer functional over class"
            }
            rows={4}
            className="w-full font-mono text-pane-text bg-transparent outline-none resize-none placeholder:text-pane-text-secondary/30 leading-[1.75]"
            style={{ fontSize: "var(--pane-font-size-sm)" }}
          />
          <span
            className="text-pane-text-secondary/50 font-mono mt-2 block"
            style={{ fontSize: "var(--pane-font-size-xs)" }}
          >
            one per line — these override observed preferences
          </span>
        </AccordionSection>

        {/* AI Engines Section */}
        <AccordionSection
          title="ai engines"
          icon={icons.aiEngines}
          isExpanded={expandedSection === "aiEngines"}
          onToggle={() => setExpandedSection(expandedSection === "aiEngines" ? null : "aiEngines")}
        >
          <AiEnginesSection httpApiKeys={httpApiKeys} />
        </AccordionSection>

        {/* API Keys Section */}
        {punkBackend === "api" && (
          <AccordionSection
            title="providers"
            icon={icons.apiKeys}
            isExpanded={expandedSection === "apiKeys"}
            onToggle={() => setExpandedSection(expandedSection === "apiKeys" ? null : "apiKeys")}
          >
            <ApiKeysSection
              httpApiKeys={httpApiKeys}
              onKeyChange={handleApiKeyChange}
              httpBaseUrls={httpBaseUrls}
              onBaseUrlChange={handleBaseUrlChange}
              claudeCodeAvailable={claudeCodeAvailable}
              geminiAvailable={geminiAvailable}
            />
          </AccordionSection>
        )}

        {/* Appearance Section */}
        <AccordionSection
          title="appearance"
          icon={icons.appearance}
          isExpanded={expandedSection === "appearance"}
          onToggle={() => setExpandedSection(expandedSection === "appearance" ? null : "appearance")}
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-pane-text-secondary/60 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                theme
              </span>
              <div className="flex gap-1">
                {(["system", "dark", "light", "pure", "glass"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`px-3 py-1 rounded-lg font-mono ${theme === t ? "bg-pane-text/[0.12] text-pane-text ring-1 ring-pane-text/20" : "text-pane-text-secondary/40 hover:text-pane-text-secondary hover:bg-pane-text/[0.04]"}`}
                    style={{ fontSize: "var(--pane-font-size-sm)" }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-pane-text-secondary/60 font-mono block mb-2" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                  chat font
                </span>
                <FontSizeControl
                  value={fontSize}
                  onIncrease={() => useWorkspaceStore.getState().increaseFontSize()}
                  onDecrease={() => useWorkspaceStore.getState().decreaseFontSize()}
                  onReset={() => useWorkspaceStore.getState().resetFontSize()}
                />
              </div>
              <div>
                <span className="text-pane-text-secondary/60 font-mono block mb-2" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                  editor font
                </span>
                <FontSizeControl
                  value={editorFontSize}
                  onIncrease={() => useWorkspaceStore.getState().increaseEditorFontSize()}
                  onDecrease={() => useWorkspaceStore.getState().decreaseEditorFontSize()}
                  onReset={() => useWorkspaceStore.getState().resetEditorFontSize()}
                />
              </div>
              <div>
                <span className="text-pane-text-secondary/60 font-mono block mb-2" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                  panel font
                </span>
                <FontSizeControl
                  value={panelFontSize}
                  onIncrease={() => useWorkspaceStore.getState().increasePanelFontSize()}
                  onDecrease={() => useWorkspaceStore.getState().decreasePanelFontSize()}
                  onReset={() => useWorkspaceStore.getState().resetPanelFontSize()}
                />
              </div>
              <div>
                <span className="text-pane-text-secondary/60 font-mono block mb-2" style={{ fontSize: "var(--pane-font-size-xs)" }}>
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
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-pane-text-secondary/60 font-mono" style={{ fontSize: "var(--pane-font-size-xs)" }}>
                sound
              </span>
              <div className="flex gap-1">
                <select
                  value={completionSound}
                  onChange={(e) => setCompletionSound(e.target.value)}
                  className="px-3 py-1.5 rounded-lg font-mono bg-pane-surface text-pane-text border border-pane-border/40 hover:border-pane-border outline-none"
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                >
                  <option value="none">none</option>
                  {[
                    "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass",
                    "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi",
                    "Submarine", "Tink",
                  ].map((s) => (
                    <option key={s} value={s}>
                      {s.toLowerCase()}
                    </option>
                  ))}
                </select>
                <button
                  onClick={playCompletionSound}
                  disabled={completionSound === "none"}
                  className="px-3 py-1.5 rounded-lg font-mono text-pane-text-secondary hover:text-pane-text hover:bg-pane-text/[0.04] disabled:opacity-30 disabled:cursor-default"
                  style={{ fontSize: "var(--pane-font-size-sm)" }}
                  title="Test sound"
                >
                  ▶
                </button>
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

        {/* Cloud Section */}
        <AccordionSection
          title="pane cloud"
          icon={icons.cloud}
          isExpanded={expandedSection === "cloud"}
          onToggle={() => setExpandedSection(expandedSection === "cloud" ? null : "cloud")}
        >
          <CloudSection />
        </AccordionSection>

        {/* Integrations — external CLIs, only when available */}
        {geminiAvailable && (
          <AccordionSection
            title="integrations"
            icon={icons.integrations}
            isExpanded={expandedSection === "integrations"}
            onToggle={() => setExpandedSection(expandedSection === "integrations" ? null : "integrations")}
          >
            <div className="flex flex-col gap-2">
              {CLI_PROVIDERS.map(({ key, label }) => (
                <div key={key} className={`flex items-center justify-between ${disabledProviders.includes(key) ? "opacity-40" : ""}`}>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleProvider(key)}
                      className={`w-3 h-3 rounded-full ring-1 transition-colors ${
                        disabledProviders.includes(key) ? "bg-transparent ring-pane-text-secondary/30" : "bg-pane-status-added ring-pane-status-added"
                      }`}
                      title={disabledProviders.includes(key) ? `enable ${label}` : `disable ${label}`}
                    />
                    <span className="font-mono text-pane-text" style={{ fontSize: "var(--pane-font-size-xs)" }}>{label}</span>
                  </div>
                  <span className="font-mono text-pane-text-secondary" style={{ fontSize: "var(--pane-font-size-xs)" }}>available</span>
                </div>
              ))}
            </div>
          </AccordionSection>
        )}
      </div>
    </div>
  );
}
