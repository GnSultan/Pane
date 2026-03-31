import { useEffect, useRef } from "react";
import {
  loadSettings,
  saveSettings,
  getCwd,
  detectProjectRoot,
  readFile,
  brainGetProfile,
  brainGetAvatar,
  saveConversationToMain,
} from "../lib/tauri-commands";
import type { ProjectSessionState } from "../lib/tauri-commands";
import type { ConversationMessage } from "../lib/punk-types";
import { useWorkspaceStore, type Theme } from "../stores/workspace";
import { useProjectsStore } from "../stores/projects";
import type { ActionId, KeyBinding } from "../lib/keybindings";
import {
  DEFAULT_BACKEND_ROUTING,
  type BackendRouting,
} from "../lib/models";

// App readiness gate — other hooks (git, watcher) wait for this before starting
let resolveAppReady: () => void;
export const appReadyPromise = new Promise<void>((resolve) => {
  resolveAppReady = resolve;
});

// Use a ref for settingsLoaded to avoid HMR resets if possible,
// but for now let's just make sure it's reliable.
let settingsLoadedGlobal = false;

// Projects whose conversations are currently being loaded from SQLite.
// Populated in Conversation.tsx before startTransition fires restoreConversation,
// cleared inside the same transition after the store update. Prevents
// unsubConversation from triggering save_conversation for data we just read.
export const restoringProjects = new Set<string>();

// --- Conversation persistence helpers ---

interface PersistedConversation {
  model?: string | null;
  messages: ConversationMessage[];
  startIndex?: number;
}


async function saveConversation(
  projectId: string,
  conversation: PersistedConversation,
): Promise<void> {
  // Passes projectId directly — main process owns storage (SQLite).
  await saveConversationToMain(projectId, conversation);
}


