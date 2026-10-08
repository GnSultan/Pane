/**
 * VoiceProvider — the single, global voice session.
 *
 * One useRealtimeVoice for all of Pane. Before the Aug 2026 lift, each
 * thread's Conversation mounted its own session — switching threads killed
 * the mic, orphaned the orb, pinned delegation to the birth thread, and
 * each thread's own loop stomped the shared voiceLight signal to "off".
 * Now the session lives at the app root: it survives thread switches, the
 * orb reads it from every thread's InputBar, and the floor glow mounts
 * once above all thread layers so ambient light follows the voice, not
 * the thread.
 *
 * Delegation is thread-aware: delegate_task may name ANY thread. The
 * provider switches Pane to that thread (so the user watches the work
 * land), delivers the instruction through that thread's own send path
 * (pane:send-message — the same event EmptyState uses for a thread's
 * first message), and the voice session watches that thread to report
 * completion.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useProjectsStore, type Project } from "../stores/projects";
import { useRealtimeVoice } from "../hooks/useRealtimeVoice";

type DelegateFn = (
  instruction: string,
  phase: "think" | "build",
  thread?: string,
) => string | null;

interface VoiceContextValue {
  state: ReturnType<typeof useRealtimeVoice>["state"];
  error: string | null;
  transcript: string;
  lastSpoken: string;
  micStream: MediaStream | null;
  micDevices: Array<{ deviceId: string; label: string }>;
  activeMicId: string | null;
  audioPulseRef: { current: number };
  modelAnalyserRef: { current: AnalyserNode | null };
  toggle: () => void;
  interrupt: () => void;
  onSelectMic: (deviceId: string) => void;
  onRefreshMics: () => void;
  pushAgentStatus: (force?: boolean) => void;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

/** Deliver a message to ANY thread through its own send path. */
function sendToThread(projectId: string, message: string, phase?: string): void {
  window.dispatchEvent(
    new CustomEvent("pane:send-message", {
      detail: { projectId, message, phase },
    }),
  );
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  // Resolve a thread NAME → projectId. Exact match first, then unique
  // contains / word-prefix (spoken names are fuzzy). Null when nothing
  // matches — the model is told to say the name exactly.
  const resolveThread = useCallback((name?: string): string | null => {
    const store = useProjectsStore.getState();
    const id = store.activeProjectId;
    if (!name || !name.trim()) {
      return id; // no name = the open thread
    }
    const q = name.trim().toLowerCase();
    const projects: Project[] = Array.from(useProjectsStore.getState().projects.values());
    // 1. exact (case-insensitive)
    let hit = projects.find((p) => p.name.toLowerCase() === q);
    // 2. contains, unique
    if (!hit) {
      const contains = projects.filter((p) => p.name.toLowerCase().includes(q));
      if (contains.length === 1) hit = contains[0];
    }
    // 3. word-prefix, unique — "invoice" matches "invoice site revamp"
    if (!hit) {
      const starts = projects.filter((p) =>
        p.name.toLowerCase().split(/[\s\-_/]+/).some((w) => w.startsWith(q)),
      );
      if (starts.length === 1) hit = starts[0];
    }
    return hit?.id ?? null;
  }, []);

  const onDelegate = useCallback<DelegateFn>(
    (instruction, phase, thread) => {
      const target = resolveThread(thread);
      if (!target) return null;
      // Switch Pane to the target thread so the user watches the work land.
      const store = useProjectsStore.getState();
      const alreadyActive = store.activeProjectId === target;
      if (!alreadyActive) store.setActiveProject(target);
      // Deliver through the target thread's own send path. DEFERRED: a
      // never-opened thread mounts its Conversation asynchronously
      // (startTransition in ConversationLayer) — a synchronous dispatch
      // fires before any listener exists and the instruction is lost.
      // Same pattern EmptyState uses for a thread's first message.
      window.setTimeout(() => sendToThread(target, instruction, phase), alreadyActive ? 0 : 250);
      return target;
    },
    [resolveThread],
  );

  const voice = useRealtimeVoice({ onDelegate });

  const value = useMemo<VoiceContextValue>(
    () => ({
      state: voice.state,
      error: voice.error,
      transcript: voice.transcript,
      lastSpoken: voice.lastSpoken,
      micStream: voice.micStream,
      micDevices: voice.micDevices,
      activeMicId: voice.activeMicId,
      audioPulseRef: voice.audioPulseRef,
      modelAnalyserRef: voice.modelAnalyserRef,
      toggle: () => void voice.toggle(),
      interrupt: voice.interrupt,
      onSelectMic: voice.selectMic,
      onRefreshMics: () => void voice.refreshMicDevices(),
      pushAgentStatus: voice.pushAgentStatus,
    }),
    [
      voice.state,
      voice.error,
      voice.transcript,
      voice.lastSpoken,
      voice.micStream,
      voice.micDevices,
      voice.activeMicId,
      voice.toggle,
      voice.interrupt,
      voice.selectMic,
      voice.refreshMicDevices,
      voice.pushAgentStatus,
      voice.audioPulseRef,
      voice.modelAnalyserRef,
    ],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceContextValue | null {
  return useContext(VoiceContext);
}
