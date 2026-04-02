import { create } from "zustand";
import type { FileEntry } from "../lib/tauri-commands";
import type {
  ConversationState,
  ConversationMessage,
  ContentBlock,
  ToolUseBlock,
  CheckpointMeta,
} from "../lib/punk-types";
import { createEmptyConversation } from "../lib/punk-types";

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

export interface TerminalTab {
  id: string; // doubles as ptyId
  title: string; // display label (path)
  isAlive: boolean; // false after PTY exit
  cwd?: string; // current working directory, updated as user navigates
}

export interface Project {
  id: string;
  root: string;
  name: string;
  expandedDirs: Set<string>;
  dirContents: Map<string, FileEntry[]>;
  loadingDirs: Set<string>;
  selectedPath: string | null;
  activeFilePath: string | null;
  activeFileContent: string | null;
  mode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens";
  conversation: ConversationState;
  git: ProjectGit;
  fileIndex: ProjectFileIndex;
  hasUnreadCompletion: boolean; // true when background task completes, cleared when project becomes active
  hasUnreadLens: boolean; // true when a new Lens post/punk finding arrives while Lens is not open
  recentFiles: string[]; // last 20 opened files (FIFO)
  terminalTabs: TerminalTab[];
  activeTerminalTabId: string | null;
  checkpoints: CheckpointMeta[];
  scrollPositions: Map<string, { scrollTop: number; cursor: { row: number; column: number } }>;
}

function createProject(root: string): Project {
  const name = root.split("/").filter(Boolean).pop() || root;
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
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
    terminalTabs: [],
    activeTerminalTabId: null,
    checkpoints: [],
    scrollPositions: new Map(),
  };
}

// Ensure unique IDs by appending a counter if needed
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
  addProject: (root: string) => string; // returns project ID
  removeProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
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
    mode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens",
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
  updateLastAssistantContent: (
    projectId: string,
    content: ContentBlock[],
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
  setLastAssistantMeta: (
    projectId: string,
    costUsd: number,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    numTurns?: number,
  ) => void;
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

  // Terminal tabs
  addTerminalTab: (projectId: string, tab: TerminalTab) => void;
  removeTerminalTab: (projectId: string, tabId: string) => void;
  setActiveTerminalTab: (projectId: string, tabId: string) => void;
  markTerminalTabDead: (projectId: string, tabId: string) => void;
  updateTerminalTabCwd: (projectId: string, tabId: string, cwd: string) => void;

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

    addProject: (root: string) => {
      const state = get();
      // Don't add duplicate roots
      for (const p of state.projects.values()) {
        if (p.root === root) {
          set({ activeProjectId: p.id });
          return p.id;
        }
      }
      const project = createProject(root);
      project.id = ensureUniqueId(project.id, state.projects);
      const next = new Map(state.projects);
      next.set(project.id, project);
      set({
        projects: next,
        activeProjectId: project.id,
        projectOrder: [...state.projectOrder, project.id],
      });
      return project.id;
    },

    renameProject: (id: string, name: string) => {
      set((state) => updateProject(state, id, () => ({ name: name.trim() || state.projects.get(id)?.name || "" })));
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

    setActiveProject: (id: string) => {
      set((state) => {
        const project = state.projects.get(id);
        if (!project) return { activeProjectId: id };

        // Carry the current workspace mode to the target project so switching
        // threads while in file explorer (or terminal, etc.) stays locked there.
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
          let nextMode: "conversation" | "viewer" | "terminal" | "git" | "mind" | "profile" | "history" | "lens";
          if (p.mode === "conversation") {
            nextMode = "viewer";
          } else {
            // From git, terminal, viewer, mind, profile, history, lens, fuzzy, or search — always go back to conversation
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
          return {
            conversation: {
              ...p.conversation,
              messages: [...p.conversation.messages, message],
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
          },
        })),
      ),

    prependOlderMessages: (projectId, olderMessages, newStartIndex) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          conversation: {
            ...p.conversation,
            messages: [...olderMessages.map((m) => ({ ...m, isHistorical: true })), ...p.conversation.messages],
            historyStartIndex: newStartIndex,
          },
        })),
      ),

    // Terminal tabs
    addTerminalTab: (projectId, tab) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          terminalTabs: [...p.terminalTabs, tab],
          activeTerminalTabId: tab.id,
        })),
      ),

    removeTerminalTab: (projectId, tabId) =>
      set((state) =>
        updateProject(state, projectId, (p) => {
          const tabs = p.terminalTabs.filter((t) => t.id !== tabId);
          let activeId = p.activeTerminalTabId;
          if (activeId === tabId) {
            activeId = tabs.length > 0 ? tabs[tabs.length - 1]!.id : null;
          }
          return { terminalTabs: tabs, activeTerminalTabId: activeId };
        }),
      ),

    setActiveTerminalTab: (projectId, tabId) =>
      set((state) =>
        updateProject(state, projectId, () => ({
          activeTerminalTabId: tabId,
        })),
      ),

    markTerminalTabDead: (projectId, tabId) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          terminalTabs: p.terminalTabs.map((t) =>
            t.id === tabId ? { ...t, isAlive: false } : t,
          ),
        })),
      ),

    updateTerminalTabCwd: (projectId, tabId, cwd) =>
      set((state) =>
        updateProject(state, projectId, (p) => ({
          terminalTabs: p.terminalTabs.map((t) =>
            t.id === tabId ? { ...t, cwd } : t,
          ),
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

// Preserve store across HMR — prevents state loss and stale subscriptions
export const useProjectsStore: ReturnType<typeof createProjectsStore> =
  (import.meta as any).hot?.data?.__PROJECTS_STORE__ ??
  (() => {
    const store = createProjectsStore();
    if ((import.meta as any).hot) {
      (import.meta as any).hot.data.__PROJECTS_STORE__ = store;
    }
    return store;
  })();
