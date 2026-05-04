import { create } from "zustand";
import type { ActionId, KeyBinding } from "../lib/keybindings";
import {
  DEFAULT_POWER_COMBO,
  type PowerCombo,
} from "../lib/models";
import type { OpenRouterModel } from "../lib/tauri-commands";
import {
  getOpenRouterModels,
  getAllModels,
  refreshAllModels,
  setAppTheme,
} from "../lib/tauri-commands";

const DEFAULT_FONT_SIZE = 15;
const DEFAULT_PANEL_FONT_SIZE = 13;
const DEFAULT_EDITOR_FONT_SIZE = 14;
const DEFAULT_FONT_WEIGHT = 400;

export type Theme = "dark" | "light" | "pure" | "glass" | "system";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(theme: Theme): "dark" | "light" | "pure" | "glass" {
  return theme === "system" ? getSystemTheme() : theme;
}

interface WorkspaceState {
  fontSize: number;
  panelFontSize: number;
  editorFontSize: number;
  fontWeight: number;
  keybindings: Partial<Record<ActionId, KeyBinding>> | null;
  theme: Theme;
  completionSound: string; // "none" | system sound name | custom file path
  selectedModel: string; // Model alias (e.g., "opus", "sonnet", "haiku") or full model name
  selectedModelProvider: string; // The provider for the current model
  selectedModelThinking: boolean;
  punkBackend: string; // "api" | "claude-code" | "gemini" - kept for backward compatibility
  httpProvider: string; // "deepseek" | "kimi" | "anthropic" | etc.
  httpApiKeys: Record<string, string>;
  httpBaseUrls: Record<string, string>;
  disabledProviders: string[];
  setDisabledProviders: (providers: string[]) => void;
  toggleProvider: (provider: string) => void;
  isProviderEnabled: (provider: string) => boolean;
  powerCombo: PowerCombo;
  autoEscalate: boolean;
  openRouterModels: OpenRouterModel[];
  allModels: Record<string, OpenRouterModel[]>;
  fetchOpenRouterModels: () => Promise<void>;
  fetchAllModels: () => Promise<void>;
  refreshAllModels: () => Promise<void>;

  // Backend availability for transparent routing
  backendAvailability: {
    claudeCode: boolean;
    geminiCli: boolean;
    api: boolean; // Always true
  };
  setBackendAvailability: (availability: { claudeCode: boolean; geminiCli: boolean }) => void;
  // SDK metadata — populated after first backend session init
  sdkModels: import("../lib/punk-types").SdkModel[] | null;
  sdkAccount: import("../lib/punk-types").SdkAccount | null;
  setSdkInfo: (models: import("../lib/punk-types").SdkModel[] | null, account: import("../lib/punk-types").SdkAccount | null) => void;
  rateLimitInfo: import("../lib/punk-types").RateLimitInfo | null;
  setRateLimitInfo: (info: import("../lib/punk-types").RateLimitInfo | null) => void;
  lastTokenUsageAt: number;
  // Profile data
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;
  setFontSize: (size: number) => void;
  increasePanelFontSize: () => void;
  decreasePanelFontSize: () => void;
  resetPanelFontSize: () => void;
  setPanelFontSize: (size: number) => void;
  increaseEditorFontSize: () => void;
  decreaseEditorFontSize: () => void;
  resetEditorFontSize: () => void;
  setEditorFontSize: (size: number) => void;
  increaseFontWeight: () => void;
  decreaseFontWeight: () => void;
  resetFontWeight: () => void;
  setFontWeight: (weight: number) => void;
  setKeybinding: (id: ActionId, binding: KeyBinding) => void;
  resetKeybinding: (id: ActionId) => void;
  resetAllKeybindings: () => void;
  setKeybindingsRaw: (kb: Partial<Record<ActionId, KeyBinding>> | null) => void;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setCompletionSound: (sound: string) => void;
  playCompletionSound: () => void;
  setSelectedModel: (
    model: string,
    thinking?: boolean,
    provider?: string,
  ) => void;
  setPunkBackend: (backend: string) => void;
  setHttpProvider: (provider: string) => void;
  setHttpApiKeys: (keys: Record<string, string>) => void;
  setHttpBaseUrls: (urls: Record<string, string>) => void;
  getEffectiveCombo: () => PowerCombo | undefined;
  setPowerCombo: (combo: PowerCombo | null) => void;
  setAutoEscalate: (autoEscalate: boolean) => void;
}

