import { create } from "zustand";
import type { MindEntry } from "../lib/tauri-commands";

interface MindState {
  chatEntryId: string | null;
  entries: MindEntry[];
  threadEntryIds: Set<string>;
  loaded: boolean;

  setChatEntryId: (id: string | null) => void;
  setEntries: (entries: MindEntry[]) => void;
  addEntry: (entry: MindEntry) => void;
  updateEntry: (id: string, entry: MindEntry) => void;
  removeEntry: (id: string) => void;
  setThreadEntryIds: (ids: Set<string>) => void;
  setLoaded: (loaded: boolean) => void;
}

function createMindStore() {
  return create<MindState>()((set) => ({
    chatEntryId: null,
    entries: [],
    threadEntryIds: new Set(),
    loaded: false,

    setChatEntryId: (id) => set({ chatEntryId: id }),

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

    setThreadEntryIds: (ids) => set({ threadEntryIds: ids }),

    setLoaded: (loaded) => set({ loaded }),
  }));
}

// Preserve store across HMR
export const useMindStore: ReturnType<typeof createMindStore> =
  (import.meta as any).hot?.data?.__MIND_STORE__ ??
  (() => {
    const store = createMindStore();
    if ((import.meta as any).hot) {
      (import.meta as any).hot.data.__MIND_STORE__ = store;
    }
    return store;
  })();
