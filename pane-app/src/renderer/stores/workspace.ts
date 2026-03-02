import { create } from "zustand";
import type { ActionId, KeyBinding } from "../lib/keybindings";

const DEFAULT_FONT_SIZE = 15;
const DEFAULT_PANEL_FONT_SIZE = 13;
const DEFAULT_EDITOR_FONT_SIZE = 14;
const DEFAULT_FONT_WEIGHT = 400;

type Theme = "dark" | "light" | "pure" | "system";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(theme: Theme): "dark" | "light" | "pure" {
  return theme === "system" ? getSystemTheme() : theme;
}

interface WorkspaceState {
  controlPanelVisible: boolean;
  controlPanelWidth: number;
  fuzzyFinderOpen: boolean;
  fileSearchOpen: boolean;
  fontSize: number;
  panelFontSize: number;
  editorFontSize: number;
  fontWeight: number;
  keybindings: Partial<Record<ActionId, KeyBinding>> | null;
  theme: Theme;
  completionSound: string; // "none" | system sound name | custom file path
  selectedModel: string; // Model alias (e.g., "opus", "sonnet", "haiku") or full model name
  claudeUpdateAvailable: boolean;
  claudeCurrentVersion: string | null;
  claudeNewVersion: string | null;
  checkForClaudeUpdate: () => Promise<void>;
  toggleControlPanel: () => void;
  setControlPanelWidth: (width: number) => void;
  toggleFuzzyFinder: () => void;
  closeFuzzyFinder: () => void;
  toggleFileSearch: () => void;
  closeFileSearch: () => void;
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
  setSelectedModel: (model: string) => void;
}

function applyFontSize(size: number) {
  document.documentElement.style.setProperty("--pane-font-size", `${size}px`);
  document.documentElement.style.setProperty("--pane-font-size-sm", `${size - 3}px`);
  document.documentElement.style.setProperty("--pane-font-size-xs", `${size - 5}px`);
}

function applyPanelFontSize(size: number) {
  document.documentElement.style.setProperty("--pane-panel-font-size", `${size}px`);
  document.documentElement.style.setProperty("--pane-panel-font-size-sm", `${size - 2}px`);
  document.documentElement.style.setProperty("--pane-panel-font-size-xs", `${size - 4}px`);
}

function applyFontWeight(weight: number) {
  document.documentElement.style.setProperty("--pane-font-weight", `${weight}`);
}

function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  if (resolved === "dark") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", resolved);
  }
}

function createWorkspaceStore() {
  return create<WorkspaceState>()((set) => ({
  controlPanelVisible: true,
  controlPanelWidth: 240,
  fuzzyFinderOpen: false,
  fileSearchOpen: false,
  fontSize: DEFAULT_FONT_SIZE,
  panelFontSize: DEFAULT_PANEL_FONT_SIZE,
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
  fontWeight: DEFAULT_FONT_WEIGHT,
  keybindings: null,
  theme: "system" as Theme,
  completionSound: "none",
  selectedModel: "opus",
  claudeUpdateAvailable: false,
  claudeCurrentVersion: null,
  claudeNewVersion: null,
  checkForClaudeUpdate: async () => {
    console.log("[Pane] Checking for Claude updates...");
    const { checkClaudeUpdate } = await import("../lib/tauri-commands");
    const result = await checkClaudeUpdate();
    console.log("[Pane] Update check result:", result);
    if (!result.error && result.updateAvailable) {
      console.log("[Pane] Update available! Setting state...");
      set({
        claudeUpdateAvailable: true,
        claudeCurrentVersion: result.currentVersion,
        claudeNewVersion: result.newVersion,
      });
    } else {
      console.log("[Pane] No update available or error:", result.error);
      set({
        claudeUpdateAvailable: false,
        claudeCurrentVersion: result.currentVersion,
        claudeNewVersion: null,
      });
    }
  },
  toggleControlPanel: () =>
    set((state) => ({
      controlPanelVisible: !state.controlPanelVisible,
    })),
  setControlPanelWidth: (width: number) =>
    set({ controlPanelWidth: Math.max(200, Math.min(480, width)) }),
  toggleFuzzyFinder: () =>
    set((state) => ({ fuzzyFinderOpen: !state.fuzzyFinderOpen })),
  closeFuzzyFinder: () => set({ fuzzyFinderOpen: false }),
  toggleFileSearch: () =>
    set((state) => ({ fileSearchOpen: !state.fileSearchOpen })),
  closeFileSearch: () => set({ fileSearchOpen: false }),
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
    set((state) => ({ editorFontSize: Math.max(1, state.editorFontSize + 1) })),
  decreaseEditorFontSize: () =>
    set((state) => ({ editorFontSize: Math.max(1, state.editorFontSize - 1) })),
  resetEditorFontSize: () => set({ editorFontSize: DEFAULT_EDITOR_FONT_SIZE }),
  setEditorFontSize: (size: number) => set({ editorFontSize: Math.max(1, size) }),
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
        pure: "system",
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
    const { completionSound } = useWorkspaceStore.getState();
    if (completionSound === "none") return;
    (window as any).electronAPI.invoke("play_sound", { sound: completionSound });
  },
  setSelectedModel: (model: string) => set({ selectedModel: model }),
}));
}

// Preserve store across HMR — prevents state loss and stale subscriptions
export const useWorkspaceStore: ReturnType<typeof createWorkspaceStore> =
  (import.meta as any).hot?.data?.__WORKSPACE_STORE__ ??
  (() => {
    const store = createWorkspaceStore();
    if ((import.meta as any).hot) {
      (import.meta as any).hot.data.__WORKSPACE_STORE__ = store;
    }
    return store;
  })();

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
