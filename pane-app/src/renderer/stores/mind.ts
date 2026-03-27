import { create } from "zustand";
import type { MindEntry } from "../lib/tauri-commands";

interface MindState {
  chatEntryId: string | null;
  entries: MindEntry[];
  threadEntryIds: Set<string>;
  // Maps entry id → workerType so the findings strip can label each row
  unreadThreadEntryIds: Map<string, string>;
  loaded: boolean;

  setChatEntryId: (id: string | null) => void;
  setEntries: (entries: MindEntry[]) => void;
  addEntry: (entry: MindEntry) => void;
  updateEntry: (id: string, entry: MindEntry) => void;
  removeEntry: (id: string) => void;
  setThreadEntryIds: (ids: Set<string>) => void;
  addUnreadThread: (id: string, workerType: string) => void;
  setLoaded: (loaded: boolean) => void;
}

function createMindStore() {
  return create<MindState>()((set) => ({
    chatEntryId: null,
    entries: [],
    threadEntryIds: new Set(),
    unreadThreadEntryIds: new Map(),
    loaded: false,

    setChatEntryId: (id) =>
      set((state) => {
        const unreadThreadEntryIds = new Map(state.unreadThreadEntryIds);
        if (id) unreadThreadEntryIds.delete(id);
        return { chatEntryId: id, unreadThreadEntryIds };
      }),

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

    addUnreadThread: (id, workerType) =>
      set((state) => {
        const unreadThreadEntryIds = new Map(state.unreadThreadEntryIds);
        unreadThreadEntryIds.set(id, workerType);
        return { unreadThreadEntryIds };
      }),

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
