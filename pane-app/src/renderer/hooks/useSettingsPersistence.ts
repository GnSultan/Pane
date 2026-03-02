import { useEffect, useRef } from "react";
import {
  loadSettings,
  saveSettings,
  getCwd,
  detectProjectRoot,
  readFile,
  writeFile,
  getHomeDir,
} from "../lib/tauri-commands";
import type { ProjectSessionState } from "../lib/tauri-commands";
import type { ConversationMessage } from "../lib/claude-types";
import { useWorkspaceStore } from "../stores/workspace";
import { useProjectsStore } from "../stores/projects";

// Module-level flag: only save settings after they've been successfully loaded.
// This prevents cleanup saves from overwriting the file with default store values
// during app reload or HMR.
let settingsLoaded = false;
let paneDir = "";

// App readiness gate — other hooks (git, watcher) wait for this before starting
let resolveAppReady: () => void;
export const appReadyPromise = new Promise<void>((resolve) => {
  resolveAppReady = resolve;
});

// --- Conversation persistence helpers ---

interface PersistedConversation {
  sessionId: string | null;
  messages: ConversationMessage[];
}

function conversationPath(projectId: string): string {
  return `${paneDir}/conversations/${projectId}.json`;
}

async function saveConversation(projectId: string, conversation: PersistedConversation): Promise<void> {
  if (!paneDir) return;
  const data: PersistedConversation = {
    sessionId: conversation.sessionId,
    messages: conversation.messages,
  };
  await writeFile(conversationPath(projectId), JSON.stringify(data));
}

async function loadConversation(projectId: string): Promise<PersistedConversation | null> {
  if (!paneDir) return null;
  try {
    const content = await readFile(conversationPath(projectId));
    return JSON.parse(content) as PersistedConversation;
  } catch {
    return null;
  }
}

