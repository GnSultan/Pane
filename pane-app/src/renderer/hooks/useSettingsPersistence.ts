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
import { useWorkspaceStore, type Theme } from "../stores/workspace";
import { useProjectsStore } from "../stores/projects";
import type { ActionId, KeyBinding } from "../lib/keybindings";
import {
  DEFAULT_BACKEND_ROUTING,
  type IntentRouting,
  type BackendRouting,
  PROVIDER_MODELS,
} from "../lib/models";

// App readiness gate — other hooks (git, watcher) wait for this before starting
let resolveAppReady: () => void;
export const appReadyPromise = new Promise<void>((resolve) => {
  resolveAppReady = resolve;
});

// Use a ref for settingsLoaded to avoid HMR resets if possible,
// but for now let's just make sure it's reliable.
let settingsLoadedGlobal = false;
let paneDir = "";

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
  
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const THRESHOLD_SIZE = 4 * 1024 * 1024; // 4MB (compact before hitting limit)
  
  // Function to calculate JSON size
  const calculateSize = (obj: unknown) => new Blob([JSON.stringify(obj)]).size;
  
  let jsonSize = calculateSize(data);
  
  // Check if the conversation would exceed the threshold
  if (jsonSize > THRESHOLD_SIZE) {
    console.warn(`[persistence] Conversation size ${jsonSize} bytes exceeds threshold, compacting...`);
    
    const messages = data.messages;
    const originalCount = messages.length;
    let keepCount = Math.min(100, originalCount);
    
    // Aggressive compaction if still too large
    if (jsonSize > MAX_FILE_SIZE) {
      console.log(`[persistence] File exceeds maximum size, applying aggressive compaction`);
      keepCount = Math.min(50, originalCount);
    }
    
    // Keep only recent messages
    data.messages = messages.slice(-keepCount);
    
    jsonSize = calculateSize(data);
    const reduction = ((originalCount - keepCount) / originalCount * 100).toFixed(1);
    console.log(`[persistence] Compacted: ${originalCount} → ${keepCount} messages (${reduction}% reduction)`);
    console.log(`[persistence] New size: ${jsonSize} bytes`);
    
    // If still too large after basic compaction, apply aggressive truncation
    if (jsonSize > MAX_FILE_SIZE) {
      console.log(`[persistence] Still too large, truncating content fields...`);
      
      // Truncate large content fields in the remaining messages
      data.messages = data.messages.map((msg) => {
        if (msg.content && typeof msg.content === 'object') {
          // Handle array content (typical for Claude/OpenAI format)
          const content = Array.isArray(msg.content) ? msg.content : [msg.content];
          const truncatedContent = content.map((item) => {
            if (typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') {
              // Truncate text fields to 2000 chars
              const text = item.text;
              if (text && text.length > 2000) {
                return {
                  ...item,
                  text: text.substring(0, 1500) + '\n\n... [truncated] ...\n\n' + text.substring(text.length - 500)
                };
              }
            }
            return item;
          });
          return { ...msg, content: truncatedContent };
        }
        return msg;
      });
      
      jsonSize = calculateSize(data);
      console.log(`[persistence] After content truncation: ${jsonSize} bytes`);
    }
  }
  
  // Final safety check - if still too large, log an error
  if (jsonSize > MAX_FILE_SIZE) {
    console.error(`[persistence] ERROR: Unable to compact conversation to under 5MB (final size: ${jsonSize} bytes)`);
    // Still save it, but the file may not be readable
  }
  
  await writeFile(conversationPath(projectId), JSON.stringify(data));
}