function applyFontSize(size: number) {
  document.documentElement.style.setProperty("--pane-font-size", `${size}px`);
  document.documentElement.style.setProperty(
    "--pane-font-size-sm",
    `${size - 3}px`,
  );
  document.documentElement.style.setProperty(
    "--pane-font-size-xs",
    `${size - 5}px`,
  );
}

function applyPanelFontSize(size: number) {
  document.documentElement.style.setProperty(
    "--pane-panel-font-size",
    `${size}px`,
  );
  document.documentElement.style.setProperty(
    "--pane-panel-font-size-sm",
    `${size - 2}px`,
  );
  document.documentElement.style.setProperty(
    "--pane-panel-font-size-xs",
    `${size - 4}px`,
  );
}

function applyFontWeight(weight: number) {
  document.documentElement.style.setProperty("--pane-font-weight", `${weight}`);
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);

  const apply = () => {
    // system+dark → :root (Dusk — softer default, no attribute)
    // explicit dark → data-theme="dark" (Ink — the hard choice)
    if (theme === "system" && resolved === "dark") {
      document.documentElement.removeAttribute("data-theme");
    } else if (resolved === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.setAttribute("data-theme", resolved);
    }
    // Toggle native vibrancy for Liquid Glass
    const vibrancy = resolved === "glass" ? "under-window" : null;
    window.electronAPI?.invoke("set_vibrancy", { vibrancy }).catch(() => {});
    // Switch dock icon variant
    setAppTheme(resolved);
  };

  // Use View Transitions API for a smooth crossfade between themes.
  // Falls back to instant apply if the API isn't available.
  if ("startViewTransition" in document) {
    const transition = (document as Document & { startViewTransition(cb: () => void): { finished: Promise<void> } }).startViewTransition(apply);
    // Style the transition: soft crossfade, no movement
    const style = document.createElement("style");
    style.textContent = `
      ::view-transition-old(root) {
        animation: 350ms ease-out both fade-out;
      }
      ::view-transition-new(root) {
        animation: 350ms ease-in both fade-in;
      }
      @keyframes fade-out { to { opacity: 0; } }
      @keyframes fade-in { from { opacity: 0; } }
    `;
    document.head.appendChild(style);
    transition.finished.then(() => style.remove()).catch(() => style.remove());
  } else {
    apply();
  }
}

