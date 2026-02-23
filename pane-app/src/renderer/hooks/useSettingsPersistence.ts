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
        if (settings.theme === "light" || settings.theme === "dark" || settings.theme === "pure" || settings.theme === "system") {
          useWorkspaceStore.getState().setTheme(settings.theme);
        }
        if (settings.panel_width) {
          useWorkspaceStore.getState().setControlPanelWidth(settings.panel_width);
        }

        const { addProject, setActiveProject, toggleDir } =
          useProjectsStore.getState();

        if (settings.project_roots.length > 0) {
          // Restore saved projects (in saved order)
          let activeId: string | null = null;
          for (const root of settings.project_roots) {
            const id = addProject(root);
            if (root === settings.active_project_root) {
              activeId = id;
            }

            // Restore per-project state
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
                    // Stay in conversation mode on restore — user can toggle to see file
                    store.setMode(id, "conversation");
                  })
                  .catch(() => {
                    /* file may have been deleted */
                  });
              }
            }
          }
          if (activeId) {
            setActiveProject(activeId);
          }

          // Restore conversation history for all projects
          const store = useProjectsStore.getState();
          for (const [id] of store.projects) {
            loadConversation(id).then((saved) => {
              if (saved && saved.messages.length > 0) {
                useProjectsStore.getState().restoreConversation(id, saved.messages, saved.sessionId);
              }
            }).catch(() => {});
          }
        } else {
          // First launch — auto-detect from CWD
          const cwd = await getCwd();
          const root = await detectProjectRoot(cwd);
          addProject(root);
        }

        // Mark settings as loaded — saves are now safe
        settingsLoaded = true;
        loadedRef.current = true;
      })
      .catch(console.error);
  }, []);

  // Save on changes
  useEffect(() => {
    const save = () => {
      // Don't save until settings have been loaded into the stores.
      // This prevents overwriting the settings file with defaults during
      // app reload, HMR, or StrictMode double-mount cleanup.
      if (!settingsLoaded) return;

      const { controlPanelVisible, controlPanelWidth, fontSize, panelFontSize, editorFontSize, theme } = useWorkspaceStore.getState();
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
        theme,
        panel_width: controlPanelWidth,
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
          state.theme !== prev.theme ||
          state.controlPanelWidth !== prev.controlPanelWidth ||
          state.controlPanelVisible !== prev.controlPanelVisible
        ) {
          debouncedSave();
        }
      },
    );

    // Save when structural project state changes (not conversation streaming)
    const unsubProjects = useProjectsStore.subscribe(
      (state, prev) => {
        if (state.activeProjectId !== prev.activeProjectId ||
            state.projectOrder !== prev.projectOrder) {
          debouncedSave();
          return;
        }
        if (state.projects !== prev.projects) {
          // Only save on structural changes, NOT conversation/streaming updates
          if (state.projects.size !== prev.projects.size) {
            debouncedSave();
            return;
          }
          for (const [id, project] of state.projects) {
            const prevProject = prev.projects.get(id);
            if (!prevProject) { debouncedSave(); return; }
            if (
              project.expandedDirs !== prevProject.expandedDirs ||
              project.activeFilePath !== prevProject.activeFilePath ||
              project.mode !== prevProject.mode
            ) {
              debouncedSave();
              return;
            }
          }
        }
      },
    );

    // Save conversation history when messages change
    let convDebounce: ReturnType<typeof setTimeout> | null = null;
    const unsubConversation = useProjectsStore.subscribe(
      (state, prev) => {
        if (!settingsLoaded) return;
        for (const [id, project] of state.projects) {
          const prevProject = prev.projects.get(id);
          if (!prevProject) continue;
          const conv = project.conversation;
          const prevConv = prevProject.conversation;
          // Only save when messages actually change (not during streaming text appends)
          if (conv.messages.length !== prevConv.messages.length ||
              conv.sessionId !== prevConv.sessionId ||
              (!conv.isProcessing && prevConv.isProcessing)) {
            if (convDebounce) clearTimeout(convDebounce);
            convDebounce = setTimeout(() => {
              // Save all projects that have messages
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
            break;
          }
        }
      },
    );

    window.addEventListener("beforeunload", save);
    const interval = setInterval(save, 30000);

    return () => {
      unsubWorkspace();
      unsubProjects();
      unsubConversation();
      if (convDebounce) clearTimeout(convDebounce);
      window.removeEventListener("beforeunload", save);
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
