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
  label?: string;
  phase?: string;
}

// --- Delta tracking for conversation persistence ---
//
// Tracks the last persisted message ID per conversation so we only send
// new/modified messages over IPC, instead of the entire conversation array.
// Keyed by `${projectId}:${conversationId}` for per-conversation tracking.
// Combined with debouncing, this eliminates main-process event loop blocking.
const lastPersistedMessageId = new Map<string, string | null>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

function convDeltaKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}

async function saveConversation(
  projectId: string,
  conversationId: string | null,
  conversation: PersistedConversation,
): Promise<void> {
  await saveConversationToMain(projectId, conversationId, conversation);
}

/**
 * Save only messages that have changed since the last persist for a specific conversation.
 * Uses the same delta logic as before but scoped by (projectId, conversationId).
 */
function saveConversationDelta(projectId: string, conversationId: string | null): void {
  const ps = useProjectsStore.getState();
  const p = ps.projects.get(projectId);
  if (!p) return;

  // If conversationId is null, fall back to project.conversation (backward compat)
  const conv = conversationId
    ? p.conversations.get(conversationId)?.state
    : p.conversation;
  if (!conv) return;

  const messages = conv.messages;
  const key = conversationId ? convDeltaKey(projectId, conversationId) : projectId;
  const lastId = lastPersistedMessageId.get(key) ?? null;

  let sliceStart = 0;
  if (lastId) {
    const idx = messages.findIndex((m) => m.id === lastId);
    if (idx !== -1) {
      sliceStart = idx;
    }
  }

  const delta = messages.slice(sliceStart);
  if (delta.length === 0) return;

  // Get conversation meta for label/phase passthrough to DB lazy creation
  const convMeta = conversationId ? p.conversations.get(conversationId) : null;

  saveConversation(projectId, conversationId, {
    model: conv.model,
    messages: delta,
    startIndex: conv.historyStartIndex,
    label: convMeta?.label ?? undefined,
    phase: convMeta?.phase ?? undefined,
  })
    .then(() => {
      const last = delta[delta.length - 1];
      if (last?.id) {
        lastPersistedMessageId.set(key, last.id);
      }
    })
    .catch(() => {});
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
        if (settings.curated_models) ws.setCuratedModels(settings.curated_models);

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

          // ── Hydrate conversations from DB ──────────────────────────────
          // Replace the in-memory "main" conversations (created with fresh UUIDs
          // by createProject) with the actual conversations stored in SQLite.
          // This prevents BUG-1: fresh UUID = no messages found on restart.
          (async () => {
            const { getProjectConversations, createConversation } = await import("../lib/tauri-commands");
            const { createEmptyConversationMeta } = await import("../lib/punk-types");
            for (const { id: projId } of projectEntries) {
              try {
                const result = await getProjectConversations(projId);
                const ps = useProjectsStore.getState();
                const proj = ps.projects.get(projId);
                if (!proj) continue;

                if (result.conversations?.length > 0) {
                  // Build conversations Map from DB rows
                  const nextConvs = new Map<string, import("../lib/punk-types").Conversation>();
                  const nextOrder: string[] = [];

                  for (const row of result.conversations) {
                    const convRow = row as { id: string; label: string; phase: string; model: string | null };
                    const conv = createEmptyConversationMeta(convRow.id, convRow.label);
                    conv.phase = convRow.phase as import("../lib/punk-types").PanePhase;
                    conv.state.model = convRow.model ?? null;
                    nextConvs.set(convRow.id, conv);
                    nextOrder.push(convRow.id);
                  }

                  // Auto-select the most recent conversation. With tab bar visible,
                  // user can always click "+" to create new or navigate to picker.
                  const firstDbConvId = nextOrder[0]!;
                  const firstConv = nextConvs.get(firstDbConvId);
                  useProjectsStore.setState((s) => {
                    const nextProjs = new Map(s.projects);
                    nextProjs.set(projId, {
                      ...proj,
                      conversations: nextConvs,
                      activeConversationId: firstDbConvId,
                      conversationOrder: nextOrder,
                      conversation: firstConv?.state ?? proj.conversation,
                    });
                    return { projects: nextProjs };
                  });
                } else {
                  // No conversations in DB — create a default one so the project
                  // isn't blank (happens when all empty conversations were deleted).
                  const convId = crypto.randomUUID();
                  const defaultConv = createEmptyConversationMeta(convId, "Conversation");
                  useProjectsStore.setState((s) => {
                    const nextProjs = new Map(s.projects);
                    nextProjs.set(projId, {
                      ...proj,
                      conversations: new Map([[convId, defaultConv]]),
                      activeConversationId: convId,
                      conversationOrder: [convId],
                      conversation: defaultConv.state,
                    });
                    return { projects: nextProjs };
                  });
                  // Persist to DB
                  createConversation(projId, "Conversation", "idle", null, convId).catch(() => {});
                }
              } catch (err) {
                console.warn(`[persistence] Failed to hydrate conversations for ${projId}:`, err);
              }
            }
          })();

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
        curated_models: ws.curatedModels,
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
        state.autoEscalate !== prev.autoEscalate ||
        state.curatedModels !== prev.curatedModels
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

        // Skip while conversation is being loaded from SQLite.
        if (restoringProjects.has(id)) continue;

        // Iterate ALL conversations for this project (both active and inactive).
        // Inactive conversations may be streaming in the background.
        const convIds = new Set([
          ...p.conversations.keys(),
          ...(pp?.conversations.keys() ?? []),
        ]);
        for (const convId of convIds) {
          const conv = p.conversations.get(convId);
          const prevConv = pp?.conversations.get(convId);
          if (!conv) continue;

          const countChanged =
            conv.state.messages.length !== (prevConv?.state.messages.length ?? 0);
          const finished =
            !conv.state.isProcessing && prevConv?.state.isProcessing;

          if (countChanged || finished) {
            const key = convDeltaKey(id, convId);
            const existing = debounceTimers.get(key);
            if (existing) clearTimeout(existing);

            if (finished) {
              // Flush immediately — the turn is done
              saveConversationDelta(id, convId);
            } else {
              debounceTimers.set(
                key,
                setTimeout(() => saveConversationDelta(id, convId), DEBOUNCE_MS),
              );
            }
          }
        }

        // BACKWARD COMPAT PATH REMOVED (2026-05-16)
        // This previously saved `p.conversation` changes with `null` conversationId,
        // which overwrote the correct per-conversation saves (INSERT OR REPLACE on
        // message IDs) — all messages ended up with conversation_id=NULL in the DB,
        // invisible to getConversationSlice which queries by conversation_id.
        // All conversation mutations now route through getActiveConv/updateActiveConv
        // which update both the Map AND the backward compat field. The per-conversation
        // iteration above catches every change.
      }
    });

    const handleBeforeUnload = () => {
      // Flush workspace state
      save();
      // Flush any pending conversation deltas
      for (const [key, timer] of debounceTimers) {
        clearTimeout(timer);
        const parts = key.split(":");
        if (parts.length === 2) {
          // Per-conversation key: "projectId:conversationId"
          saveConversationDelta(parts[0]!, parts[1]!);
        }
        // Legacy key ("projectId") ignored — backward compat path was removed.
        // These keys should never exist after the fix, but if they do, skip to
        // avoid overwriting conversation_id with NULL.
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    const interval = setInterval(save, 60000);

    return () => {
      unsubWorkspace();
      unsubProjects();
      unsubConversation();
      window.removeEventListener("beforeunload", handleBeforeUnload);
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
      // Clear debounce timers
      for (const [, timer] of debounceTimers) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      if (loadedRef.current) save();
    };
  }, []);
}