function createWorkspaceStore() {
  return create<WorkspaceState>()((set, get) => ({
    fontSize: DEFAULT_FONT_SIZE,
    panelFontSize: DEFAULT_PANEL_FONT_SIZE,
    editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
    fontWeight: DEFAULT_FONT_WEIGHT,
    keybindings: null,
    theme: "system" as Theme,
    completionSound: "none",
    selectedModel: "stepfun/step-3.5-flash:free",
    selectedModelProvider: "openrouter",
    selectedModelThinking: true,
    punkBackend: "api",
    httpProvider: "openrouter",
    httpApiKeys: {},
    httpBaseUrls: {},
    disabledProviders: [],
    setDisabledProviders: (providers) => set({ disabledProviders: providers }),
    toggleProvider: (provider) => {
      const current = get().disabledProviders;
      const next = current.includes(provider)
        ? current.filter((p) => p !== provider)
        : [...current, provider];
      set({ disabledProviders: next });
    },
    isProviderEnabled: (provider) => !get().disabledProviders.includes(provider),
    powerCombo: DEFAULT_POWER_COMBO,
    autoEscalate: true,
    openRouterModels: [],
    allModels: {},
    fetchOpenRouterModels: async () => {
      try {
        const models = await getOpenRouterModels();
        set({ 
          openRouterModels: models,
          allModels: { ...get().allModels, openrouter: models }
        });
      } catch (err) {
        console.error("Failed to fetch OpenRouter models:", err);
      }
    },
    fetchAllModels: async () => {
      try {
        const models = await getAllModels();
        set({ 
          allModels: models,
          openRouterModels: models.openrouter || []
        });
      } catch (err) {
        console.error("Failed to fetch all models:", err);
      }
    },
    refreshAllModels: async () => {
      try {
        const models = await refreshAllModels();
        set({ 
          allModels: models,
          openRouterModels: models.openrouter || []
        });
      } catch (err) {
        console.error("Failed to refresh all models:", err);
      }
    },
    // Backend availability for transparent routing
    backendAvailability: {
      claudeCode: false,
      geminiCli: false,
      api: true, // Always available
    },
    setBackendAvailability: (availability) => 
      set({ 
        backendAvailability: { 
          ...get().backendAvailability, 
          ...availability 
        } 
      }),
    // SDK metadata
    sdkModels: null,
    sdkAccount: null,
    setSdkInfo: (models, account) => set({ sdkModels: models, sdkAccount: account }),
    rateLimitInfo: null,
    setRateLimitInfo: (info) => {
      // Persist to localStorage so the Profile session bar survives app restarts.
      // rate_limit_event only fires on message send — without this, the bar is
      // always 0% on cold open until the first message goes out.
      try {
        if (info) {
          localStorage.setItem("pane:rateLimitInfo", JSON.stringify(info));
        } else {
          localStorage.removeItem("pane:rateLimitInfo");
        }
      } catch {}
      set({ rateLimitInfo: info });
    },
    lastTokenUsageAt: 0,
    increaseFontSize: () =>
      set((state) => {
        const next = Math.max(1, state.fontSize + 1);
        applyFontSize(next);
        return { fontSize: next };
      }),
    decreaseFontSize: () =>
      set((state) => {
        const next = Math.max(1, state.fontSize - 1);
        applyFontSize(next);
        return { fontSize: next };
      }),
    resetFontSize: () => {
      applyFontSize(DEFAULT_FONT_SIZE);
      return set({ fontSize: DEFAULT_FONT_SIZE });
    },
    setFontSize: (size: number) => {
      const s = Math.max(1, size);
      applyFontSize(s);
      return set({ fontSize: s });
    },
    increasePanelFontSize: () =>
      set((state) => {
        const next = Math.max(1, state.panelFontSize + 1);
        applyPanelFontSize(next);
        return { panelFontSize: next };
      }),
    decreasePanelFontSize: () =>
      set((state) => {
        const next = Math.max(1, state.panelFontSize - 1);
        applyPanelFontSize(next);
        return { panelFontSize: next };
      }),
    resetPanelFontSize: () => {
      applyPanelFontSize(DEFAULT_PANEL_FONT_SIZE);
      return set({ panelFontSize: DEFAULT_PANEL_FONT_SIZE });
    },
    setPanelFontSize: (size: number) => {
      const s = Math.max(1, size);
      applyPanelFontSize(s);
      return set({ panelFontSize: s });
    },
    increaseEditorFontSize: () =>
      set((state) => ({
        editorFontSize: Math.max(1, state.editorFontSize + 1),
      })),
    decreaseEditorFontSize: () =>
      set((state) => ({
        editorFontSize: Math.max(1, state.editorFontSize - 1),
      })),
    resetEditorFontSize: () =>
      set({ editorFontSize: DEFAULT_EDITOR_FONT_SIZE }),
    setEditorFontSize: (size: number) =>
      set({ editorFontSize: Math.max(1, size) }),
    increaseFontWeight: () =>
      set((state) => {
        const next = Math.min(900, state.fontWeight + 100);
        applyFontWeight(next);
        return { fontWeight: next };
      }),
    decreaseFontWeight: () =>
      set((state) => {
        const next = Math.max(100, state.fontWeight - 100);
        applyFontWeight(next);
        return { fontWeight: next };
      }),
    resetFontWeight: () => {
      applyFontWeight(DEFAULT_FONT_WEIGHT);
      return set({ fontWeight: DEFAULT_FONT_WEIGHT });
    },
    setFontWeight: (weight: number) => {
      const w = Math.max(100, Math.min(900, weight));
      applyFontWeight(w);
      return set({ fontWeight: w });
    },
    setKeybinding: (id, binding) =>
      set((state) => ({
        keybindings: { ...(state.keybindings ?? {}), [id]: binding },
      })),
    resetKeybinding: (id) =>
      set((state) => {
        if (!state.keybindings) return {};
        const next = { ...state.keybindings };
        delete next[id];
        return { keybindings: Object.keys(next).length > 0 ? next : null };
      }),
    resetAllKeybindings: () => set({ keybindings: null }),
    setKeybindingsRaw: (kb) => set({ keybindings: kb }),
    toggleTheme: () =>
      set((state) => {
        const cycle: Record<Theme, Theme> = {
          system: "dark",
          dark: "light",
          light: "pure",
          pure: "glass",
          glass: "system",
        };
        const next = cycle[state.theme];
        applyTheme(next);
        return { theme: next };
      }),
    setTheme: (theme: Theme) => {
      applyTheme(theme);
      return set({ theme });
    },
    setCompletionSound: (sound: string) => set({ completionSound: sound }),
    playCompletionSound: () => {
      const { completionSound } = get();
      if (completionSound === "none") return;
      window.electronAPI.invoke("play_sound", {
        sound: completionSound,
      });
    },
    setSelectedModel: (
      model: string,
      thinking: boolean = false,
      provider?: string,
    ) =>
      set((state) => ({
        selectedModel: model,
        selectedModelThinking: thinking,
        selectedModelProvider: provider || state.selectedModelProvider,
      })),
    setPunkBackend: (backend: string) => set({ punkBackend: backend }),
    setHttpProvider: (provider: string) => set({ httpProvider: provider }),
    setHttpApiKeys: (keys: Record<string, string>) => {
      set({ httpApiKeys: keys });
      // If openrouter key was just added/changed, fetch models
      if (keys["openrouter"]) {
        get().fetchOpenRouterModels();
      }
    },
    setHttpBaseUrls: (urls: Record<string, string>) =>
      set({ httpBaseUrls: urls }),
    getEffectiveCombo: () => get().powerCombo,
    setPowerCombo: (combo) => {
      if (!combo) return;
      set({ powerCombo: combo });
    },
    setAutoEscalate: (autoEscalate) => set({ autoEscalate }),
  }));
}

