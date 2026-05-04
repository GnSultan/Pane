import { useEffect, useRef } from "react";
import {
  loadSettings,
  saveSettings,
  getCwd,
  detectProjectRoot,
  readFile,
  saveConversationToMain,
  checkPathExists,
  migrateProjectId,
  getAllThreadStates,
} from "../lib/tauri-commands";
import type { ProjectSessionState } from "../lib/tauri-commands";
import type { ConversationMessage } from "../lib/punk-types";
import { useWorkspaceStore, type Theme } from "../stores/workspace";
import { useProjectsStore } from "../stores/projects";
import type { ActionId, KeyBinding } from "../lib/keybindings";
import {
  DEFAULT_POWER_COMBO,
  type PowerCombo,
} from "../lib/models";

/** Shape returned by thread-state.mjs — persisted per-project activity data. */
interface ThreadStateData {
  lastUserPromptText?: string | null;
  lastResponseSummary?: string | null;
  lastActivityAt?: number | null;
}

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
        if (settings.font_size) ws.setFontSize(settings.font_size);
        if (settings.panel_font_size)
          ws.setPanelFontSize(settings.panel_font_size);
        if (settings.editor_font_size)
          ws.setEditorFontSize(settings.editor_font_size);
        if (settings.font_weight) ws.setFontWeight(settings.font_weight);
        if (settings.keybindings)
          ws.setKeybindingsRaw(settings.keybindings as Partial<Record<ActionId, KeyBinding>>);
        if (settings.theme) ws.setTheme(settings.theme as Theme);
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

        // 3. Routing restore — flat PowerCombo { thinking, execution }
        //    Migration path: old format was keyed by backend ("api", "claude-code", "gemini")
        const rawCombo = settings.power_combo as Record<string, unknown> | undefined;
        const legacyRouting = settings.intent_routing as Record<string, unknown> | undefined;
        let restoredCombo: PowerCombo | null = null;

        if (rawCombo?.thinking && rawCombo?.execution) {
          // New flat format
          restoredCombo = rawCombo as unknown as PowerCombo;
        } else if (rawCombo && typeof rawCombo === "object") {
          // Old keyed format — pick the most specific key available
          const keyed = (rawCombo["claude-code"] || rawCombo["api"] || rawCombo["gemini"]) as Record<string, unknown> | undefined;
          if (keyed?.thinking && keyed?.execution) restoredCombo = keyed as unknown as PowerCombo;
        } else if (legacyRouting) {
          // Oldest format: 4-slot intent_routing
          const r = (legacyRouting["claude-code"] || legacyRouting["api"]) as Record<string, unknown> | undefined;
          if (r?.plan && r?.execute) {
            restoredCombo = { thinking: r.plan as PowerCombo["thinking"], execution: r.execute as PowerCombo["execution"] };
          }
        }

        useWorkspaceStore.setState({ powerCombo: restoredCombo ?? DEFAULT_POWER_COMBO });

        if (settings.intent_auto_route !== undefined) {
          ws.setAutoEscalate(settings.intent_auto_route);
        }

        // 4. Project restoration — conversations load lazily in Conversation.tsx
        const { addProject, setActiveProject, toggleDir, markRootMissing } =
          useProjectsStore.getState();

        // project_ids maps root path → stable ID.
        // On first launch after this update, existing projects won't have entries
        // here. We fall back to the OLD derived-ID formula so their data
        // (SQLite rows, memory files, brain graph) stays intact. New projects
        // added after this update get real UUIDs.
        const projectIds: Record<string, string> = settings.project_ids ?? {};

        /** Reproduce the pre-UUID derived ID from a root path. */
        function deriveOldId(root: string): string {
          const name = root.split("/").filter(Boolean).pop() || root;
          return name.toLowerCase().replace(/[^a-z0-9]/g, "-");
        }

        if (settings.project_roots?.length > 0) {
          let activeId: string | null = null;
          const projectIds_: Record<string, string> = { ...projectIds };
          const projectEntries: Array<{ id: string; root: string }> = [];
          // Track which projects need migration: { root, oldId, newId }
          const toMigrate: Array<{ root: string; oldId: string; newId: string }> = [];

          for (const root of settings.project_roots as string[]) {
            if (projectIds_[root]) {
              // Already has a stable ID — no migration needed
              const id = addProject(root, projectIds_[root]);
              projectEntries.push({ id, root });
              if (root === settings.active_project_root) activeId = id;
            } else {
              // First launch after the update — derive the old ID, generate a UUID,
              // and queue a migration so all data moves to the UUID atomically.
              const oldId = deriveOldId(root);
              const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
                ? crypto.randomUUID()
                : `proj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
              toMigrate.push({ root, oldId, newId });
              // Load the project immediately with the old ID so the UI isn't
              // blocked waiting for the async migration to finish.
              const id = addProject(root, oldId);
              projectEntries.push({ id, root });
              if (root === settings.active_project_root) activeId = id;
            }
          }

          if (activeId) setActiveProject(activeId);

          // Mark all as restored AFTER the loops
          for (const { id } of projectEntries) {
            useProjectsStore.getState().setConversationRestored(id, true);
          }

          // Hydrate thread activity data from persisted state
          const threadStates: Record<string, unknown> = await getAllThreadStates(projectEntries.map(e => e.id));
          for (const [id, raw] of Object.entries(threadStates)) {
            if (!raw) continue;
            const state = raw as ThreadStateData;
            if (!state.lastUserPromptText && !state.lastActivityAt) continue;
            useProjectsStore.getState().setThreadActivity(id, {
              lastUserPromptText: state.lastUserPromptText ?? null,
              lastResponseSummary: state.lastResponseSummary ?? null,
              lastActivityAt: state.lastActivityAt ?? null,
            });
          }

          // Run migrations in the background — swap each project from its old
          // derived ID to a real UUID. The project is already loaded and usable
          // with the old ID; after migration completes we swap the store entry
          // to the UUID and write the updated project_ids to disk.
          if (toMigrate.length > 0) {
            Promise.all(
              toMigrate.map(async ({ root, oldId, newId }) => {
                const result = await migrateProjectId(oldId, newId).catch(() => ({ success: false }));
                if (result.success) {
                  // Swap the store: rebind from oldId → newId so subsequent
                  // data writes (conversations, brain, etc.) use the UUID.
                  useProjectsStore.getState().migrateProjectId(oldId, newId);
                  projectIds_[root] = newId;
                } else {
                  // Migration failed — keep the old derived ID as a stable
                  // fallback. It'll be retried on the next launch.
                  projectIds_[root] = oldId;
                }
              })
            ).then(() => {
              saveSettings({ project_ids: projectIds_ }).catch(() => {});
              // Path-existence check after migration so we use final IDs
              _checkMissingRoots(projectEntries.map(({ root }) => ({
                id: projectIds_[root]!,
                root,
              })));
            }).catch(() => {});
          } else if (JSON.stringify(projectIds_) !== JSON.stringify(projectIds)) {
            // No migrations needed but projectIds_ may have changed (e.g. a
            // write-back from a previous partial run). Persist it.
            saveSettings({ project_ids: projectIds_ }).catch(() => {});
            _checkMissingRoots(projectEntries);
          } else {
            _checkMissingRoots(projectEntries);
          }

          function _checkMissingRoots(entries: Array<{ id: string; root: string }>) {
            Promise.all(
              entries.map(async ({ id, root }) => {
                const exists = await checkPathExists(root).catch(() => true);
                if (!exists) markRootMissing(id, true);
              })
            ).catch(() => {});
          }

          const restoreProjectState = (idx: number) => {
            if (idx >= projectEntries.length) return;
            const { id, root } = projectEntries[idx]!;
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
              // Restore per-project power combo and auto-escalate
              if (state.power_combo) {
                useProjectsStore.getState().setProjectPowerCombo(id, state.power_combo);
              }
              if (state.auto_escalate !== undefined) {
                useProjectsStore.getState().setProjectAutoEscalate(id, state.auto_escalate);
              }
              // Restore per-project selected model
              if (state.selected_model) {
                useProjectsStore.getState().setProjectSelectedModel(
                  id,
                  state.selected_model,
                  state.selected_model_thinking ?? false,
                  state.selected_model_provider,
                );
              }
              // Restore archived status after all other state is applied
              if (state.archived) {
                useProjectsStore.getState().archiveProject(id);
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
            if (idx + 1 < projectEntries.length) {
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
      const project_ids: Record<string, string> = {};

      for (const id of ps.projectOrder) {
        const p = ps.projects.get(id);
        if (!p) continue;
        project_roots.push(p.root);
        project_ids[p.root] = p.id; // always persist the stable ID
        project_states[p.root] = {
          name: p.name,
          expanded_dirs: Array.from(p.expandedDirs),
          active_file_path: p.activeFilePath,
          recent_files: p.recentFiles,
          scroll_positions: Object.fromEntries(p.scrollPositions.entries()),
          power_combo: p.powerCombo,
          auto_escalate: p.autoEscalate,
          selected_model: p.selectedModel,
          selected_model_provider: p.selectedModelProvider,
          selected_model_thinking: p.selectedModelThinking,
          archived: p.archived ?? false,
        };
      }

      saveSettings({
        project_roots,
        active_project_root: activeProject?.root ?? null,
        project_ids,
        project_states,
        font_size: ws.fontSize,
        panel_font_size: ws.panelFontSize,
        editor_font_size: ws.editorFontSize,
        font_weight: ws.fontWeight,
        keybindings: ws.keybindings,
        theme: ws.theme,
        completion_sound: ws.completionSound,
        selected_model: ws.selectedModel,
        selected_model_provider: ws.selectedModelProvider,

        punk_backend: ws.punkBackend,
        http_provider: ws.httpProvider,
        http_api_keys: ws.httpApiKeys,
        http_base_urls: ws.httpBaseUrls,
        disabled_providers: ws.disabledProviders,
        power_combo: ws.powerCombo,
        intent_auto_route: ws.autoEscalate,
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
        JSON.stringify(state.powerCombo) !==
        JSON.stringify(prev.powerCombo);
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
        state.completionSound !== prev.completionSound ||
        state.selectedModel !== prev.selectedModel ||
        state.selectedModelProvider !== prev.selectedModelProvider ||
        state.punkBackend !== prev.punkBackend ||
        state.httpProvider !== prev.httpProvider ||
        routingChanged ||
        keysChanged ||
        urlsChanged ||
        state.autoEscalate !== prev.autoEscalate
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
