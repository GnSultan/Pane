import { create } from "zustand";
import type { MindEntry } from "../lib/tauri-commands";

interface MindState {
  entries: MindEntry[];
  // Maps entry id → punkType so the unread dot can label each row
  unreadThreadEntryIds: Map<string, string>;
  loaded: boolean;

  setEntries: (entries: MindEntry[]) => void;
  addEntry: (entry: MindEntry) => void;
  updateEntry: (id: string, entry: MindEntry) => void;
  removeEntry: (id: string) => void;
  setLoaded: (loaded: boolean) => void;
}

function createMindStore() {
  return create<MindState>()((set) => ({
    entries: [],
    unreadThreadEntryIds: new Map(),
    loaded: false,

    setEntries: (entries) => set({ entries }),

    addEntry: (entry) =>
      set((state) => ({ entries: [entry, ...state.entries] })),

    updateEntry: (id, entry) =>
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? entry : e)),
      })),

    removeEntry: (id) =>
      set((state) => ({
        entries: state.entries.filter((e) => e.id !== id),
      })),

    setLoaded: (loaded) => set({ loaded }),
  }));
}

interface ViteHotContext {
  data: Record<string, unknown>;
}
interface ViteImportMeta {
  hot?: ViteHotContext;
}

// Preserve store across HMR
export const useMindStore: ReturnType<typeof createMindStore> =
  ((import.meta as unknown as ViteImportMeta).hot?.data?.__MIND_STORE__ as ReturnType<typeof createMindStore> | undefined) ??
  (() => {
    const store = createMindStore();
    if ((import.meta as unknown as ViteImportMeta).hot) {
      (import.meta as unknown as ViteImportMeta).hot!.data.__MIND_STORE__ = store;
    }
    return store;
  })();