export function useSettingsPersistence() {
  const loadedRef = useRef(false);

  // Load on mount
  useEffect(() => {
    getHomeDir()
      .then((home) => { paneDir = `${home}/.pane`; })
      .catch(() => {});

    loadSettings()
      .then(async (settings) => {
        if (!settings.control_panel_visible) {
          useWorkspaceStore.getState().toggleControlPanel();
        }
        if (settings.font_size) {
          useWorkspaceStore.getState().setFontSize(settings.font_size);
        }
        if (settings.panel_font_size) {
          useWorkspaceStore.getState().setPanelFontSize(settings.panel_font_size);
        }
        if (settings.editor_font_size) {
          useWorkspaceStore.getState().setEditorFontSize(settings.editor_font_size);
        }
        if (settings.font_weight) {
          useWorkspaceStore.getState().setFontWeight(settings.font_weight);
        }
        if (settings.keybindings) {
          useWorkspaceStore.getState().setKeybindingsRaw(settings.keybindings as any);
        }
        if (settings.theme === "light" || settings.theme === "dark" || settings.theme === "pure" || settings.theme === "system") {
          useWorkspaceStore.getState().setTheme(settings.theme);
        }
        if (settings.panel_width) {
          useWorkspaceStore.getState().setControlPanelWidth(settings.panel_width);
        }
        if (settings.completion_sound) {
          useWorkspaceStore.getState().setCompletionSound(settings.completion_sound);
        }
        if (settings.selected_model) {
          useWorkspaceStore.getState().setSelectedModel(settings.selected_model);
        }

        const { addProject, setActiveProject, toggleDir } =
          useProjectsStore.getState();

        if (settings.project_roots.length > 0) {
          // Restore saved projects (in saved order)
          // Phase 1: Add all projects in one pass (each addProject creates a Map copy)
          let activeId: string | null = null;
          const projectIds: string[] = [];
          for (const root of settings.project_roots) {
            const id = addProject(root);
            projectIds.push(id);
            if (root === settings.active_project_root) {
              activeId = id;
            }
          }
          if (activeId) {
            setActiveProject(activeId);
          }

          // Phase 2: Defer per-project state restoration to idle time
          // This prevents expanded dirs, file reads, and conversation loads
          // from blocking the initial render
          const restoreProjectState = (idx: number) => {
            if (idx >= projectIds.length) return;
            const id = projectIds[idx]!;
            const root = settings.project_roots[idx]!;
            const state: ProjectSessionState | undefined =
              settings.project_states?.[root];

            if (state) {
              // Restore expanded dirs
              for (const dir of state.expanded_dirs) {
                toggleDir(id, dir);
              }
              // Restore active file (read content async)
              if (state.active_file_path) {
                const filePath = state.active_file_path;
                readFile(filePath)
                  .then((content) => {
                    const store = useProjectsStore.getState();
                    store.openFile(id, filePath, content);
                    store.setMode(id, "conversation");
                  })
                  .catch(() => {});
              }
            }

            // Load conversation history
            loadConversation(id).then((saved) => {
              if (saved && saved.messages.length > 0) {
                useProjectsStore.getState().restoreConversation(id, saved.messages, saved.sessionId);
              }
            }).catch(() => {});

            // Stagger next project restoration to next idle period
            if (idx + 1 < projectIds.length) {
              requestIdleCallback(() => restoreProjectState(idx + 1));
            }
          };

          // Start restoring project states after first paint
          requestIdleCallback(() => restoreProjectState(0));
        } else {
          // First launch — auto-detect from CWD
          const cwd = await getCwd();
          const root = await detectProjectRoot(cwd);
          addProject(root);
        }

        // Mark settings as loaded — saves are now safe
        settingsLoaded = true;
        loadedRef.current = true;
        // Signal other hooks that the app is ready
        resolveAppReady();
      })
      .catch((err) => {
        console.error(err);
        // Still resolve so hooks don't hang forever
        resolveAppReady();
      });
  }, []);

  // Save on changes
  useEffect(() => {
    const save = () => {
      // Don't save until settings have been loaded into the stores.
      // This prevents overwriting the settings file with defaults during
      // app reload, HMR, or StrictMode double-mount cleanup.
      if (!settingsLoaded) return;

      const { controlPanelVisible, controlPanelWidth, fontSize, panelFontSize, editorFontSize, fontWeight, keybindings, theme, completionSound, selectedModel } = useWorkspaceStore.getState();
      const { projects, activeProjectId, projectOrder } =
        useProjectsStore.getState();

      // Don't save if stores appear empty during initial load
      // settingsLoaded is only true after successful load, so empty projectOrder
      // at this point means user removed all projects (legitimate state)
      // No additional guard needed - settingsLoaded check at top is sufficient

      const activeProject = activeProjectId
        ? projects.get(activeProjectId)
        : undefined;

      // Build per-project state and ordered roots
      const project_roots: string[] = [];
      const project_states: Record<string, ProjectSessionState> = {};

      for (const id of projectOrder) {
        const p = projects.get(id);
        if (!p) continue;
        project_roots.push(p.root);
        project_states[p.root] = {
          expanded_dirs: Array.from(p.expandedDirs),
          active_file_path: p.activeFilePath,
        };
      }

      saveSettings({
        project_roots,
        active_project_root: activeProject?.root ?? null,
        control_panel_visible: controlPanelVisible,
        project_states,
        font_size: fontSize,
        panel_font_size: panelFontSize,
        editor_font_size: editorFontSize,
        font_weight: fontWeight,
        keybindings: keybindings ?? null,
        theme,
        panel_width: controlPanelWidth,
        completion_sound: completionSound,
        selected_model: selectedModel,
      }).catch(console.error);
    };

    // Debounced save for rapid changes (font size, panel resize)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(save, 500);
    };

    // Save when workspace settings change (font size, theme, panel width)
    const unsubWorkspace = useWorkspaceStore.subscribe(
      (state, prev) => {
        if (
          state.fontSize !== prev.fontSize ||
          state.panelFontSize !== prev.panelFontSize ||
          state.editorFontSize !== prev.editorFontSize ||
          state.fontWeight !== prev.fontWeight ||
          state.keybindings !== prev.keybindings ||
          state.theme !== prev.theme ||
          state.controlPanelWidth !== prev.controlPanelWidth ||
          state.controlPanelVisible !== prev.controlPanelVisible ||
          state.completionSound !== prev.completionSound ||
          state.selectedModel !== prev.selectedModel
        ) {
          debouncedSave();
        }
      },
    );

    // Save when structural project state changes (not conversation streaming)
    // Track a fingerprint of the structural fields to avoid iterating all projects
    let lastStructuralKey = "";
    const computeStructuralKey = (state: ReturnType<typeof useProjectsStore.getState>) => {
      const parts: string[] = [state.activeProjectId ?? "", state.projectOrder.join(",")];
      for (const id of state.projectOrder) {
        const p = state.projects.get(id);
        if (!p) continue;
        parts.push(`${id}:${p.expandedDirs.size}:${p.activeFilePath ?? ""}:${p.mode}`);
      }
      return parts.join("|");
    };
    lastStructuralKey = computeStructuralKey(useProjectsStore.getState());

    const unsubProjects = useProjectsStore.subscribe(
      (state) => {
        const key = computeStructuralKey(state);
        if (key !== lastStructuralKey) {
          lastStructuralKey = key;
          debouncedSave();
        }
      },
    );

    // Save conversation history when messages change
    // Track per-project fingerprint to avoid iterating all projects on every mutation
    let convDebounce: ReturnType<typeof setTimeout> | null = null;
    const lastConvKeys = new Map<string, string>();
    const convKey = (p: ReturnType<typeof useProjectsStore.getState>["projects"] extends Map<string, infer V> ? V : never) =>
      `${p.conversation.messages.length}:${p.conversation.sessionId ?? ""}:${p.conversation.isProcessing}`;

    // Initialize keys
    for (const [id, p] of useProjectsStore.getState().projects) {
      lastConvKeys.set(id, convKey(p));
    }

    const unsubConversation = useProjectsStore.subscribe(
      (state) => {
        if (!settingsLoaded) return;
        let changed = false;
        for (const id of state.projectOrder) {
          const project = state.projects.get(id);
          if (!project) continue;
          const key = convKey(project);
          if (key !== lastConvKeys.get(id)) {
            lastConvKeys.set(id, key);
            changed = true;
          }
        }
        if (!changed) return;

        if (convDebounce) clearTimeout(convDebounce);
        convDebounce = setTimeout(() => {
          const current = useProjectsStore.getState();
          for (const [pid, p] of current.projects) {
            if (p.conversation.messages.length > 0 && !p.conversation.isProcessing) {
              saveConversation(pid, {
                sessionId: p.conversation.sessionId,
                messages: p.conversation.messages,
              }).catch(console.error);
            }
          }
        }, 1000);
      },
    );

    const handleBeforeUnload = () => {
      save();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    const interval = setInterval(save, 30000);

    return () => {
      unsubWorkspace();
      unsubProjects();
      unsubConversation();
      if (convDebounce) clearTimeout(convDebounce);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
      // Only save on cleanup if this instance successfully loaded settings
      if (loadedRef.current) {
        save();
      }
      // Reset module-level flag so error boundary recovery doesn't save with empty stores
      settingsLoaded = false;
    };
  }, []);
}
