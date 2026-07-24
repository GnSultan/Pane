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

// --- Delta tracking for conversation persistence ---
//
// Tracks the last persisted message array index per project so we only send
// new/modified messages over IPC, instead of the entire conversation array
// every time. Uses array index instead of message ID — avoids O(n) findIndex
// scan and the fallback-to-full-array bug when context window trims messages
// from the front (the index is adjusted naturally by array length changes).
// Combined with debouncing, this eliminates main-process event loop blocking
// that causes 15-second UI freezes in deep sessions.
const lastPersistedMessageIndex = new Map<string, number>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

async function saveConversation(
  projectId: string,
  conversation: PersistedConversation,
): Promise<void> {
  // Passes projectId directly — main process owns storage (SQLite).
  await saveConversationToMain(projectId, conversation);
}

/**
 * Save only messages that have changed since the last persist.
 *
 * Tracks the array INDEX of the last persisted message. Starts from that
 * index (inclusive) on the next save to cover in-place streaming updates.
 *
 * If the array was trimmed from the front (context window management) and
 * the saved index is now >= messages.length, falls back to 0. This is rare
 * — only happens once per context window edge, not on every save cycle.
 */
function saveConversationDelta(projectId: string): void {
  const ps = useProjectsStore.getState();
  const p = ps.projects.get(projectId);
  if (!p) return;

  const messages = p.conversation.messages;
  const lastIdx = lastPersistedMessageIndex.get(projectId) ?? -1;

  // Start from the last persisted index (inclusive) to cover in-place
  // streaming updates. If index is out of range (trimming happened),
  // start from the beginning of the current array.
  const sliceStart = (lastIdx >= 0 && lastIdx < messages.length) ? lastIdx : 0;
  const delta = messages.slice(sliceStart);
  if (delta.length === 0) return;

  saveConversation(projectId, {
    model: p.conversation.model,
    messages: delta,
    startIndex: p.conversation.historyStartIndex,
  })
    .then(() => {
      // Store the array index of the last message in this delta
      lastPersistedMessageIndex.set(projectId, sliceStart + delta.length - 1);
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
        const { addProject, setActiveProject, markRootMissing } =
          useProjectsStore.getState();

        // ── Recovery: UUID-keyed project_states without project_order/project_ids ──
        // An intermediate save (from migrating root-keyed → ID-keyed states) may
        // have written project_states keyed by UUID without writing project_order
        // or project_ids. Rebuild the mapping by matching state names to folder
        // names so the existing data isn't orphaned.
        const _psKeys = Object.keys(settings.project_states ?? {});
        if (_psKeys.length > 0 && !settings.project_order) {
          const _firstKey = _psKeys[0];
          if (_firstKey && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(_firstKey)) {
            const _roots = settings.project_roots ?? [];
            const _folderToRoot: Record<string, string> = {};
            for (const _r of _roots) {
              const _f = _r.split('/').filter(Boolean).pop() || '';
              if (_f) _folderToRoot[_f] = _r;
            }
            const _recoveredIds: Record<string, string> = {};
            const _recoveredOrder: string[] = [];
            const _matchedUuids = new Set<string>();
            // Track the last matched root so same-folder threads can inherit it
            let _lastMatchedRoot: string | null = null;
            // First pass: match by name (case-insensitive)
            for (const [_uuid, _state] of Object.entries(settings.project_states)) {
              const _sname = _state.name || '';
              if (!_sname) continue;
              let _matchedRoot: string | null = null;
              if (_folderToRoot[_sname]) {
                _matchedRoot = _folderToRoot[_sname];
              } else {
                const _lower = _sname.toLowerCase();
                for (const [folder, root] of Object.entries(_folderToRoot)) {
                  if (folder.toLowerCase() === _lower) { _matchedRoot = root; break; }
                }
              }
              if (_matchedRoot) {
                _recoveredIds[_uuid] = _matchedRoot; // id→root
                _recoveredOrder.push(_uuid);
                _matchedUuids.add(_uuid);
                _lastMatchedRoot = _matchedRoot;
              }
            }
            // Second pass: unmatched UUIDs (same-folder threads) — attach to
            // the last matched root. Add id→root entries so the NEW format
            // load path (which builds idToRoot from project_ids) can find their root.
            for (const [_uuid, _state] of Object.entries(settings.project_states)) {
              if (_matchedUuids.has(_uuid)) continue;
              // Pick a root: last matched root, or first root, or last root
              const _fallbackRoot = _lastMatchedRoot ?? _roots[0] ?? (_roots.length > 0 ? _roots[_roots.length - 1] : null);
              if (_fallbackRoot) {
                _recoveredOrder.push(_uuid);
                _recoveredIds[_uuid] = _fallbackRoot; // id→root format
                _matchedUuids.add(_uuid);
              }
            }
            settings.project_ids = _recoveredIds;
            settings.project_order = _recoveredOrder;
            // Inject root into each state entry for future-proofing
            const _nameToRoot: Record<string, string> = {};
            for (const [folder, root] of Object.entries(_folderToRoot)) {
              _nameToRoot[folder.toLowerCase()] = root;
            }
            for (const [_uuid, _state] of Object.entries(settings.project_states)) {
              if (!_state.root) {
                const _sname = _state.name || '';
                const _matchedRoot = _nameToRoot[_sname.toLowerCase()] ?? _recoveredIds[_uuid] ?? (_roots.length > 0 ? _roots[_roots.length - 1] : undefined);
                (_state as ProjectSessionState).root = _matchedRoot;
              }
            }
          }
        }

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

          // NEW FORMAT: project_order is the authoritative ordered list of
          // project IDs. project_ids may be in old format (root→id) or new
          // format (id→root). Build a reverse map to handle both.
          const projectOrderSetting: string[] = settings.project_order ?? [];
          if (projectOrderSetting.length > 0) {
            // Build id→root from project_ids regardless of format
            const idToRoot: Record<string, string> = {};
            for (const [key, val] of Object.entries(projectIds_)) {
              if (key.startsWith("/")) {
                // Old format: root → id
                idToRoot[val] = key;
              } else {
                // New format: id → root
                idToRoot[key] = val;
              }
            }
            for (const pid of projectOrderSetting) {
              let root = idToRoot[pid];
              // root may be undefined (not in idToRoot) or "" (empty root thread)
              if (root === undefined) {
                // Fallback: derive root from project_states entry. Handles
                // multiple threads on the same folder when project_ids is
                // still in root→id format (only one ID survives per root).
                root = (settings.project_states?.[pid] as ProjectSessionState | undefined)?.root;
              }
              // root may be "" for unbound threads or undefined for truly orphaned
              const stateEntry = settings.project_states?.[pid] as ProjectSessionState | undefined;
              const nameOverride = stateEntry?.name;
              const finalRoot = root ?? "";
              const id = addProject(finalRoot, pid, nameOverride);
              projectEntries.push({ id, root: finalRoot });
              if (finalRoot && finalRoot === settings.active_project_root) activeId = id;
            }
          } else {
            // OLD FORMAT: iterate project_roots with dedup by seen ID.
            // Pre-project_order settings could have duplicate roots for
            // multiple threads on the same folder. On load, the loop would
            // call addProject with the same stableId N times, creating N
            // duplicate entries in projectOrder. Dedup here prevents that.
            const seenIds = new Set<string>();
            for (const root of settings.project_roots as string[]) {
              if (projectIds_[root]) {
                const pid = projectIds_[root]!;
                if (seenIds.has(pid)) continue; // skip duplicate
                seenIds.add(pid);
                const id = addProject(root, pid);
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
                  projectIds_[newId] = root;
                } else {
                  // Migration failed — keep the old derived ID as a stable
                  // fallback. It'll be retried on the next launch.
                  projectIds_[oldId] = root;
                }
              })
            ).then(() => {
              saveSettings({ project_ids: projectIds_ }).catch(() => {});
              // Path-existence check after migration — use final IDs from
              // the id→root map (projectIds_[newId] === root means success)
              _checkMissingRoots(
                toMigrate.map(({ root, newId, oldId }) => ({
                  id: projectIds_[newId] === root ? newId : oldId,
                  root,
                }))
              );
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
              entries
                .filter(({ root }) => root) // unbound threads have no path to check
                .map(async ({ id, root }) => {
                  const exists = await checkPathExists(root).catch(() => true);
                  if (!exists) markRootMissing(id, true);
                })
            ).catch(() => {});
          }

          const restoreProjectState = (idx: number) => {
            if (idx >= projectEntries.length) return;
            const { id, root } = projectEntries[idx]!;
            // New format: project_states is keyed by project ID.
            // Old format: keyed by root path. Try ID first, then root.
            const state: ProjectSessionState | undefined =
              settings.project_states?.[id] ?? settings.project_states?.[root];

            if (state) {
              // Batch all sync mutations into ONE setState() instead of 8+
              // individual calls — each separate call triggers Zustand's full
              // subscriber cascade (computeStructuralKey, re-renders, etc.).
              restoringProjects.add(id);
              useProjectsStore.setState((s) => {
                const proj = s.projects.get(id);
                if (!proj) return s;
                const updated = { ...proj };

                // name
                if (state.name) updated.name = state.name;

                // expanded dirs
                if (state.expanded_dirs?.length) {
                  const nextDirs = new Set(updated.expandedDirs);
                  for (const dir of state.expanded_dirs) nextDirs.add(dir);
                  updated.expandedDirs = nextDirs;
                }

                // recent files
                if (state.recent_files?.length) {
                  updated.recentFiles = state.recent_files;
                }

                // scroll positions
                if (state.scroll_positions) {
                  updated.scrollPositions = new Map(
                    Object.entries(state.scroll_positions),
                  );
                }

                // power combo
                if (state.power_combo) {
                  updated.powerCombo = state.power_combo;
                }

                // auto-escalate
                if (state.auto_escalate !== undefined) {
                  updated.autoEscalate = state.auto_escalate;
                }

                // selected model
                if (state.selected_model) {
                  updated.selectedModel = state.selected_model;
                  updated.selectedModelThinking = state.selected_model_thinking ?? false;
                  updated.selectedModelProvider = state.selected_model_provider;
                }

                // archived — also handle activeProjectId if this was the active project
                if (state.archived) {
                  updated.archived = true;
                  const nextProjects = new Map(s.projects);
                  nextProjects.set(id, updated);
                  const active = s.activeProjectId;
                  const newActive = active === id
                    ? s.projectOrder.find((oid) => {
                        const other = s.projects.get(oid);
                        return other && !other.archived && oid !== id;
                      }) ?? null
                    : active;
                  return { projects: nextProjects, activeProjectId: newActive };
                }

                const nextProjects = new Map(s.projects);
                nextProjects.set(id, updated);
                return { projects: nextProjects };
              });

              // Re-store individual setting setters for side effects that aren't
              // covered by the batched setState above (e.g. `renameProject` also
              // updates conversation meta). These fire store subscribers again,
              // but we're inside restoringProjects so the structural key and
              // conversation persistence subscribers bail out.
              if (state.name) useProjectsStore.getState().renameProject(id, state.name);

              // Handle active_file_path asynchronously — can't batch this
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
            restoringProjects.delete(id);
            if (idx + 1 < projectEntries.length) {
              requestIdleCallback(() => restoreProjectState(idx + 1));
            } else {
              // Restore chain complete — clearing restoringProjects lets the
              // unsubProjects subscriber run on the next store update, which
              // will recompute the structural key and save if needed.
              restoringProjects.clear();
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

      const seenRoots = new Set<string>();
      for (const id of ps.projectOrder) {
        const p = ps.projects.get(id);
        if (!p) continue;
        // Deduplicate project_roots so the load-side iterator
        // doesn't create duplicate projectOrder entries.
        // Skip empty roots (unbound threads) — they have no folder to track.
        if (p.root && !seenRoots.has(p.root)) {
          project_roots.push(p.root);
          seenRoots.add(p.root);
        }
        project_ids[p.id] = p.root; // id→root — supports multiple threads per folder, empty for unbound
        project_states[id] = {       // KEY BY ID (not root) — supports multiple threads on same folder
          root: p.root,
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
      // Save projectOrder explicitly so the load side can restore
      // the exact set of projects (including multiple on the same root)
      // instead of guessing from deduped project_roots.
      const project_order = ps.projectOrder;

      saveSettings({
        project_roots,
        project_order,
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
      // Skip while restore cascade is running — avoids O(N) iteration over
      // ALL projects on every batch store update during startup.
      if (restoringProjects.size > 0) return;
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

        // Save when message count changes or session finishes.
        // Uses delta persistence (only new/modified messages) + debounce
        // to avoid blocking the main process event loop for seconds at a time.
        const countChanged =
          p.conversation.messages.length !== pp?.conversation.messages.length;
        const finished =
          !p.conversation.isProcessing && pp?.conversation.isProcessing;

        if (countChanged || finished) {
          // Cancel any pending debounced save for this project
          const existing = debounceTimers.get(id);
          if (existing) clearTimeout(existing);

          if (finished) {
            // Flush immediately — the turn is done, persist final state now
            saveConversationDelta(id);
          } else {
            // Debounce: accumulate changes within the window, save once
            debounceTimers.set(
              id,
              setTimeout(() => saveConversationDelta(id), DEBOUNCE_MS),
            );
          }
        }
      }
    });

    const handleBeforeUnload = () => {
      // Flush workspace state
      save();
      // Flush any pending conversation deltas
      for (const [projectId, timer] of debounceTimers) {
        clearTimeout(timer);
        saveConversationDelta(projectId);
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
