import { useEffect, useRef, useState, useCallback, memo, useTransition } from "react";
import { Conversation } from "./Conversation";
import { ConversationPicker } from "./ConversationPicker";
import { ConversationTabBar } from "./ConversationTabBar";
import { FileExplorer } from "./FileExplorer";
import { Terminal } from "./Terminal";
import { Profile } from "./Profile";
import { Mind } from "./Mind";
import { Lens } from "./Lens";
import { ChangeHistoryPanel } from "./ChangeHistoryPanel";
import { FuzzyFinder } from "../FuzzyFinder/FuzzyFinder";
import { FileSearch } from "../FileSearch/FileSearch";
import { GitStatus } from "../ThreadPanel/GitStatus";
import { Menu, type PaneMode } from "../ThreadPanel/Menu";
import { useProjectsStore } from "../../stores/projects";
import { detectProjectRoot } from "../../lib/tauri-commands";

import type { ElectronAPI } from '../../lib/electron';

const electronAPI = window.electronAPI as ElectronAPI;

// z-index stacking for thread switching — zero-cost compositor operation.
// All ConversationLayers are always visible and GPU-composited. Switching threads
// just changes z-index (active=1, inactive=0) + pointer-events. No visibility toggle,
// no layout read, no reflow, no layer teardown. The compositor reorders existing layers
// without repainting — sub-millisecond at any refresh rate.
const ConversationLayer = memo(function ConversationLayer({ projectId }: { projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  // Always start unmounted. startTransition defers the heavy Conversation render
  // so the initial paint (empty area) happens first, keeping the app responsive
  // when restoring a conversation with many large code blocks.
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);
  const [, startTransition] = useTransition();

  // Thread switching only — page visibility handled by parent [data-page="conversation"]
  // container via CSS. This layer only manages which thread is on top.
  useEffect(() => {
    const apply = (state: ReturnType<typeof useProjectsStore.getState>) => {
      if (!ref.current) return;
      const isActive = state.activeProjectId === projectId;
      if (isActive && !mountedRef.current) {
        mountedRef.current = true;
        startTransition(() => setMounted(true));
      }
      ref.current.style.zIndex = isActive ? "1" : "0";
      ref.current.style.pointerEvents = isActive ? "auto" : "none";
      ref.current.style.contentVisibility = isActive ? "visible" : "hidden";
    };

    apply(useProjectsStore.getState());
    return useProjectsStore.subscribe((state, prev) => {
      if (state.activeProjectId !== prev.activeProjectId) apply(state);
    });
  }, [projectId]);

  const initiallyActive = useProjectsStore((s) => s.activeProjectId === projectId);
  const activeConvId = useProjectsStore((s) => s.projects.get(projectId)?.activeConversationId ?? null);
  const totalConvCount = useProjectsStore((s) => {
    const p = s.projects.get(projectId);
    if (!p) return 0;
    let count = 0;
    for (const c of p.conversations.values()) {
      if (!c.isArchived) count++;
    }
    return count;
  });

  // Auto-create a default conversation when project has no conversation rows at all
  // (e.g. brand new project, never created a conversation). Only fires when both
  // the conversations map AND activeConversationId are empty.
  useEffect(() => {
    if (!mounted) return;
    if (totalConvCount === 0 && !activeConvId) {
      useProjectsStore.getState().addConversation(projectId, undefined, "idle");
    }
  }, [mounted, totalConvCount, activeConvId, projectId]);

  // Show picker when no conversation is active and conversations exist
  const showPicker = !activeConvId && totalConvCount > 0;

  return (
    <div
      ref={ref}
      className="absolute inset-0 flex flex-col bg-pane-bg"
      style={{
        zIndex: initiallyActive ? 1 : 0,
        pointerEvents: initiallyActive ? "auto" : "none",
      }}
    >
      {mounted && (
        <>
          <div className="flex-1 min-h-0 flex flex-col">
            {activeConvId ? (
              <Conversation projectId={projectId} conversationId={activeConvId} />
            ) : showPicker ? (
              <ConversationPicker projectId={projectId} />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
});

function ProjectTerminal({ projectId }: { projectId: string }) {
  const root = useProjectsStore((s) => s.projects.get(projectId)?.root ?? "");
  if (!root) return null;
  return <Terminal projectId={projectId} workingDir={root} />;
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
  const wsRef = useRef<HTMLDivElement>(null);

  // Single store subscription → single data-mode DOM write → CSS handles all page visibility.
  // No React re-render on mode switch. All pages transition in one style recalc, one paint frame.
  useEffect(() => {
    const applyMode = (state: ReturnType<typeof useProjectsStore.getState>) => {
      if (!wsRef.current) return;
      const id = state.activeProjectId;
      const mode = id ? state.projects.get(id)?.mode ?? "conversation" : "conversation";
      wsRef.current.dataset.mode = mode;
    };
    applyMode(useProjectsStore.getState());
    return useProjectsStore.subscribe((state, prev) => {
      const activeChanged = state.activeProjectId !== prev.activeProjectId;
      const modeChanged = state.activeProjectId
        ? state.projects.get(state.activeProjectId)?.mode !==
          prev.projects.get(state.activeProjectId ?? "")?.mode
        : false;
      if (activeChanged || modeChanged) applyMode(state);
    });
  }, []);

  const mode = useProjectsStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.get(id)?.mode ?? "conversation" : "conversation";
  });
  const isGitRepo = useProjectsStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.get(id)?.git.isGitRepo ?? false : false;
  });
  const hasUnreadLens = useProjectsStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.get(id)?.hasUnreadLens ?? false : false;
  });
  const setMode = useProjectsStore((s) => s.setMode);

  const handleSelectMode = useCallback((newMode: PaneMode) => {
    const id = useProjectsStore.getState().activeProjectId;
    if (!id) return;
    setMode(id, newMode);
    if (newMode === "conversation") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-input")));
    else if (newMode === "viewer") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-editor")));
    else if (newMode === "search") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-search")));
    else if (newMode === "filesearch") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pane:focus-filesearch")));
  }, [setMode]);

  return (
    <div ref={wsRef} data-mode="conversation" className="h-full relative bg-pane-bg rounded-xl ring-1 ring-pane-border/40 overflow-hidden">
      {/* Tab bar OUTSIDE page div — sits in the Workspace root stacking context
           so its z-index resolves above the drag region (z-30 in App.tsx).
           The page div's stacking context (z-20) would trap it underneath. */}
      {activeProjectId && (
        <ConversationTabBar projectId={activeProjectId} />
      )}

      {/* Conversation page — participates in the same [data-page] CSS system as every other page.
           Page-level visibility (conversation vs mind vs profile) is CSS-driven.
           Thread switching (project A vs project B) is JS-driven z-index 0/1 inside.
           Has pt-8 to account for the absolute tab bar above. */}
      <div data-page="conversation" className="absolute inset-0 flex flex-col bg-pane-bg">
        <div className="flex-1 min-h-0 relative pt-8">
          {projectOrder.length === 0 && <EmptyState />}
          {projectOrder.map((id) => (
            <ConversationLayer key={id} projectId={id} />
          ))}
        </div>
      </div>

      <div data-page="viewer" className="absolute inset-0 flex flex-col bg-pane-bg">
        <FileExplorer />
      </div>

      <div data-page="terminal" className="absolute inset-0 flex bg-pane-bg">
        {activeProjectId && (
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <ProjectTerminal projectId={activeProjectId} />
          </div>
        )}
      </div>

      <div data-page="git" className="absolute inset-0 flex flex-col bg-pane-bg">
        {activeProjectId && <GitView projectId={activeProjectId} />}
      </div>

      <div data-page="mind" className="absolute inset-0 bg-pane-bg">
        <Mind />
      </div>

      <div data-page="lens" className="absolute inset-0 bg-pane-bg">
        {activeProjectId && <Lens projectId={activeProjectId} />}
      </div>

      <div data-page="profile" className="absolute inset-0 bg-pane-bg">
        <Profile />
      </div>

      {activeProjectId && (
        <div data-page="history" className="absolute inset-0 bg-pane-bg">
          <ChangeHistoryPanel projectId={activeProjectId} />
        </div>
      )}

      {/* Search page — FuzzyFinder inline, visible when mode="search" */}
      <div data-page="search" className="absolute inset-0 bg-pane-bg">
        {activeProjectId && <FuzzyFinder />}
      </div>

      {/* Filesearch page — FileSearch inline, visible when mode="filesearch" */}
      <div data-page="filesearch" className="absolute inset-0 bg-pane-bg">
        {activeProjectId && <FileSearch />}
      </div>

      {/* Menu — shown in workspace when sidebar is hidden (non-conversation modes).
           bottom-1.5 left-1.5 matches the InputBar '+' attach button padding (p-1.5). */}
      {mode !== "conversation" && (
        <div className="absolute bottom-1.5 left-1.5 z-50 w-80 pointer-events-none">
          <Menu
            currentMode={mode}
            isGitRepo={isGitRepo}
            hasUnreadLens={hasUnreadLens}
            onSelectMode={handleSelectMode}
          />
        </div>
      )}
    </div>
  );
}
