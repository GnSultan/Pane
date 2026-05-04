import { create } from "zustand";
import type { ReviewFinding } from "../lib/tauri-commands";
import { findingsList, dismissFinding as dismissBackend } from "../lib/tauri-commands";

export type PunkStatus = "idle" | "running" | "completed" | "failed";

export interface PunkState {
  name: string;
  displayName: string;
  role: string;
  color: string;
  status: PunkStatus;
  lastRan: number | null;
  error: string | null;
  scope: string;
  findings: ReviewFinding[];
}

// Pane's existing semantic color tokens — muted, earthy, never bright.
// Only these colors are used across Lens, never foreign hues.
const PANE_COLORS = [
  "#8A9A6C", // status-added     — muted green
  "#B8A56A", // status-modified  — muted amber
  "#7E97AA", // status-renamed   — muted blue
  "#A67272", // status-deleted   — muted red
  "#6D6A63", // status-untracked — muted gray
  "#8AACCA", // terminal accent  — muted steel
] as const;

// Default built-in punks pick from Pane's palette.
const DEFAULT_PUNKS: Record<string, Pick<PunkState, "displayName" | "role" | "color">> = {
  ash:   { displayName: "Ash",   role: "flow analyst",       color: PANE_COLORS[1] }, // modified — amber, fits ash
  ghost: { displayName: "Ghost", role: "penetration tester", color: PANE_COLORS[2] }, // renamed   — blue, trust boundaries
  sage:  { displayName: "Sage",  role: "ux analyst",         color: PANE_COLORS[0] }, // added     — green, growth/wisdom
};

/** Pick a Pane color deterministically from name hash — never generates foreign hues. */
function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return PANE_COLORS[Math.abs(hash) % PANE_COLORS.length]!;
}

interface LensState {
  punks: Record<string, PunkState>;
  loaded: boolean;
  setPunkStatus: (name: string, status: PunkStatus, error?: string | null) => void;
  setPunkScope: (name: string, scope: string) => void;
  addPunkFindings: (name: string, findings: ReviewFinding[], checkPrevious?: boolean) => void;
  dismissFinding: (name: string, findingId: string) => void;
  /** Add a new punk to the store (if not already present). Returns true if added. */
  addPunk: (name: string, displayName: string, role: string, color?: string) => boolean;
  /** Load existing findings and discover punks from backend. */
  init: (projectId: string) => Promise<void>;
  resetPunks: () => void;
}

function makePunk(name: string, displayName: string, role: string, color: string): PunkState {
  return {
    name,
    displayName,
    role,
    color,
    status: "idle" as PunkStatus,
    lastRan: null,
    error: null,
    scope: "",
    findings: [],
  };
}

function createLensStore() {
  const defaultPunks: Record<string, PunkState> = {};
  for (const [name, meta] of Object.entries(DEFAULT_PUNKS)) {
    defaultPunks[name] = makePunk(name, meta.displayName, meta.role, meta.color);
  }

  return create<LensState>()((set, get) => ({
    punks: defaultPunks,
    loaded: false,

    setPunkStatus: (name, status, error = null) =>
      set((s) => {
        const current = s.punks[name];
        if (!current) return {};
        const updated: PunkState = {
          ...current,
          status,
          error,
          lastRan:
            status === "running"
              ? current.lastRan
              : status === "completed" || status === "failed"
                ? Date.now()
                : current.lastRan,
        };
        return {
          punks: {
            ...s.punks,
            [name]: updated,
          },
        };
      }),

    setPunkScope: (name, scope) =>
      set((s) => {
        const current = s.punks[name];
        if (!current) return {};
        const updated: PunkState = { ...current, scope };
        return {
          punks: {
            ...s.punks,
            [name]: updated,
          },
        };
      }),

    addPunkFindings: (name, findings, checkPrevious = false) =>
      set((s) => {
        const current = s.punks[name];
        const existing = current?.findings ?? [];
        const existingIds = new Set(existing.map((f) => f.id));
        const newOnes = findings.filter((f) => !existingIds.has(f.id));
        const merged: PunkState = {
          ...(current ?? makePunk(name, name, "", hashColor(name))),
          findings: checkPrevious ? [...newOnes, ...existing] : [...existing, ...newOnes],
        };
        return {
          punks: {
            ...s.punks,
            [name]: merged,
          },
        };
      }),

    dismissFinding: (_name, findingId) =>
      set((s) => {
        dismissBackend(findingId).catch(() => {});
        const updated: Record<string, PunkState> = {};
        for (const [k, v] of Object.entries(s.punks)) {
          updated[k] = { ...v, findings: v.findings.filter((f) => f.id !== findingId) };
        }
        return { punks: updated };
      }),

    addPunk: (name, displayName, role, color) => {
      const existing = get().punks[name];
      if (existing) return false;
      set((s) => ({
        punks: {
          ...s.punks,
          [name]: makePunk(name, displayName, role, color ?? hashColor(name)),
        },
      }));
      return true;
    },

    init: async (projectId) => {
      if (!projectId) return;

      let findings: ReviewFinding[] = [];
      try {
        const result = await findingsList(projectId, 100);
        findings = result.findings ?? [];
      } catch {
        // Database might not be ready yet
      }

      set((s) => {
        const updated: Record<string, PunkState> = {};
        for (const [name, punk] of Object.entries(s.punks)) {
          updated[name] = { ...punk };
        }
        for (const f of findings) {
          if (!updated[f.punk]) {
            updated[f.punk] = makePunk(f.punk, f.punk, "", hashColor(f.punk));
          }
        }
        const byPunk: Record<string, ReviewFinding[]> = {};
        for (const f of findings) {
          let bucket = byPunk[f.punk];
          if (!bucket) {
            bucket = [];
            byPunk[f.punk] = bucket;
          }
          bucket.push(f);
        }
        for (const name of Object.keys(updated)) {
          const target = updated[name];
          if (target) {
            target.findings = byPunk[name] ?? [];
          }
        }
        return { punks: updated, loaded: true };
      });
    },

    resetPunks: () => {
      const current = get().punks;
      const reset: Record<string, PunkState> = {};
      for (const [name, punk] of Object.entries(current)) {
        reset[name] = { ...punk, status: "idle" as PunkStatus, error: null, scope: "" };
      }
      set({ punks: reset });
    },
  }));
}

interface ViteHotContext {
  data: Record<string, unknown>;
}
interface ViteImportMeta {
  hot?: ViteHotContext;
}

// Preserve store across HMR
export const useLensStore: ReturnType<typeof createLensStore> =
  ((import.meta as unknown as ViteImportMeta).hot?.data?.__LENS_STORE__ as ReturnType<typeof createLensStore> | undefined) ??
  (() => {
    const store = createLensStore();
    if ((import.meta as unknown as ViteImportMeta).hot) {
      (import.meta as unknown as ViteImportMeta).hot!.data.__LENS_STORE__ = store;
    }
    return store;
  })();
