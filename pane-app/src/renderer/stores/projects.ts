import { create } from "zustand";
import type { FileEntry } from "../lib/tauri-commands";
import type {
  ConversationState,
  ConversationMessage,
  ContentBlock,
  ToolUseBlock,
  CheckpointMeta,
  ArbiterVerdict,
} from "../lib/punk-types";
import { createEmptyConversation } from "../lib/punk-types";
import type { PowerCombo } from "../lib/models";
import { DEFAULT_POWER_COMBO } from "../lib/models";
import { useWorkspaceStore } from "./workspace";

// Maximum messages kept in-memory per conversation. Full history lives in
// SQLite — the store is a display-only cache. With virtual scrolling, only
// ~20-30 messages are rendered as DOM at any time, so 100 in the store is
// more than sufficient — old messages are trimmed from the front and the
// "load older" button fetches them from disk.
const MAX_STORE_MESSAGES = 100;

export interface ProjectGit {
  branch: string | null;
  fileStatuses: Map<string, string>;
  dirtyDirs: Set<string>; // pre-computed: all ancestor dirs of changed files
  isGitRepo: boolean;
}

export interface ProjectFileIndex {
  files: string[];
  lastIndexed: number;
  isLoading: boolean;
}

export interface Project {
  id: string;
  root: string;
  name: string;
  rootMissing?: boolean; // true when the folder no longer exists at the stored path
  expandedDirs: Set<string>;
  dirContents: Map<string, FileEntry[]>;
  loadingDirs: Set<string>;
  selectedPath: string | null;
  activeFilePath: string | null;
  activeFileContent: string | null;
  mode: "conversation" | "viewer" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch";
  conversation: ConversationState;
  git: ProjectGit;
  fileIndex: ProjectFileIndex;
  hasUnreadCompletion: boolean; // true when background task completes, cleared when project becomes active
  hasUnreadLens: boolean; // true when a new Lens post/punk finding arrives while Lens is not open
  recentFiles: string[]; // last 20 opened files (FIFO)
  checkpoints: CheckpointMeta[];
  scrollPositions: Map<string, { scrollTop: number; cursor: { row: number; column: number } }>;
  /** Per-project power combo: which model serves each phase (think/build).
   *  When set, overrides the global workspace powerCombo for this project.
   *  Undefined means "use workspace default". */
  powerCombo?: PowerCombo;
  /** Per-project auto-route toggle. Undefined means "use workspace default". */
  autoEscalate?: boolean;
  /** Per-project explicit model pin. When set, this project always uses
   *  this model when auto-route is off, regardless of workspace default.
   *  Undefined means "use workspace default selectedModel". */
  selectedModel?: string;
  /** Per-project model provider. Undefined means "use workspace default". */
  selectedModelProvider?: string;
  /** Per-project thinking override. Undefined means "use workspace default". */
  selectedModelThinking?: boolean;
  /** Last user prompt text (max 500 chars) — for thread list preview. */
  lastUserPromptText: string | null;
  /** Last response summary (max 200 chars) — for thread list preview. */
  lastResponseSummary: string | null;
  /** Epoch ms of last user or model activity — for thread list sorting. */
  lastActivityAt: number | null;
  /** When true, this thread is archived — hidden from main list, visible
   *  in a collapsible "Archived" section. Migrates to conversation-level
   *  is_archived when multi-conversation (Phase 0) lands. */
  archived?: boolean;
}

/**
 * Generate a stable project ID.
 * New projects get a UUID. Existing projects pass their stored ID so all
 * memory/SQLite data (keyed on the old derived ID) stays intact.
 */
