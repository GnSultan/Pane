import { useEffect, useRef, useState, useCallback, memo } from "react";
import { Conversation } from "./Conversation";
import { FileExplorer } from "./FileExplorer";
import { Terminal } from "./Terminal";
import { Profile } from "./Profile";
import { Mind } from "./Mind";
import { ChangeHistoryPanel } from "./ChangeHistoryPanel";
import { GitStatus } from "../ControlPanel/GitStatus";
import { useProjectsStore } from "../../stores/projects";
import { useWorkspaceStore } from "../../stores/workspace";
import { detectProjectRoot } from "../../lib/tauri-commands";

import type { ElectronAPI } from '../../lib/electron';

const electronAPI = window.electronAPI as ElectronAPI;

// Per-project scroll cache — measured while visible, restored before reveal.
// Sentinel 1e9 means "pin to bottom": browser clamps to max scrollable.
const scrollCache = new Map<string, number>();

// Visibility is toggled via direct DOM manipulation — bypasses React entirely.
// The Conversation inside is memo'd + never subscribes to activeProjectId,
// so switching projects triggers zero re-renders in the conversation subtree.
const ConversationLayer = memo(function ConversationLayer({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const initiallyActive = useProjectsStore.getState().activeProjectId === projectId;

  useEffect(() => {
    let rafId = 0;

    const hide = () => {
      if (!ref.current) return;
      const scrollEl = ref.current.querySelector<HTMLDivElement>("[data-conv-scroll]");
      if (scrollEl) {
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        scrollCache.set(projectId, scrollHeight - scrollTop - clientHeight < 10 ? 1e9 : scrollTop);
      }
      // opacity bypasses paint — goes straight to compositor, disappears this frame.
      // visibility:hidden queues a repaint, leaving the old layer visible for 1-2 extra frames.
      ref.current.style.opacity = "0";
      ref.current.style.pointerEvents = "none";
    };

    const show = () => {
      if (!ref.current) return;
      const scrollEl = ref.current.querySelector<HTMLDivElement>("[data-conv-scroll]");
      if (scrollEl) scrollEl.scrollTop = scrollCache.get(projectId) ?? 1e9;
      ref.current.style.opacity = "1";
      ref.current.style.pointerEvents = "";
    };

    const apply = (activeId: string | null, instant: boolean) => {
      cancelAnimationFrame(rafId);
      if (activeId === projectId) {
        if (instant) { show(); return; }
        // Deliberate 1-frame blank: old layer hid this frame, new appears next frame.
        // The brief workspace background visible between them reads as navigation, not replacement.
        rafId = requestAnimationFrame(show);
      } else {
        hide();
      }
    };

    apply(useProjectsStore.getState().activeProjectId, true);
    return useProjectsStore.subscribe((state, prev) => {
      if (state.activeProjectId !== prev.activeProjectId) apply(state.activeProjectId, false);
    });
  }, [projectId]);

  return (
    <div ref={ref} className="absolute inset-0 flex" style={{ opacity: initiallyActive ? 1 : 0, pointerEvents: initiallyActive ? "auto" : "none" }}>
      <Conversation projectId={projectId} />
    </div>
  );
});

function ProjectTerminal({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  if (!root) return null;
  return <Terminal projectId={projectId} workingDir={root} />;
}

// Lazy keep-alive: mounts on first open, stays mounted (hidden) after.
// Avoids paying mount cost on every open, but doesn't burn hooks when never used.
function LazyKeepAlive({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [everOpened, setEverOpened] = useState(false);
  if (open && !everOpened) setEverOpened(true);
  if (!everOpened) return null;
  return (
    <div className={`absolute inset-0 ${!open ? "hidden" : ""}`}>
      {children}
    </div>
  );
}

// Empty state — shown when no threads exist.
// Centered input: type what you're working on → directory picker → thread created → message sent.
function EmptyState() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addProject = useProjectsStore((s) => s.addProject);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = value.trim();
    // Open directory picker
    const selected = await electronAPI.invoke("open-directory-dialog");
    if (!selected || typeof selected !== "string") return;

    const root = await detectProjectRoot(selected);
    const projectId = addProject(root);

    // If user typed something, send it as the first message after a tick
    // (let the conversation mount first)
    if (text) {
      setTimeout(() => {
        const store = useProjectsStore.getState();
        const project = store.projects.get(projectId);
        if (project) {
          // Dispatch a custom event that Conversation's InputBar can pick up,
          // or directly call the send function via the store
          window.dispatchEvent(new CustomEvent("pane:send-message", {
            detail: { projectId, message: text }
          }));
        }
      }, 200);
    }
  }, [value, addProject]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div className="absolute inset-0 flex items-center justify-center" data-no-drag>
      <div className="w-full max-w-xl px-10">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="what are you working on"
          rows={1}
          className="w-full bg-transparent text-pane-text font-mono resize-none outline-none placeholder:text-pane-text-secondary/40 leading-relaxed"
          style={{ fontSize: "var(--pane-font-size)" }}
        />
      </div>
    </div>
  );
}

function GitView({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root);
  if (!root) return null;
  return <GitStatus root={root} projectId={projectId} />;
}

export function Workspace() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const overlay = useWorkspaceStore((s) => s.overlay);
  const activeMode = useProjectsStore((s) => {
    if (!s.activeProjectId) return "conversation" as const;
    return s.projects.get(s.activeProjectId)?.mode ?? "conversation";
  });

  return (
    <div className="h-full relative bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden">
      {/* Empty state — no threads yet */}
      {projectOrder.length === 0 && overlay === null && (
        <EmptyState />
      )}

      <div className={`absolute inset-0 ${overlay !== null || activeMode !== "conversation" ? "hidden" : ""}`}>
        {projectOrder.map((id) => (
          <ConversationLayer key={id} projectId={id} />
        ))}
      </div>

      <div className={`absolute inset-0 flex flex-col ${overlay !== null || activeMode !== "viewer" ? "hidden" : ""}`}>
        <FileExplorer />
      </div>

      <div className={`absolute inset-0 flex ${overlay !== null || activeMode !== "terminal" ? "hidden" : ""}`}>
        {projectOrder.map((id) => (
          <div
            key={id}
            className="flex-1 min-h-0 min-w-0 flex flex-col"
            style={{ display: id === activeProjectId ? "flex" : "none" }}
          >
            <ProjectTerminal projectId={id} />
          </div>
        ))}
      </div>

      {/* Git — a proper workspace mode, not an overlay */}
      <div className={`absolute inset-0 flex flex-col ${overlay !== null || activeMode !== "git" ? "hidden" : ""}`}>
        {projectOrder.map((id) => (
          <div
            key={id}
            className="absolute inset-0 flex flex-col"
            style={{ display: id === activeProjectId ? "flex" : "none" }}
          >
            <GitView projectId={id} />
          </div>
        ))}
      </div>

      <LazyKeepAlive open={overlay === "mind"}>
        <Mind />
      </LazyKeepAlive>

      <LazyKeepAlive open={overlay === "profile"}>
        <Profile />
      </LazyKeepAlive>

      {activeProjectId && (
        <div className={`absolute inset-0 bg-pane-bg z-10 ${overlay !== "history" ? "hidden" : ""}`}>
          <ChangeHistoryPanel
            projectId={activeProjectId}
            onCollapse={() => useWorkspaceStore.getState().setOverlay(null)}
          />
        </div>
      )}

    </div>
  );
}
