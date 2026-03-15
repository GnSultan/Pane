import { useEffect, useRef } from "react";
import {
  loadSettings,
  saveSettings,
  getCwd,
  detectProjectRoot,
  readFile,
  writeFile,
  getHomeDir,
  listCheckpoints,
  brainGetProfile,
  brainGetAvatar,
} from "../lib/tauri-commands";
import type { ProjectSessionState } from "../lib/tauri-commands";
import type { ConversationMessage } from "../lib/claude-types";
import { useWorkspaceStore } from "../stores/workspace";
import { useProjectsStore } from "../stores/projects";
import { DEFAULT_BACKEND_ROUTING, type IntentRouting } from "../lib/models";

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
  model?: string | null;
  messages: ConversationMessage[];
}

function precomputeProjectId(root: string): string {
  const name = root.split("/").filter(Boolean).pop() || root;
  return name.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

function conversationPath(projectId: string): string {
  return `${paneDir}/conversations/${projectId}.json`;
}

async function saveConversation(
  projectId: string,
  conversation: PersistedConversation,
): Promise<void> {
  if (!paneDir) return;
  const data: PersistedConversation = {
    sessionId: conversation.sessionId,
    model: conversation.model,
    messages: conversation.messages,
  };
  await writeFile(conversationPath(projectId), JSON.stringify(data));
}

async function loadConversation(
  projectId: string,
): Promise<PersistedConversation | null> {
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
          ws.setKeybindingsRaw(settings.keybindings as any);
        if (settings.theme) ws.setTheme(settings.theme as any);
        if (settings.panel_width) ws.setControlPanelWidth(settings.panel_width);
        if (settings.completion_sound)
          ws.setCompletionSound(settings.completion_sound);

        // 2. Provider & Model state
        const backend =
          (settings.punk_backend === "cli"
            ? "gemini-cli"
            : settings.punk_backend) || "gemini-cli";
        ws.setPunkBackend(backend);

        if (settings.http_provider) ws.setHttpProvider(settings.http_provider);

        // API keys & Base URLs
        const apiKeys: Record<string, string> = settings.http_api_keys || {};
        if (
          settings.http_api_key &&
          !apiKeys[settings.http_provider || "deepseek"]
        ) {
          apiKeys[settings.http_provider || "deepseek"] = settings.http_api_key;
        }
        ws.setHttpApiKeys(apiKeys);
        ws.setHttpBaseUrls(settings.http_base_urls || {});

        // Model restoration
        if (settings.selected_model) {
          let model = settings.selected_model;
          if (model === "gemini-2.5-pro" || model === "gemini-1.5-pro-latest")
            model = "gemini-3.1-pro";
          if (
            model === "gemini-2.5-flash" ||
            model === "gemini-1.5-flash-latest"
          )
            model = "gemini-3.1-flash";
          ws.setSelectedModel(model, false, ws.selectedModelProvider);
        }

        // 3. Routing Migration & Validation
        const rawRouting = settings.intent_routing as any;
        const healedRouting: Record<string, any> = JSON.parse(
          JSON.stringify(DEFAULT_BACKEND_ROUTING),
        );

        if (rawRouting) {
          const isLegacyFlat =
            rawRouting.plan &&
            rawRouting.execute &&
            !rawRouting["http"] &&
            !rawRouting["gemini-cli"];

          if (isLegacyFlat) {
            // Assign legacy settings to the active backend
            healedRouting[backend] = { ...rawRouting };
          } else {
            // Merge existing backend maps into our canonical defaults
            for (const key of Object.keys(rawRouting)) {
              const normalizedKey = key === "cli" ? "gemini-cli" : key;
              if (healedRouting[normalizedKey]) {
                healedRouting[normalizedKey] = {
                  ...healedRouting[normalizedKey],
                  ...rawRouting[key],
                };
              }
            }
          }

          // Strict Validation: Ensure gemini-cli only uses auto- models
          ["plan", "execute", "explain", "other"].forEach((intent) => {
            const r =
              healedRouting["gemini-cli"]?.[intent as keyof IntentRouting];

            if (r.provider === "gemini" && !r.model.startsWith("auto-")) {
              if (r.model.includes("pro")) r.model = "auto-gemini-3";
              else r.model = "auto-gemini-2.5";
            }
          });
        }
        useWorkspaceStore.setState({ intentRouting: healedRouting });

        if (settings.intent_auto_route !== undefined) {
          ws.setIntentAutoRoute(settings.intent_auto_route);
        }

        // 4. Project & Conversation restoration
        const { addProject, setActiveProject, toggleDir } =
          useProjectsStore.getState();

        if (settings.project_roots?.length > 0) {
          paneDir = `${await getHomeDir()}/.pane`;
          const preloaded = await Promise.all(
            settings.project_roots.map(async (root: string) => {
              const tentativeId = precomputeProjectId(root);
              const saved = await loadConversation(tentativeId).catch(
                () => null,
              );
              return { root, saved };
            }),
          );

          let activeId: string | null = null;
          const projectIds: string[] = [];
          for (const { root, saved } of preloaded) {
            const id = addProject(root);
            projectIds.push(id);
            if (root === settings.active_project_root) activeId = id;

            if (saved && saved.messages.length > 0) {
              const ps = useProjectsStore.getState();
              ps.restoreConversation(id, saved.messages, saved.sessionId);
              if (saved.model) {
                ps.setConversationModel(id, saved.model);
                ps.setConversationReady(id, true);
              }
              listCheckpoints(id)
                .then((metas) => {
                  if (metas.length > 0) ps.setCheckpoints(id, metas);
                })
                .catch(() => {});
            }
          }
          if (activeId) setActiveProject(activeId);

          const restoreProjectState = (idx: number) => {
            if (idx >= projectIds.length) return;
            const id = projectIds[idx]!;
            const root = settings.project_roots[idx]!;
            const state: ProjectSessionState | undefined =
              settings.project_states?.[root];

            if (state) {
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
        settingsLoaded = true;
        loadedRef.current = true;
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
      if (!settingsLoaded) return;

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
        // selected_model_provider: ws.selectedModelProvider, // Removed - not part of UserSettings type

        punk_backend: ws.punkBackend,
        http_provider: ws.httpProvider,
        http_api_keys: ws.httpApiKeys,
        http_base_urls: ws.httpBaseUrls,
        intent_routing: ws.intentRouting as any,
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
          `${id}:${p.expandedDirs.size}:${p.activeFilePath ?? ""}:${p.mode}`,
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
      if (!settingsLoaded) return;
      for (const id of state.projectOrder) {
        const p = state.projects.get(id);
        const pp = prev.projects.get(id);
        if (!p) continue;

        // Save when message count changes or session finishes
        const countChanged =
          p.conversation.messages.length !== pp?.conversation.messages.length;
        const finished =
          !p.conversation.isProcessing && pp?.conversation.isProcessing;

        if (countChanged || finished) {
          saveConversation(id, {
            sessionId: p.conversation.sessionId,
            model: p.conversation.model,
            messages: p.conversation.messages,
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
      settingsLoaded = false;
    };
  }, []);
}