function generateProjectId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProject(root: string, stableId?: string, nameOverride?: string): Project {
  const name = (nameOverride ?? root.split("/").filter(Boolean).pop()) || root;
  const id = stableId ?? generateProjectId();
  return {
    id,
    root,
    name,
    expandedDirs: new Set(),
    dirContents: new Map(),
    loadingDirs: new Set(),
    selectedPath: null,
    activeFilePath: null,
    activeFileContent: null,
    mode: "conversation",
    conversation: createEmptyConversation(),
    git: {
      branch: null,
      fileStatuses: new Map(),
      dirtyDirs: new Set(),
      isGitRepo: false,
    },
    fileIndex: { files: [], lastIndexed: 0, isLoading: false },
    hasUnreadCompletion: false,
    hasUnreadLens: false,
    recentFiles: [],
    checkpoints: [],
    scrollPositions: new Map(),
    lastUserPromptText: null,
    lastResponseSummary: null,
    lastActivityAt: null,
  };
}

// Ensure unique IDs — UUIDs won't collide but derived IDs from old projects might
function ensureUniqueId(id: string, existing: Map<string, Project>): string {
  if (!existing.has(id)) return id;
  let i = 2;
  while (existing.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

interface ProjectsState {
  projects: Map<string, Project>;
  activeProjectId: string | null;
  projectOrder: string[]; // ordered list of project IDs for Cmd+1/2/3

  // Project lifecycle
  addProject: (root: string, stableId?: string) => string; // returns project ID
  removeProject: (id: string) => void;
  archiveProject: (id: string) => void;
  restoreProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  rebindProject: (id: string, newRoot: string) => void; // update root binding after folder move/rename
  markRootMissing: (id: string, missing: boolean) => void;
  migrateProjectId: (oldId: string, newId: string) => void; // swap store entry from old derived ID to UUID
  setActiveProject: (id: string) => void;

  // Active project helpers
  getActiveProject: () => Project | undefined;

  // Per-project file tree
  toggleDir: (projectId: string, path: string) => void;
  setDirContents: (
    projectId: string,
    path: string,
    entries: FileEntry[],
  ) => void;
  batchSetDirContents: (
    projectId: string,
    tree: Record<string, FileEntry[]>,
  ) => void;
  setLoading: (projectId: string, path: string, loading: boolean) => void;
  setSelectedPath: (projectId: string, path: string | null) => void;

  // Per-project file viewer
  openFile: (projectId: string, path: string, content: string) => void;
  updateFileContent: (projectId: string, content: string) => void;
  clearFile: (projectId: string) => void;
  setScrollPosition: (
    projectId: string,
    path: string,
    pos: { scrollTop: number; cursor: { row: number; column: number } },
  ) => void;

  // Per-project mode
  setMode: (
    projectId: string,
    mode: "conversation" | "viewer" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch",
  ) => void;
  toggleMode: (projectId: string) => void;

  // Project ordering
  reorderProjects: (fromIndex: number, toIndex: number) => void;

  // Per-project git
  setGitStatus: (
    projectId: string,
    branch: string,
    fileStatuses: Map<string, string>,
    isGitRepo: boolean,
  ) => void;

  // Per-project file index
  setFileIndex: (projectId: string, files: string[]) => void;
  setFileIndexLoading: (projectId: string, loading: boolean) => void;
  invalidateFileIndex: (projectId: string) => void;

  // Per-project conversation
  addConversationMessage: (
    projectId: string,
    message: ConversationMessage,
  ) => void;
  removeLastConversationMessage: (projectId: string) => void;
  removeConversationMessageById: (projectId: string, messageId: string) => void;
  updateMessageContent: (
    projectId: string,
    messageId: string,
    content: ContentBlock[],
  ) => void;
  updateMessageReasoning: (
    projectId: string,
    messageId: string,
    reasoning: string,
  ) => void;
  updateLastAssistantContent: (
    projectId: string,
    content: ContentBlock[],
  ) => void;
  /** Atomic batch update for streaming — all mutations in one set() call.
   *  Applies text delta, thinking delta, and status message in a single pass,
   *  producing ONE new Map instead of 2-3 per event. */
  batchUpdateConversation: (
    projectId: string,
    updates: {
      textDelta?: string;
      thinkingDelta?: string;
      statusMessage?: string | null;
    },
  ) => void;
  appendToLastAssistantText: (projectId: string, text: string) => void;
  appendToLastAssistantThinking: (projectId: string, thinking: string) => void;
  setLastThinkingSignature: (projectId: string, signature: string) => void;
  setConversationModel: (projectId: string, model: string) => void;
  setConversationStatusMessage: (
    projectId: string,
    message: string | null,
  ) => void;
  setConversationRoutedModel: (projectId: string, model: string | null) => void;
  setConversationRestored: (projectId: string, isRestored: boolean) => void;
  setConversationProcessing: (projectId: string, isProcessing: boolean) => void;
  setConversationError: (projectId: string, error: string | null) => void;
  setLastMessageStreamingDone: (projectId: string) => void;
  finalizeAllStreaming: (projectId: string) => void;
  setLastAssistantMeta: (
    projectId: string,
    costUsd: number,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    numTurns?: number,
  ) => void;
  setLastAssistantVerdict: (projectId: string, verdict: ArbiterVerdict) => void;
  clearConversation: (projectId: string) => void;
  clearSessionContext: (projectId: string) => void;
  setHasUnreadCompletion: (projectId: string, hasUnread: boolean) => void;
  setHasUnreadLens: (projectId: string, hasUnread: boolean) => void;
  restoreConversation: (
    projectId: string,
    messages: ConversationMessage[],
    historyInfo?: { totalCount: number; startIndex: number },
  ) => void;
  prependOlderMessages: (
    projectId: string,
    messages: ConversationMessage[],
    newStartIndex: number,
  ) => void;
  setConversationTodos: (
    projectId: string,
    todos: import("../lib/punk-types").Todo[],
  ) => void;
  setPendingInput: (projectId: string, pendingInput: import("../lib/punk-types").ConversationState["pendingInput"]) => void;
  clearPendingInput: (projectId: string) => void;
  setIsPlanning: (projectId: string, isPlanning: boolean) => void;
  setConversationPhase: (projectId: string, phase: import("../lib/punk-types").ConversationState["phase"]) => void;
  updateLastToolUseInput: (
    projectId: string,
    input: Record<string, unknown>,
  ) => void;
  updateToolUseInputById: (
    projectId: string,
    toolId: string,
    input: Record<string, unknown>,
  ) => void;
  setContextPressure: (
    projectId: string,
    tokens: number,
    pressure: import("../lib/punk-types").ContextPressure,
  ) => void;
  setCompactionStatus: (
    projectId: string,
    status: { isCompacting?: boolean; lastCompactionAt?: number; compactionCount?: number; tokensSaved?: number },
  ) => void;
  setCachedBrief: (projectId: string, brief: string) => void;

  // Per-project routing
  setProjectPowerCombo: (projectId: string, combo: PowerCombo) => void;
  setProjectAutoEscalate: (projectId: string, autoEscalate: boolean) => void;
  setProjectSelectedModel: (projectId: string, model: string, thinking: boolean, provider?: string) => void;
  getProjectEffectiveCombo: (projectId: string) => PowerCombo;
  // Thread list activity
  setThreadActivity: (projectId: string, fields: { lastUserPromptText?: string | null; lastResponseSummary?: string | null; lastActivityAt?: number | null }) => void;

  // Checkpoints
  addCheckpoint: (projectId: string, meta: CheckpointMeta) => void;
  setCheckpoints: (projectId: string, checkpoints: CheckpointMeta[]) => void;
  clearCheckpoints: (projectId: string) => void;
}

function updateProject(
  state: ProjectsState,
  projectId: string,
  updater: (project: Project) => Partial<Project>,
): Partial<ProjectsState> {
  const project = state.projects.get(projectId);
  if (!project) return {};
  const updates = updater(project);
  const next = new Map(state.projects);
  next.set(projectId, { ...project, ...updates });
  return { projects: next };
}

function createProjectsStore() {
  return create<ProjectsState>()((set, get) => ({
    projects: new Map(),
    activeProjectId: null,
    projectOrder: [],

    addProject: (root: string, stableId?: string) => {
      const state = get();
      // Multi-thread: same folder can be added multiple times, each gets its own
      // UUID and independent conversation. Disambiguate name if there's a duplicate.
      const sameRootCount = [...state.projects.values()].filter((p) => p.root === root).length;
      let name = root.split("/").filter(Boolean).pop() || root;
      if (sameRootCount > 0) {
        name = `${name} (${sameRootCount + 1})`;
      }
      // If a stableId is provided and already exists (e.g. from a previous session),
      // trust it — don't ensureUnique since it IS the canonical identity.
      const project = createProject(root, stableId, name);
      if (!stableId) {
        project.id = ensureUniqueId(project.id, state.projects);
      }
      // Seed thread activity timestamp so newly added projects sort to top
      project.lastActivityAt = Date.now();
      const next = new Map(state.projects);
      next.set(project.id, project);
      set({
        projects: next,
        activeProjectId: project.id,
        projectOrder: state.projectOrder.includes(project.id)
          ? state.projectOrder
          : [...state.projectOrder, project.id],
      });
      return project.id;
    },

    renameProject: (id: string, name: string) => {
      set((state) => updateProject(state, id, () => ({ name: name.trim() || state.projects.get(id)?.name || "" })));
    },

    rebindProject: (id: string, newRoot: string) => {
      set((state) =>
        updateProject(state, id, () => ({
          root: newRoot,
          name: newRoot.split("/").filter(Boolean).pop() || newRoot,
          rootMissing: false,
        }))
      );
    },

    markRootMissing: (id: string, missing: boolean) => {
      set((state) => updateProject(state, id, () => ({ rootMissing: missing })));
    },

    migrateProjectId: (oldId: string, newId: string) => {
      set((state) => {
        const project = state.projects.get(oldId);
        if (!project) return {}; // already migrated or doesn't exist
        const next = new Map(state.projects);
        next.delete(oldId);
        next.set(newId, { ...project, id: newId });
        const nextOrder = state.projectOrder.map((pid) => (pid === oldId ? newId : pid));
        const nextActive = state.activeProjectId === oldId ? newId : state.activeProjectId;
        return { projects: next, projectOrder: nextOrder, activeProjectId: nextActive };
      });
    },

    removeProject: (id: string) => {
      const state = get();
      const next = new Map(state.projects);
      next.delete(id);
      const nextOrder = state.projectOrder.filter((pid) => pid !== id);
      const nextActive =
        state.activeProjectId === id
          ? nextOrder[0] || null
          : state.activeProjectId;
      set({
        projects: next,
        activeProjectId: nextActive,
        projectOrder: nextOrder,
      });
    },

    archiveProject: (id: string) => {
      set((state) => {
        const project = state.projects.get(id);
        if (!project) return {};

        // If archiving the active project, switch to the next non-archived
        let nextActive = state.activeProjectId;
        if (state.activeProjectId === id) {
          const candidates = state.projectOrder.filter(
            (pid) => pid !== id && !state.projects.get(pid)?.archived,
          );
          nextActive = candidates[0] || null;
        }

        return {
          ...updateProject(state, id, () => ({ archived: true })),
          activeProjectId: nextActive,
        };
      });
    },

    restoreProject: (id: string) => {
      set((state) => updateProject(state, id, () => ({ archived: false })));
    },

    setActiveProject: (id: string) => {
      set((state) => {
        const project = state.projects.get(id);
        if (!project) return { activeProjectId: id };

        // Carry the current workspace mode to the target project so switching
        // threads while in file explorer stays locked there.
        const currentProject = state.activeProjectId
          ? state.projects.get(state.activeProjectId)
          : undefined;
        const carryMode = currentProject?.mode;
        const isTransientMode = carryMode === "mind" || carryMode === "profile" || carryMode === "history" || carryMode === "lens";

        const updatedProjects = new Map(state.projects);
        const updatedProject = {
          ...project,
          hasUnreadCompletion: false,
          ...(carryMode && !isTransientMode ? { mode: carryMode } : {}),
        };
        updatedProjects.set(id, updatedProject);
        return { activeProjectId: id, projects: updatedProjects };
      });
    },

    getActiveProject: () => {
      const state = get();
      if (!state.activeProjectId) return undefined;
      return state.projects.get(state.activeProjectId);
    },

    // File tree
    toggleDir: (projectId, path) =>
      set((state) => {
        const project = state.projects.get(projectId);
        if (!project) return {};
        const next = new Set(project.expandedDirs);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        const projects = new Map(state.projects);
        projects.set(projectId, { ...project, expandedDirs: next });
        return { projects };
      }),

    setDirContents: (projectId, path, entries) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Map(p.dirContents);
          next.set(path, entries);
          return { dirContents: next };
        }),
      ),

    batchSetDirContents: (projectId, tree) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Map(p.dirContents);
          for (const [dir, entries] of Object.entries(tree)) {
            next.set(dir, entries);
          }
          return { dirContents: next };
        }),
      ),

    setLoading: (projectId, path, loading) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Set(p.loadingDirs);
          if (loading) next.add(path);
          else next.delete(path);
          return { loadingDirs: next };
        }),
      ),

    setSelectedPath: (projectId, path) =>
      set((state) =>
        updateProject(state, projectId, () => ({ selectedPath: path })),
      ),

    // File viewer
    openFile: (projectId, path, content) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const recent = [
            path,
            ...p.recentFiles.filter((f) => f !== path),
          ].slice(0, 20);
          return {
            activeFilePath: path,
            activeFileContent: content,
            mode: "viewer" as const,
            recentFiles: recent,
          };
        }),
      ),

    updateFileContent: (projectId, content) =>
      set((state) =>
        updateProject(state, projectId, () => ({ activeFileContent: content })),
      ),

    clearFile: (projectId) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          activeFilePath: null,
          activeFileContent: null,
        })),
      ),

    setScrollPosition: (projectId, path, pos) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const next = new Map(p.scrollPositions);
          next.set(path, pos);
          return { scrollPositions: next };
        }),
      ),

    // Mode
    setMode: (projectId, mode) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          mode,
          // Opening Lens clears the unread badge
          ...(mode === "lens" ? { hasUnreadLens: false } : {}),
        })),
      ),

    toggleMode: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          // Toggle between Chat and Viewer (file explorer / directory browser)
          let nextMode: "conversation" | "viewer" | "git" | "mind" | "profile" | "history" | "lens" | "search" | "filesearch";
          if (p.mode === "conversation") {
            nextMode = "viewer";
          } else {
            // From git, viewer, mind, profile, history, lens, fuzzy, or search — always go back to conversation
            nextMode = "conversation";
          }
          return { mode: nextMode };
        }),
      ),

    reorderProjects: (fromIndex, toIndex) =>
      set((state) => {
        const next = [...state.projectOrder];
        const [moved] = next.splice(fromIndex, 1) as [string];
        next.splice(toIndex, 0, moved);
        return { projectOrder: next };
      }),

    // Git
    setGitStatus: (projectId, branch, fileStatuses, isGitRepo) =>
      set((state) =>
        updateProject(state, projectId, () => {
          // Pre-compute set of all ancestor directories that contain changes
          const dirtyDirs = new Set<string>();
          for (const filePath of fileStatuses.keys()) {
            let dir = filePath;
            while (true) {
              const slash = dir.lastIndexOf("/");
              if (slash <= 0) break;
              dir = dir.slice(0, slash);
              if (dirtyDirs.has(dir)) break; // ancestors already added
              dirtyDirs.add(dir);
            }
          }
          return { git: { branch, fileStatuses, dirtyDirs, isGitRepo } };
        }),
      ),

    // File index
    setFileIndex: (projectId, files) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          fileIndex: {
            ...p.fileIndex,
            files,
            lastIndexed: Date.now(),
            isLoading: false,
          },
        })),
      ),

    setFileIndexLoading: (projectId, loading) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          fileIndex: { ...p.fileIndex, isLoading: loading },
        })),
      ),

    invalidateFileIndex: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          fileIndex: { ...p.fileIndex, lastIndexed: 0 },
        })),
      ),

    // Conversation
    addConversationMessage: (projectId, message) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          if (p.conversation.messages.some((m) => m.id === message.id)) return p;
          const messages = [...p.conversation.messages, message];
          // Cap to most recent N messages to prevent unbounded heap growth.
          // Full history lives in SQLite; the store is a display-only cache.
          const capped = messages.length > MAX_STORE_MESSAGES
            ? messages.slice(messages.length - MAX_STORE_MESSAGES)
            : messages;
          return {
            conversation: {
              ...p.conversation,
              messages: capped,
            },
          };
        }),
      ),

    removeLastConversationMessage: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: {
            ...p.conversation,
            messages: p.conversation.messages.slice(0, -1),
          },
        })),
      ),

    removeConversationMessageById: (projectId, messageId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: {
            ...p.conversation,
            messages: p.conversation.messages.filter((m) => m.id !== messageId),
          },
        })),
      ),

    updateMessageContent: (projectId, messageId, content) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = p.conversation.messages.map((m) =>
            m.id === messageId ? { ...m, content } : m,
          );
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    updateMessageReasoning: (projectId, messageId, reasoning) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = p.conversation.messages.map((m) =>
            m.id === messageId ? { ...m, reasoning_content: reasoning } : m,
          );
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    /** Atomic batch: applies textDelta, thinkingDelta, statusMessage in ONE set() call. */
    batchUpdateConversation: (projectId, { textDelta, thinkingDelta, statusMessage }) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const conv = { ...p.conversation };
          if (statusMessage !== undefined) {
            conv.statusMessage = statusMessage;
          }
          if (textDelta || thinkingDelta) {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.type === "assistant") {
              const blocks = [...last.content];
              if (textDelta) {
                const lastBlock = blocks[blocks.length - 1];
                if (lastBlock && lastBlock.type === "text") {
                  blocks[blocks.length - 1] = {
                    ...lastBlock,
                    text: (lastBlock as { type: "text"; text: string }).text + textDelta,
                  };
                } else {
                  blocks.push({ type: "text", text: textDelta });
                }
              }
              if (thinkingDelta) {
                const lastBlock = blocks[blocks.length - 1];
                if (lastBlock && lastBlock.type === "thinking") {
                  blocks[blocks.length - 1] = {
                    ...lastBlock,
                    thinking:
                      (lastBlock as { type: "thinking"; thinking: string }).thinking + thinkingDelta,
                  };
                } else {
                  blocks.push({ type: "thinking", thinking: thinkingDelta });
                }
              }
              msgs[msgs.length - 1] = { ...last, content: blocks };
            }
            conv.messages = msgs;
          }
          return { conversation: conv };
        }),
      ),

    updateLastAssistantContent: (projectId, content) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            msgs[msgs.length - 1] = { ...last, content };
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    appendToLastAssistantText: (projectId, text) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && lastBlock.type === "text") {
              blocks[blocks.length - 1] = {
                ...lastBlock,
                text: (lastBlock as { type: "text"; text: string }).text + text,
              };
            } else {
              blocks.push({ type: "text", text });
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    appendToLastAssistantThinking: (projectId, thinking) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && lastBlock.type === "thinking") {
              blocks[blocks.length - 1] = {
                ...lastBlock,
                thinking:
                  (lastBlock as { type: "thinking"; thinking: string })
                    .thinking + thinking,
              };
            } else {
              blocks.push({ type: "thinking", thinking });
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    setLastThinkingSignature: (projectId, signature) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            for (let i = blocks.length - 1; i >= 0; i--) {
              const block = blocks[i]!;
              if (block.type === "thinking") {
                blocks[i] = { ...block, signature };
                break;
              }
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    setConversationModel: (projectId, model) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, model },
        })),
      ),

    setConversationStatusMessage: (projectId, message) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, statusMessage: message },
        })),
      ),

    setConversationRoutedModel: (projectId, model) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, routedModel: model },
        })),
      ),

    setConversationRestored: (projectId, isRestored) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, isRestored },
        })),
      ),

    setConversationProcessing: (projectId, isProcessing) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, isProcessing },
        })),
      ),

    setConversationError: (projectId, error) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, error },
        })),
      ),

    setLastMessageStreamingDone: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          const last = msgs[msgs.length - 1];
          if (last) {
            msgs[msgs.length - 1] = { ...last, isStreaming: false };
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    // Stamps isStreaming: false on every message that's still streaming.
    // Claude finalizes its own messages via setLastMessageStreamingDone in
    // case "assistant". Gemini may leave earlier tool-use messages streaming
    // when the final text response creates a new assistant message — this
    // sweeps those up at session end (case "result").
    finalizeAllStreaming: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const hasAny = p.conversation.messages.some((m) => m.isStreaming);
          if (!hasAny) return p;
          const msgs = p.conversation.messages.map((m) =>
            m.isStreaming ? { ...m, isStreaming: false } : m,
          );
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    setLastAssistantMeta: (
      projectId,
      costUsd,
      durationMs,
      inputTokens,
      outputTokens,
      numTurns,
    ) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.type === "assistant") {
              msgs[i] = {
                ...msgs[i]!,
                costUsd,
                durationMs,
                inputTokens,
                outputTokens,
                numTurns,
              };
              break;
            }
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    setLastAssistantVerdict: (projectId, verdict) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.type === "assistant") {
              msgs[i] = { ...msgs[i]!, verdict };
              break;
            }
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    clearConversation: (projectId) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          conversation: createEmptyConversation(),
        })),
      ),

    clearSessionContext: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: {
            ...p.conversation,
            todos: [],
            isPlanning: false,
            phase: "idle",
            isProcessing: false,
          },
        })),
      ),

    setHasUnreadCompletion: (projectId, hasUnread) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          hasUnreadCompletion: hasUnread,
        })),
      ),

    setHasUnreadLens: (projectId, hasUnread) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          hasUnreadLens: hasUnread,
        })),
      ),

    setConversationTodos: (projectId, todos) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, todos },
        })),
      ),

    setPendingInput: (projectId, pendingInput) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, pendingInput },
        })),
      ),

    clearPendingInput: (projectId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, pendingInput: null },
        })),
      ),

    setIsPlanning: (projectId, isPlanning) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, isPlanning },
        })),
      ),

    setConversationPhase: (projectId, phase) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, phase },
        })),
      ),

    updateLastToolUseInput: (projectId, input) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.type === "assistant") {
            const blocks = [...last.content];
            for (let i = blocks.length - 1; i >= 0; i--) {
              if (blocks[i]!.type === "tool_use") {
                blocks[i] = { ...blocks[i]!, input } as ToolUseBlock;
                break;
              }
            }
            msgs[msgs.length - 1] = { ...last, content: blocks };
          }
          return { conversation: { ...p.conversation, messages: msgs } };
        }),
      ),

    updateToolUseInputById: (projectId, toolId, input) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const msgs = [...p.conversation.messages];
          for (let mi = msgs.length - 1; mi >= 0; mi--) {
            const msg = msgs[mi]!;
            if (msg.type === "assistant") {
              const blocks = [...msg.content];
              for (let i = 0; i < blocks.length; i++) {
                if (
                  blocks[i]!.type === "tool_use" &&
                  (blocks[i] as ToolUseBlock).id === toolId
                ) {
                  blocks[i] = { ...blocks[i]!, input } as ToolUseBlock;
                  msgs[mi] = { ...msg, content: blocks };
                  return { conversation: { ...p.conversation, messages: msgs } };
                }
              }
            }
          }
          return { conversation: p.conversation };
        }),
      ),

    setContextPressure: (projectId, tokens, pressure) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: {
            ...p.conversation,
            contextTokens: tokens,
            contextPressure: pressure,
          },
        })),
      ),

    setCompactionStatus: (projectId, status) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: {
            ...p.conversation,
            isCompacting: status.isCompacting ?? p.conversation.isCompacting,
            lastCompactionAt: status.lastCompactionAt ?? p.conversation.lastCompactionAt,
            compactionCount: status.compactionCount ?? p.conversation.compactionCount,
            tokensSaved: status.tokensSaved ?? p.conversation.tokensSaved,
          },
        })),
      ),

    setCachedBrief: (projectId, brief) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: { ...p.conversation, cachedBrief: brief },
        })),
      ),

    restoreConversation: (projectId, messages, historyInfo) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          conversation: {
            messages: messages.map((m) => ({ ...m, isHistorical: true })),
            model: null,
            routedModel: null,
            serviceTier: null,
            isProcessing: false,
            isPlanning: false,
            phase: "idle",
            isRestored: true,
            error: null,
            todos: [],
            isProcessActive: false,
            lastActivity: Date.now(),
            contextTokens: 0,
            contextPressure: "none",
            cachedBrief: "",
            statusMessage: null,
            isCompacting: false,
            lastCompactionAt: null,
            compactionCount: 0,
            tokensSaved: 0,
            historyTotalCount: historyInfo?.totalCount ?? 0,
            historyStartIndex: historyInfo?.startIndex ?? 0,
            pendingInput: null,
          },
        })),
      ),

    prependOlderMessages: (projectId, olderMessages, newStartIndex) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          // Do NOT trim the front here: the front is exactly the older messages
          // the user just asked to load. Trimming them created a permanent
          // ceiling at MAX_STORE_MESSAGES where "load older" became a no-op.
          // Explicit back-paging grows the window; the live-append cap
          // (addConversationMessage) still bounds normal streaming growth.
          // Dedupe against what's already loaded to guard overlapping slices.
          const existingIds = new Set(p.conversation.messages.map((m) => m.id));
          const older = olderMessages
            .filter((m) => !existingIds.has(m.id))
            .map((m) => ({ ...m, isHistorical: true }));
          return {
            conversation: {
              ...p.conversation,
              messages: [...older, ...p.conversation.messages],
              historyStartIndex: newStartIndex,
            },
          };
        }),
      ),

    // Per-project routing
    setProjectPowerCombo: (projectId, combo) =>
      set((state) =>
        updateProject(state, projectId, () => ({ powerCombo: combo })),
      ),

    setProjectAutoEscalate: (projectId, autoEscalate) =>
      set((state) =>
        updateProject(state, projectId, () => ({ autoEscalate })),
      ),

    setProjectSelectedModel: (projectId, model, thinking, provider) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          selectedModel: model,
          selectedModelThinking: thinking,
          selectedModelProvider: provider,
        })),
      ),

    getProjectEffectiveCombo: (projectId) => {
      const state = get();
      const project = state.projects.get(projectId);
      if (project?.powerCombo) return project.powerCombo;
      // Fall back to workspace store's global combo
      return useWorkspaceStore.getState().powerCombo || DEFAULT_POWER_COMBO;
    },

    setThreadActivity: (projectId, fields) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          lastUserPromptText: fields.lastUserPromptText ?? state.projects.get(projectId)?.lastUserPromptText ?? null,
          lastResponseSummary: fields.lastResponseSummary ?? state.projects.get(projectId)?.lastResponseSummary ?? null,
          lastActivityAt: fields.lastActivityAt ?? state.projects.get(projectId)?.lastActivityAt ?? null,
        })),
      ),

    // Checkpoints
    addCheckpoint: (projectId, meta) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          checkpoints: [...p.checkpoints, meta],
        })),
      ),

    setCheckpoints: (projectId, checkpoints) =>
      set((state) => updateProject(state, projectId, () => ({ checkpoints }))),

    clearCheckpoints: (projectId) =>
      set((state) =>
        updateProject(state, projectId, () => ({ checkpoints: [] })),
      ),
  }));
}

interface ViteHotContext {
  data: Record<string, unknown>;
}
interface ViteImportMeta {
  hot?: ViteHotContext;
}

// Preserve store across HMR — prevents state loss and stale subscriptions
export const useProjectsStore: ReturnType<typeof createProjectsStore> =
  ((import.meta as unknown as ViteImportMeta).hot?.data?.__PROJECTS_STORE__ as ReturnType<typeof createProjectsStore> | undefined) ??
  (() => {
    const store = createProjectsStore();
    if ((import.meta as unknown as ViteImportMeta).hot) {
      (import.meta as unknown as ViteImportMeta).hot!.data.__PROJECTS_STORE__ = store;
    }
    return store;
  })();