async function loadConversation(
  projectId: string,
): Promise<PersistedConversation | null> {
  if (!paneDir) return null;
  try {
    const content = await readFile(conversationPath(projectId));
    
    // Check file size before parsing
    const fileSize = content.length;
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
    
    if (fileSize > MAX_FILE_SIZE) {
      console.warn(`[persistence] Conversation file is ${fileSize} bytes, exceeding 5MB limit`);
      console.log(`[persistence] Attempting to compact before loading...`);
      
      // Try to parse and compact the conversation
      try {
        const parsed = JSON.parse(content.trim()) as PersistedConversation;
        
        if (parsed.messages && parsed.messages.length > 100) {
          console.log(`[persistence] Compacting ${parsed.messages.length} messages to 100 most recent`);
          parsed.messages = parsed.messages.slice(-100);
          
          // Save the compacted version
          await saveConversation(projectId, parsed);
          console.log(`[persistence] Compacted conversation saved`);
          
          return parsed;
        }
      } catch (parseErr) {
        console.error(`[persistence] Failed to parse large conversation file:`, parseErr);
        
        // If we can't even parse it, try a more aggressive approach
        console.log(`[persistence] Attempting emergency recovery by extracting messages...`);
        
        // Simple message extraction - find message objects in the file
        const messageMatches = content.match(/\{"id":\s*"[^"]*"[^}]*"type":\s*"[^"]*"[^}]*"content":[^}]*\}/g);
        if (messageMatches && messageMatches.length > 0) {
          console.log(`[persistence] Found ${messageMatches.length} message objects`);
          
          // Try to parse and keep only the last 50
          const messages: ConversationMessage[] = [];
          const startIdx = Math.max(0, messageMatches.length - 50);
          
          for (let i = startIdx; i < messageMatches.length; i++) {
            const match = messageMatches[i];
            if (!match) continue; // Safety check
            
            try {
              const msg = JSON.parse(match) as ConversationMessage;
              messages.push(msg);
            } catch {
              // Skip invalid messages
            }
          }
          
          if (messages.length > 0) {
            console.log(`[persistence] Recovered ${messages.length} messages`);
            
            // Try to extract model from the original content if possible
            let model: string | null = null;
            try {
              const fullParse = JSON.parse(content.trim()) as { model?: string };
              model = fullParse?.model || null;
            } catch {
              // Can't parse full content, model will be null
            }
            
            const recovered: PersistedConversation = {
              sessionId: null,
              model: model,
              messages: messages
            };
            
            // Save the recovered version
            await saveConversation(projectId, recovered);
            console.log(`[persistence] Recovered conversation saved`);
            
            return recovered;
          }
        }
        
        return null;
      }
    }
    
    // File is within limits, parse normally
    return JSON.parse(content.trim()) as PersistedConversation;
  } catch (err) {
    console.error(`[persistence] Failed to load conversation for ${projectId}:`, err);
    return null;
  }
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
        const backend =
          (settings.punk_backend === "cli"
            ? "gemini-cli"
            : settings.punk_backend) || "http";
        ws.setPunkBackend(backend);

        if (settings.http_provider) ws.setHttpProvider(settings.http_provider);

        // API keys & Base URLs
        const apiKeys: Record<string, string> = settings.http_api_keys || {};
        // Only use the legacy single key if the map doesn't already have one for that provider
        const provider = settings.http_provider || "deepseek";
        if (settings.http_api_key && !apiKeys[provider]) {
          apiKeys[provider] = settings.http_api_key;
        }
        ws.setHttpApiKeys(apiKeys);
        ws.setHttpBaseUrls(settings.http_base_urls || {});

        // Model restoration
        if (settings.selected_model) {
          let model = settings.selected_model;
          if (model === "gemini-2.5-pro" || model === "gemini-1.5-pro-latest")
            model = "gemini-3.1-pro-preview";
          if (
            model === "gemini-2.5-flash" ||
            model === "gemini-1.5-flash-latest"
          )
            model = "gemini-3-flash-preview";

          // Determine correct provider for the model
          let provider =
            settings.selected_model_provider || ws.selectedModelProvider;

          // Validate that provider matches model
          // Check if model belongs to a different provider than what's saved
          for (const [prov, models] of Object.entries(PROVIDER_MODELS)) {
            if (models.some((m: { value: string; label: string }) => m.value === model)) {
              // Found the correct provider for this model
              if (provider !== prov) {
                console.warn(
                  `[settings] Correcting provider mismatch: model "${model}" belongs to provider "${prov}" but settings has "${provider}"`,
                );
                provider = prov;
              }
              break;
            }
          }

          ws.setSelectedModel(model, false, provider);
        }

        // 3. Routing Migration & Validation
        const rawRouting = settings.intent_routing as unknown as BackendRouting | IntentRouting | null;
        const healedRouting: BackendRouting = JSON.parse(
          JSON.stringify(DEFAULT_BACKEND_ROUTING),
        );

        if (rawRouting) {
          const isLegacyFlat =
            'plan' in rawRouting &&
            'execute' in rawRouting &&
            !('http' in rawRouting) &&
            !('gemini-cli' in rawRouting);

          if (isLegacyFlat) {
            // Assign legacy settings to the active backend
            // rawRouting is IntentRouting here, not BackendRouting
            healedRouting[backend] = { 
              plan: (rawRouting as IntentRouting).plan,
              execute: (rawRouting as IntentRouting).execute,
              explain: (rawRouting as IntentRouting).explain,
              other: (rawRouting as IntentRouting).other,
            };
          } else {
            // Merge existing backend maps into our canonical defaults
            const backendRouting = rawRouting as BackendRouting;
            for (const key of Object.keys(backendRouting)) {
              const normalizedKey = key === "cli" ? "gemini-cli" : key;
              if (healedRouting[normalizedKey]) {
                healedRouting[normalizedKey] = {
                  ...healedRouting[normalizedKey],
                  ...backendRouting[key],
                };
              }
            }
          }

          // Strict Validation: Ensure gemini-cli only uses auto- models
          ["plan", "execute", "explain", "other"].forEach((intent) => {
            const r =
              healedRouting["gemini-cli"]?.[intent as keyof IntentRouting];

            if (r && r.provider === "gemini" && !r.model.startsWith("auto-")) {
              if (r.model.includes("pro")) r.model = "auto-gemini-3";
              else r.model = "auto-gemini-3";
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
              console.log(`[persistence] preloaded project ${tentativeId} from ${root}, hasSaved=${!!saved}, msgCount=${saved?.messages.length || 0}`);
              return { root, saved };
            }),
          );

          let activeId: string | null = null;
          const projectIds: string[] = [];
          for (const { root, saved } of preloaded) {
            const tentativeId = precomputeProjectId(root);
            const id = addProject(root); // Returns the actual ID used in the store
            projectIds.push(id);
            if (root === settings.active_project_root) activeId = id;

            console.log(`[persistence] project ${root}: tentativeId=${tentativeId}, actualId=${id}, hasSaved=${!!saved}`);

            const ps = useProjectsStore.getState();
            if (saved && saved.messages.length > 0) {
              console.log(`[persistence] restoring conversation for ${id} (saved messages: ${saved.messages.length})`);
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

          // Mark all as restored AFTER the loops so usePunkWarmup can start safely
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
      if (!settingsLoadedGlobal) return;
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
    };
  }, []);
}
