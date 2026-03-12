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
  writeEditorState,
  writeProjectState,
  brainGetProfile,
  brainGetAvatar,
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
  model?: string | null;
  messages: ConversationMessage[];
}

// Mirror of createProject's ID logic — lets us pre-compute the ID from a root
// path before calling addProject, so we can load conversation state first.
// NOTE: if two projects collide on the base name, ensureUniqueId appends "-2",
// which we can't predict here. Accepted edge case — rare in practice.
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
        if (!settings.control_panel_visible) {
          useWorkspaceStore.getState().toggleControlPanel();
        }
        if (settings.font_size) {
          useWorkspaceStore.getState().setFontSize(settings.font_size);
        }
        if (settings.panel_font_size) {
          useWorkspaceStore
            .getState()
            .setPanelFontSize(settings.panel_font_size);
        }
        if (settings.editor_font_size) {
          useWorkspaceStore
            .getState()
            .setEditorFontSize(settings.editor_font_size);
        }
        if (settings.font_weight) {
          useWorkspaceStore.getState().setFontWeight(settings.font_weight);
        }
        if (settings.keybindings) {
          useWorkspaceStore
            .getState()
            .setKeybindingsRaw(settings.keybindings as any);
        }
        if (
          settings.theme === "light" ||
          settings.theme === "dark" ||
          settings.theme === "pure" ||
          settings.theme === "system"
        ) {
          useWorkspaceStore.getState().setTheme(settings.theme);
        }
        if (settings.panel_width) {
          useWorkspaceStore
            .getState()
            .setControlPanelWidth(settings.panel_width);
        }
        if (settings.completion_sound) {
          useWorkspaceStore
            .getState()
            .setCompletionSound(settings.completion_sound);
        }
        if (settings.selected_model) {
          let model = settings.selected_model;
          // Migration: upgrade Gemini 1.5/2.5 to 3.1
          if (model === "gemini-2.5-pro" || model === "gemini-1.5-pro-latest") model = "gemini-3.1-pro";
          if (model === "gemini-2.5-flash" || model === "gemini-1.5-flash-latest") model = "gemini-3.1-flash";
          useWorkspaceStore.getState().setSelectedModel(model);
        }
        if (settings.punk_backend) {
          useWorkspaceStore.getState().setPunkBackend(settings.punk_backend);
        }
        if (settings.http_provider) {
          useWorkspaceStore.getState().setHttpProvider(settings.http_provider);
        }

        // Load HTTP API keys and base URLs
        const apiKeys: Record<string, string> = {};
        const baseUrls: Record<string, string> = {};

        // Backwards compatibility: load single key if exists
        if (settings.http_api_key) {
          apiKeys[settings.http_provider || "deepseek"] = settings.http_api_key;
        }

        // Load provider-specific keys (takes precedence over legacy single key)
        if (settings.http_api_keys) {
          Object.assign(apiKeys, settings.http_api_keys);
        }

        if (settings.http_base_urls) {
          Object.assign(baseUrls, settings.http_base_urls);
        }

        useWorkspaceStore.getState().setHttpApiKeys(apiKeys);
        useWorkspaceStore.getState().setHttpBaseUrls(baseUrls);

        if (settings.intent_routing) {
          const routing = { ...settings.intent_routing } as any;
          // Migration: upgrade Gemini models to use CLI's internal auto-routing
          ["plan", "execute", "explain", "other"].forEach((intent) => {
            if (routing[intent]?.provider === "gemini") {
              const model = routing[intent].model;
              if (
                model === "gemini-2.5-pro" ||
                model === "gemini-1.5-pro-latest" ||
                model.startsWith("gemini-3") ||
                model.includes("pro")
              ) {
                routing[intent].model = "auto-gemini-3";
              } else {
                routing[intent].model = "auto-gemini-2.5";
              }
            }
          });
          useWorkspaceStore.getState().setIntentRouting(routing);
        }
        if (settings.intent_auto_route !== undefined) {
          useWorkspaceStore
            .getState()
            .setIntentAutoRoute(settings.intent_auto_route);
        }

        const { addProject, setActiveProject, toggleDir } =
          useProjectsStore.getState();

        if (settings.project_roots.length > 0) {
          // Phase 1: Pre-load all conversation files in parallel BEFORE adding projects.
          // This is critical — addProject triggers Zustand updates → React renders →
          // useClaudeWarmup fires. If conversations aren't loaded by then, warmup sees
          // sessionId=null and starts a fresh Claude session, destroying continuity.
          paneDir = `${await getHomeDir()}/.pane`;
          const preloaded = await Promise.all(
            settings.project_roots.map(async (root) => {
              const tentativeId = precomputeProjectId(root);
              const saved = await loadConversation(tentativeId).catch(
                () => null,
              );
              return { root, saved };
            }),
          );

          // Phase 2: Add projects + immediately restore conversation state synchronously.
          // React 18 batches all these Zustand updates into a single render, so warmup
          // will see the restored sessionId/isReady on its first check.
          let activeId: string | null = null;
          const projectIds: string[] = [];
          for (const { root, saved } of preloaded) {
            const id = addProject(root);
            projectIds.push(id);
            if (root === settings.active_project_root) activeId = id;

            if (saved && saved.messages.length > 0) {
              const s = useProjectsStore.getState();
              s.restoreConversation(id, saved.messages, saved.sessionId);
              if (saved.model) {
                s.setConversationModel(id, saved.model);
                // Model known — warmup skips, no loading indicator needed
                s.setConversationReady(id, true);
              }
              // No model → isReady stays false → warmup runs, shows pulsing circle,
              // fetches model from Claude init, then marks ready
              // Checkpoints can load in background — not needed before first render
              listCheckpoints(id)
                .then((metas) => {
                  if (metas.length > 0)
                    useProjectsStore.getState().setCheckpoints(id, metas);
                })
                .catch(() => {});
            }
          }
          if (activeId) {
            setActiveProject(activeId);
          }

          // Phase 3: Defer non-critical state (expanded dirs, active file) to idle time
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
              // Restore recent files
              if (state.recent_files?.length) {
                useProjectsStore.setState((s) => {
                  const proj = s.projects.get(id);
                  if (!proj) return s;
                  const next = new Map(s.projects);
                  next.set(id, { ...proj, recentFiles: state.recent_files! });
                  return { projects: next };
                });
              }
              // Restore scroll positions
              if (state.scroll_positions) {
                useProjectsStore.setState((s) => {
                  const proj = s.projects.get(id);
                  if (!proj) return s;
                  const next = new Map(s.projects);
                  next.set(id, {
                    ...proj,
                    scrollPositions: new Map(Object.entries(state.scroll_positions!)),
                  });
                  return { projects: next };
                });
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

            // Stagger next project restoration to next idle period
            if (idx + 1 < projectIds.length) {
              requestIdleCallback(() => restoreProjectState(idx + 1));
            }
          };

          // Start restoring non-critical state after first paint
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

        // Load profile identity + avatar (non-blocking, after app is ready)
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

      const {
        controlPanelVisible,
        fontSize,
        panelFontSize,
        editorFontSize,
        fontWeight,
        keybindings,
        theme,
        controlPanelWidth,
        completionSound,
        selectedModel,
        punkBackend,
        httpProvider,
        httpApiKeys,
        httpBaseUrls,
        intentRouting,
        intentAutoRoute,
      } = useWorkspaceStore.getState();
      const { projects, activeProjectId, projectOrder } =
        useProjectsStore.getState();

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
          recent_files: p.recentFiles,
          scroll_positions: Object.fromEntries(p.scrollPositions.entries()),
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
        keybindings,
        theme,
        panel_width: controlPanelWidth,
        completion_sound: completionSound,
        selected_model: selectedModel,
        punk_backend: punkBackend,
        http_provider: httpProvider,
        // Always persist all provider keys — not just the active one
        http_api_keys: httpApiKeys,
        http_base_urls: httpBaseUrls,
        intent_routing: intentRouting as any,
        intent_auto_route: intentAutoRoute,
      }).catch(console.error);
    };

    // Debounced save for rapid changes (font size, panel resize, key typing)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedSave = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(save, 500);
    };

    // Save when any workspace setting changes — including API keys
    const unsubWorkspace = useWorkspaceStore.subscribe((state, prev) => {
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
        state.punkBackend !== prev.punkBackend ||
        // API key changes — reference check is sufficient since setHttpApiKeys always creates a new object
        state.httpApiKeys !== prev.httpApiKeys ||
        state.httpProvider !== prev.httpProvider ||
        state.httpBaseUrls !== prev.httpBaseUrls ||
        state.intentRouting !== prev.intentRouting ||
        state.intentAutoRoute !== prev.intentAutoRoute
      ) {
        debouncedSave();
      }
    });

    // Save when structural project state changes (not conversation streaming)
    // Track a fingerprint of the structural fields to avoid iterating all projects
    let lastStructuralKey = "";
    const computeStructuralKey = (
      state: ReturnType<typeof useProjectsStore.getState>,
    ) => {
      const parts: string[] = [
        state.activeProjectId ?? "",
        state.projectOrder.join(","),
      ];
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

    // Save conversation history when messages change
    let convDebounce: ReturnType<typeof setTimeout> | null = null;
    const lastConvKeys = new Map<string, string>();
    const convKey = (
      p: ReturnType<typeof useProjectsStore.getState>["projects"] extends Map<
        string,
        infer V
      >
        ? V
        : never,
    ) =>
      `${p.conversation.messages.length}:${p.conversation.sessionId ?? ""}:${p.conversation.model ?? ""}:${p.conversation.isProcessing}`;

    // Initialize keys
    for (const [id, p] of useProjectsStore.getState().projects) {
      lastConvKeys.set(id, convKey(p));
    }

    const unsubConversation = useProjectsStore.subscribe((state) => {
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
          if (
            p.conversation.messages.length > 0 &&
            !p.conversation.isProcessing
          ) {
            saveConversation(pid, {
              sessionId: p.conversation.sessionId,
              model: p.conversation.model,
              messages: p.conversation.messages,
            }).catch(console.error);
          }
        }
      }, 1000);
    });

    const handleBeforeUnload = () => {
      save();
    };

    // --- Intelligence Layer: sync state to ~/.pane/state/ for MCP server ---
    let editorSyncTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubEditorSync = useProjectsStore.subscribe((state, prev) => {
      const activeId = state.activeProjectId;
      if (!activeId || !settingsLoaded) return;
      const project = state.projects.get(activeId);
      const prevProject = prev.projects.get(activeId);
      if (
        project?.activeFilePath !== prevProject?.activeFilePath ||
        state.activeProjectId !== prev.activeProjectId
      ) {
        if (editorSyncTimer) clearTimeout(editorSyncTimer);
        editorSyncTimer = setTimeout(() => {
          if (!project) return;
          writeEditorState(activeId, {
            activeFile: project.activeFilePath,
            content: project.activeFileContent,
            recentFiles: project.recentFiles,
          }).catch(() => {});
        }, 300);
      }
    });

    // Sync project state on git branch change
    let projectSyncTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubProjectSync = useProjectsStore.subscribe((state, prev) => {
      if (!settingsLoaded) return;
      for (const [id, project] of state.projects) {
        const prevProject = prev.projects.get(id);
        if (project.git.branch !== prevProject?.git.branch || !prevProject) {
          if (projectSyncTimer) clearTimeout(projectSyncTimer);
          projectSyncTimer = setTimeout(() => {
            writeProjectState(id, {
              name: project.name,
              root: project.root,
              gitBranch: project.git.branch,
              topLevelFiles:
                project.dirContents.get(project.root)?.map((e) => e.name) ?? [],
            }).catch(() => {});
          }, 500);
        }
      }
    });

    window.addEventListener("beforeunload", handleBeforeUnload);
    const interval = setInterval(save, 30000);

    return () => {
      unsubWorkspace();
      unsubProjects();
      unsubConversation();
      unsubEditorSync();
      unsubProjectSync();
      if (editorSyncTimer) clearTimeout(editorSyncTimer);
      if (projectSyncTimer) clearTimeout(projectSyncTimer);
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
