import { create } from "zustand";
import type { ReviewFinding, ReviewSession } from "../lib/tauri-commands";

interface ReviewState {
  session: ReviewSession | null;
  findings: ReviewFinding[];
  running: boolean;
  progress: Record<string, "pending" | "running" | "done" | "failed">;

  setSession: (session: ReviewSession | null) => void;
  setFindings: (findings: ReviewFinding[]) => void;
  setRunning: (running: boolean) => void;
  setProgress: (punk: string, status: "pending" | "running" | "done" | "failed") => void;
  setAllProgress: (progress: Record<string, "pending" | "running" | "done" | "failed">) => void;
  reset: () => void;
}

export const useReviewStore = create<ReviewState>((set) => ({
  session: null,
  findings: [],
  running: false,
  progress: {},

  setSession: (session) => set({ session }),
  setFindings: (findings) => set({ findings }),
  setRunning: (running) => set({ running }),
  setProgress: (punk, status) =>
    set((state) => ({
      progress: { ...state.progress, [punk]: status },
    })),
  setAllProgress: (progress) => set({ progress }),
  reset: () => set({ session: null, findings: [], running: false, progress: {} }),
}));