export function useSettingsPersistence() {
  const loadedRef = useRef(false);
  const savingDisabled = useRef(true);

  // Load on mount
  useEffect(() => {
    savingDisabled.current = true;
    loadSettings()
      .then(async (settings) => {
        const ws = useWorkspaceStore.getState();

        // 1. Core UI settings
        if (
          settings.control_panel_visible !== undefined &&
          !settings.control_panel_visible
        ) {
          ws.toggleControlPanel();
        }
        if (settings.font_size) ws.setFontSize(settings.font_size);
        if (settings.panel_font_size)
          ws.setPanelFontSize(settings.panel_font_size);
        if (settings.editor_font_size)
          ws.setEditorFontSize(settings.editor_font_size);
        if (settings.font_weight) ws.setFontWeight(settings.font_weight);
        if (settings.keybindings)
          ws.setKeybindingsRaw(settings.keybindings as Partial<Record<ActionId, KeyBinding>>);
        if (settings.theme) ws.setTheme(settings.theme as Theme);
        if (settings.panel_width) ws.setControlPanelWidth(settings.panel_width);
        if (settings.completion_sound)
          ws.setCompletionSound(settings.completion_sound);

        // 2. Provider & Model state
        const backend = settings.punk_backend || "api";
        ws.setPunkBackend(backend);

        if (settings.http_provider) ws.setHttpProvider(settings.http_provider);

        // API keys, Base URLs, disabled providers
        const apiKeys: Record<string, string> = settings.http_api_keys || {};
        ws.setHttpApiKeys(apiKeys);
        ws.setHttpBaseUrls(settings.http_base_urls || {});
        if (settings.disabled_providers) ws.setDisabledProviders(settings.disabled_providers);

        // Model restoration
        if (settings.selected_model) {
          ws.setSelectedModel(
            settings.selected_model,
            false,
            settings.selected_model_provider || ws.selectedModelProvider,
          );
        }

        // 3. Routing Restore
        const rawRouting = settings.intent_routing as BackendRouting | null;
        useWorkspaceStore.setState({ intentRouting: rawRouting ?? DEFAULT_BACKEND_ROUTING });

        if (settings.intent_auto_route !== undefined) {
          ws.setIntentAutoRoute(settings.intent_auto_route);
        }

        // 4. Project restoration — conversations load lazily in Conversation.tsx
        const { addProject, setActiveProject, toggleDir } =
          useProjectsStore.getState();

        if (settings.project_roots?.length > 0) {
          let activeId: string | null = null;
          const projectIds: string[] = [];
          for (const root of settings.project_roots as string[]) {
            const id = addProject(root);
            projectIds.push(id);
            if (root === settings.active_project_root) activeId = id;
          }
          if (activeId) setActiveProject(activeId);

          // Mark all as restored AFTER the loops
          for (const id of projectIds) {
            useProjectsStore.getState().setConversationRestored(id, true);
          }

          const restoreProjectState = (idx: number) => {
            if (idx >= projectIds.length) return;
            const id = projectIds[idx]!;
            const root = settings.project_roots[idx]!;
            const state: ProjectSessionState | undefined =
              settings.project_states?.[root];

            if (state) {
              if (state.name) useProjectsStore.getState().renameProject(id, state.name);
              for (const dir of state.expanded_dirs) toggleDir(id, dir);
              if (state.recent_files?.length) {
                useProjectsStore.setState((s) => {
                  const proj = s.projects.get(id);
                  if (!proj) return s;
                  const next = new Map(s.projects);
                  next.set(id, { ...proj, recentFiles: state.recent_files! });
                  return { projects: next };
                });
              }
              if (state.scroll_positions) {
                useProjectsStore.setState((s) => {
                  const proj = s.projects.get(id);
                  if (!proj) return s;
                  const next = new Map(s.projects);
                  next.set(id, {
                    ...proj,
                    scrollPositions: new Map(
                      Object.entries(state.scroll_positions!),
                    ),
                  });
                  return { projects: next };
                });
              }
              if (state.active_file_path) {
                readFile(state.active_file_path)
                  .then((content) => {
                    const store = useProjectsStore.getState();
                    store.openFile(id, state.active_file_path!, content);
                    store.setMode(id, "conversation");
                  })
                  .catch(() => {});
              }
            }
            if (idx + 1 < projectIds.length) {
              requestIdleCallback(() => restoreProjectState(idx + 1));
            }
          };
          requestIdleCallback(() => restoreProjectState(0));
        } else {
          const cwd = await getCwd();
          const root = await detectProjectRoot(cwd);
          addProject(root);
        }

        // 5. Cleanup and final signals
        settingsLoadedGlobal = true;
        loadedRef.current = true;
        savingDisabled.current = false;
        resolveAppReady();

        brainGetProfile()
          .then(({ profile }) => {
            if (profile?.identity) {
              const ws = useWorkspaceStore.getState();
              if (profile.identity.name)
                ws.setProfileName(profile.identity.name);
              if (profile.identity.bio) ws.setProfileBio(profile.identity.bio);
              if (profile.identity.role)
                ws.setProfileRole(profile.identity.role);
            }
          })
          .catch(() => {});

        brainGetAvatar()
          .then(({ base64, mime }) => {
            if (base64 && mime) {
              useWorkspaceStore
                .getState()
                .setProfileAvatarDataUrl(`data:${mime};base64,${base64}`);
            }
          })
          .catch(() => {});
      })
      .catch((err) => {
        console.error("[persistence] Load failed:", err);
        resolveAppReady();
      });
  }, []);

  // Save on changes
  useEffect(() => {
    const save = () => {
      if (!settingsLoadedGlobal || savingDisabled.current) return;

      const ws = useWorkspaceStore.getState();
      const ps = useProjectsStore.getState();
      const activeProject = ps.activeProjectId
        ? ps.projects.get(ps.activeProjectId)
        : undefined;

      const project_roots: string[] = [];
      const project_states: Record<string, ProjectSessionState> = {};

      for (const id of ps.projectOrder) {
        const p = ps.projects.get(id);
        if (!p) continue;
        project_roots.push(p.root);
        project_states[p.root] = {
          name: p.name,
          expanded_dirs: Array.from(p.expandedDirs),
          active_file_path: p.activeFilePath,
          recent_files: p.recentFiles,
          scroll_positions: Object.fromEntries(p.scrollPositions.entries()),
        };
      }

      saveSettings({
        project_roots,
        active_project_root: activeProject?.root ?? null,
        control_panel_visible: ws.controlPanelVisible,
        project_states,
        font_size: ws.fontSize,
        panel_font_size: ws.panelFontSize,
        editor_font_size: ws.editorFontSize,
        font_weight: ws.fontWeight,
        keybindings: ws.keybindings,
        theme: ws.theme,
        panel_width: ws.controlPanelWidth,
        completion_sound: ws.completionSound,
        selected_model: ws.selectedModel,
        selected_model_provider: ws.selectedModelProvider,

        punk_backend: ws.punkBackend,
        http_provider: ws.httpProvider,
        http_api_keys: ws.httpApiKeys,
        http_base_urls: ws.httpBaseUrls,
        disabled_providers: ws.disabledProviders,
        intent_routing: ws.intentRouting as BackendRouting,
        intent_auto_route: ws.intentAutoRoute,
      }).catch((err) => console.error("[persistence] Save failed:", err));
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(save, 1000); // 1s debounce for safer persistence
    };

    const unsubWorkspace = useWorkspaceStore.subscribe((state, prev) => {
      // Deep comparison for routing to avoid unnecessary saves but capture changes
      const routingChanged =
        JSON.stringify(state.intentRouting) !==
        JSON.stringify(prev.intentRouting);
      const keysChanged =
        JSON.stringify(state.httpApiKeys) !== JSON.stringify(prev.httpApiKeys);
      const urlsChanged =
        JSON.stringify(state.httpBaseUrls) !==
        JSON.stringify(prev.httpBaseUrls);

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
        state.selectedModel !== prev.selectedModel ||
        state.selectedModelProvider !== prev.selectedModelProvider ||
        state.punkBackend !== prev.punkBackend ||
        state.httpProvider !== prev.httpProvider ||
        routingChanged ||
        keysChanged ||
        urlsChanged ||
        state.intentAutoRoute !== prev.intentAutoRoute
      ) {
        debouncedSave();
      }
    });

    let lastStructuralKey = "";
    const computeStructuralKey = (
      state: ReturnType<typeof useProjectsStore.getState>,
    ) => {
      const parts = [state.activeProjectId ?? "", state.projectOrder.join(",")];
      for (const id of state.projectOrder) {
        const p = state.projects.get(id);
        if (!p) continue;
        parts.push(
          `${id}:${p.name}:${p.expandedDirs.size}:${p.activeFilePath ?? ""}:${p.mode}`,
        );
      }
      return parts.join("|");
    };
    lastStructuralKey = computeStructuralKey(useProjectsStore.getState());

    const unsubProjects = useProjectsStore.subscribe((state) => {
      const key = computeStructuralKey(state);
      if (key !== lastStructuralKey) {
        lastStructuralKey = key;
        debouncedSave();
      }
    });

    const unsubConversation = useProjectsStore.subscribe((state, prev) => {
      if (!settingsLoadedGlobal) return;
      for (const id of state.projectOrder) {
        const p = state.projects.get(id);
        const pp = prev.projects.get(id);
        if (!p) continue;

        // Skip while conversation is being loaded from SQLite. The
        // restoringProjects set is populated in Conversation.tsx before
        // startTransition fires and cleared after the store update completes.
        if (restoringProjects.has(id)) continue;

        // Save when message count changes or session finishes
        const countChanged =
          p.conversation.messages.length !== pp?.conversation.messages.length;
        const finished =
          !p.conversation.isProcessing && pp?.conversation.isProcessing;

        if (countChanged || finished) {
          saveConversation(id, {
            model: p.conversation.model,
            messages: p.conversation.messages,
            startIndex: p.conversation.historyStartIndex,
          }).catch(() => {});
        }
      }
    });

    window.addEventListener("beforeunload", save);
    const interval = setInterval(save, 60000);

    return () => {
      unsubWorkspace();
      unsubProjects();
      unsubConversation();
      window.removeEventListener("beforeunload", save);
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (loadedRef.current) save();
    };
  }, []);
}
