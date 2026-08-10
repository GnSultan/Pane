import { useState, useRef, useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectsStore } from "../stores/projects";
import type { ElectronAPI } from "../lib/electron";

const electronAPI = window.electronAPI as ElectronAPI;

// navigator.platform is the renderer-safe way to detect OS (process.platform
// is undefined in the browser context). Matches the pattern in Profile.tsx.
const IS_MAC = navigator.platform.includes("Mac");

// Click vs drag threshold (px). If the pointer moves less than this between
// mousedown and mouseup, it's a click (switch thread). Otherwise it's a drag
// (move window). 5px matches macOS native drag threshold.
const DRAG_THRESHOLD = 5;

// Activity window — threads active within this period show as tabs.
const ACTIVITY_WINDOW_MS = 30 * 60_000; // 30 minutes

/** Slow three-dot processing indicator — matches ProjectList's ProcessingDots. */
function ProcessingDots() {
  return (
    <span className="inline-flex items-center gap-[3px] shrink-0">
      <span className="processing-dot w-[3px] h-[3px] rounded-full bg-pane-text-secondary/40" />
      <span
        className="processing-dot w-[3px] h-[3px] rounded-full bg-pane-text-secondary/40"
        style={{ animationDelay: "0.4s" }}
      />
      <span
        className="processing-dot w-[3px] h-[3px] rounded-full bg-pane-text-secondary/40"
        style={{ animationDelay: "0.8s" }}
      />
    </span>
  );
}

interface TabProps {
  id: string;
  name: string;
  isActive: boolean;
  isProcessing: boolean;
  hasUnread: boolean;
  onSelect: (id: string) => void;
}

/**
 * A single tab button. The entire tab surface is both clickable (switch
 * thread) and draggable (move window) via a movement-threshold heuristic:
 *
 * mousedown → record screen coords → attach pointermove
 *   move < 5px then mouseup → CLICK → switch thread
 *   move ≥ 5px               → DRAG  → IPC → main moves window
 *
 * IPC is fire-and-forget (send, not invoke) and throttled via requestAnimationFrame.
 */
const TabButton = ({ id, name, isActive, isProcessing, hasUnread, onSelect }: TabProps) => {
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    isDragging: boolean;
    rafScheduled: boolean;
  } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Only left button initiates drag/click
      if (e.button !== 0) return;

      const startX = e.screenX;
      const startY = e.screenY;

      dragStateRef.current = {
        startX,
        startY,
        isDragging: false,
        rafScheduled: false,
      };

      // Capture so we keep getting pointermove/up even if cursor leaves the tab
      e.currentTarget.setPointerCapture(e.pointerId);

      const onPointerMove = (ev: PointerEvent) => {
        const st = dragStateRef.current;
        if (!st) return;

        const dx = ev.screenX - st.startX;
        const dy = ev.screenY - st.startY;

        if (!st.isDragging) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
            return;
          // Crossed threshold — begin window drag
          st.isDragging = true;
          electronAPI.send("window-drag-start");
        }

        // Throttle IPC to one per animation frame
        if (!st.rafScheduled) {
          st.rafScheduled = true;
          requestAnimationFrame(() => {
            st.rafScheduled = false;
            electronAPI.send("window-drag-move");
          });
        }
      };

      const onPointerUp = (ev: PointerEvent) => {
        const st = dragStateRef.current;
        dragStateRef.current = null;

        // Clean up listeners
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);

        if (st?.isDragging) {
          electronAPI.send("window-drag-end");
        } else {
          // Didn't cross threshold → it's a click
          onSelect(id);
        }

        // Release capture
        try {
          (
            e.currentTarget as HTMLButtonElement
          ).releasePointerCapture(ev.pointerId);
        } catch {
          // pointerId may already be released
        }
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [id, onSelect],
  );

  return (
    <button
      onPointerDown={handlePointerDown}
      className={`flex-1 min-w-0 h-7 mx-0.5 flex items-center gap-1.5 px-2 rounded-md transition-colors ${
        isActive
          ? "bg-pane-accent-tab text-pane-text"
          : "bg-pane-inactive-tab text-pane-text-secondary/50 hover:text-pane-text-secondary/80"
      }`}
      title={name}
    >
      {isProcessing && <ProcessingDots />}
      <span
        className="truncate font-medium flex-1 text-left"
        style={{ fontSize: "var(--pane-panel-font-size-xs)" }}
      >
        {name}
      </span>
      {hasUnread && !isProcessing && (
        <span className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-pane-status-added" />
      )}
    </button>
  );
};

