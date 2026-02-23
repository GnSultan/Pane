import { create } from "zustand";

const DEFAULT_FONT_SIZE = 15;
const DEFAULT_PANEL_FONT_SIZE = 13;
const DEFAULT_EDITOR_FONT_SIZE = 14;

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
  theme: Theme;
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
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
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
  theme: "system" as Theme,
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