// Vite HMR context — typed inline since the Vite types are optional at runtime
interface ViteHotContext {
  data: Record<string, unknown>;
}
interface ViteImportMeta {
  hot?: ViteHotContext;
}

// Preserve store across HMR — prevents state loss and stale subscriptions
export const useWorkspaceStore: ReturnType<typeof createWorkspaceStore> =
  ((import.meta as unknown as ViteImportMeta).hot?.data?.__WORKSPACE_STORE__ as ReturnType<typeof createWorkspaceStore> | undefined) ??
  (() => {
    const store = createWorkspaceStore();
    if ((import.meta as unknown as ViteImportMeta).hot) {
      (import.meta as unknown as ViteImportMeta).hot!.data.__WORKSPACE_STORE__ = store;
    }
    return store;
  })();

// Listen for background model updates from the main process
window.electronAPI.on("pane:models-updated", (raw: unknown) => {
  const models = raw as Record<string, import("../lib/tauri-commands").OpenRouterModel[]> | undefined;
  useWorkspaceStore.setState({
    allModels: models ?? {},
    openRouterModels: models?.openrouter ?? []
  });
});

// Listen for SDK auth info — arrives from prefetch before any project is active.
// Also fires on logout (account: null) so the Profile UI reflects sign-out immediately.
window.electronAPI.on("pane-sdk-auth", (raw: unknown) => {
  const data = raw as { account?: Record<string, unknown> | null; models?: unknown[] | null } | null;
  const hasAccount = data?.account != null;
  const hasModels  = data?.models  != null;

  if (hasAccount || hasModels) {
    // New auth info arrived — update account/models only.
    // Rate limit clearing is handled session-scoped in handleEvent's sdk_init_info case.
    useWorkspaceStore.getState().setSdkInfo(
      (data?.models as import("../lib/punk-types").SdkModel[] | null) ?? null,
      (data?.account as import("../lib/punk-types").SdkAccount | null) ?? null
    );
  } else {
    // Explicit null broadcast (logout) — clear account and stale usage indicators
    useWorkspaceStore.getState().setSdkInfo(null, null);
    useWorkspaceStore.getState().setRateLimitInfo(null);
  }
});

// Hydrate rateLimitInfo from localStorage on startup — without this the
// Profile session bar shows 0% until the first message fires a rate_limit_event.
// Only restore if the reset window is still in the future; expired data is dropped.
try {
  const raw = localStorage.getItem("pane:rateLimitInfo");
  if (raw) {
    const stored = JSON.parse(raw) as import("../lib/punk-types").RateLimitInfo;
    const resetsAt = stored?.resetsAt ?? stored?.overageResetsAt;
    if (resetsAt && resetsAt * 1000 > Date.now()) {
      useWorkspaceStore.getState().setRateLimitInfo(stored);
    } else {
      localStorage.removeItem("pane:rateLimitInfo");
    }
  }
} catch {}

// Listen for OS theme changes — re-apply when in system mode
const systemMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
systemMediaQuery.addEventListener("change", () => {
  const { theme } = useWorkspaceStore.getState();
  if (theme === "system") {
    applyTheme("system");
  }
});

// Apply system theme on initial load
applyTheme("system");