/**
 * Active thread tabs — shown in the titlebar drag region when the sidebar is
 * collapsed. Each tab is clickable (switch thread) and the surface is also
 * draggable (move window) via a movement-threshold heuristic.
 *
 * Tabs are divided equally: 1 = full width, 2 = half each, etc.
 * Only threads active within the last 30 minutes (or currently processing)
 * are shown.
 */
export function ActiveThreadTabs() {
  // Collect active threads: processing, recently active (30 min), or unread.
  // The currently active thread is ALWAYS included — you should never see
  // the conversation you're reading disappear from the tabs.
  // useShallow so we only re-render when the actual list changes.
  const activeThreads = useProjectsStore(
    useShallow((s) => {
      const now = Date.now();
      const ids: string[] = [];
      for (const id of s.projectOrder) {
        const p = s.projects.get(id);
        if (!p || p.archived) continue;
        if (
          id === s.activeProjectId ||
          p.conversation.isProcessing ||
          p.hasUnreadCompletion ||
          (p.lastActivityAt !== null &&
            now - p.lastActivityAt < ACTIVITY_WINDOW_MS)
        ) {
          ids.push(id);
        }
      }
      return ids;
    }),
  );

  const setActiveProject = useProjectsStore((s) => s.setActiveProject);

  // Periodic re-check to drop threads that age out of the activity window.
  // The useShallow selector already filters by time, but it only re-runs on
  // store mutations — not on wall-clock passage. This forces a re-render
  // every 60s so the selector re-evaluates.
  const [, forceRender] = useState(0);
  useEffect(() => {
    if (activeThreads.length === 0) return;
    const timer = setInterval(() => forceRender((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [activeThreads.length]);

  if (activeThreads.length === 0) return null;

  return (
    <>
      <style>{`
        .processing-dot {
          animation: pane-tab-dot-pulse 2.4s ease-in-out infinite;
        }
        @keyframes pane-tab-dot-pulse {
          0%, 60%, 100% { opacity: 0.2; }
          30% { opacity: 0.9; }
        }
      `}</style>
      <div
        data-no-drag
        className="flex items-center h-full"
        style={{
          // On macOS, traffic lights are at {x:16, y:18} and occupy ~70px.
          paddingLeft: IS_MAC ? "80px" : "0",
          // Match the workspace's pr-2 (8px) edge inset — same gap
          // ThreadPanel's active highlight has from its panel edges.
          paddingRight: "8px",
        }}
      >
        {activeThreads.map((id) => (
          <ThreadTab key={id} projectId={id} onSelect={setActiveProject} />
        ))}
      </div>
    </>
  );
}

/**
 * Wrapper that subscribes to individual project fields so only the affected
 * tab re-renders when its name or processing state changes — not the whole bar.
 */
function ThreadTab({
  projectId,
  onSelect,
}: {
  projectId: string;
  onSelect: (id: string) => void;
}) {
  const name = useProjectsStore((s) => s.projects.get(projectId)?.name ?? "");
  const isActive = useProjectsStore((s) => s.activeProjectId === projectId);
  const isProcessing = useProjectsStore(
    (s) => s.projects.get(projectId)?.conversation.isProcessing ?? false,
  );
  const hasUnread = useProjectsStore(
    (s) => s.projects.get(projectId)?.hasUnreadCompletion ?? false,
  );

  return (
    <TabButton
      id={projectId}
      name={name}
      isActive={isActive}
      isProcessing={isProcessing}
      hasUnread={hasUnread}
      onSelect={onSelect}
    />
  );
}
