import { create } from "zustand";
import type { FileEntry } from "../lib/tauri-commands";
import type { ConversationState, ConversationMessage, ContentBlock, ToolUseBlock } from "../lib/claude-types";
import { createEmptyConversation } from "../lib/claude-types";

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
  id: string;       // doubles as ptyId
  title: string;    // "zsh", "zsh (2)", etc.
  isAlive: boolean; // false after PTY exit
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
  mode: "conversation" | "viewer" | "terminal";
  conversation: ConversationState;
  git: ProjectGit;
  fileIndex: ProjectFileIndex;
  hasUnreadCompletion: boolean; // true when background task completes, cleared when project becomes active
  terminalTabs: TerminalTab[];
  activeTerminalTabId: string | null;
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
    git: { branch: null, fileStatuses: new Map(), dirtyDirs: new Set(), isGitRepo: false },
    fileIndex: { files: [], lastIndexed: 0, isLoading: false },
    hasUnreadCompletion: false,
    terminalTabs: [],
    activeTerminalTabId: null,
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
  setActiveProject: (id: string) => void;

  // Active project helpers
  getActiveProject: () => Project | undefined;

  // Per-project file tree
  toggleDir: (projectId: string, path: string) => void;
  setDirContents: (projectId: string, path: string, entries: FileEntry[]) => void;
  batchSetDirContents: (projectId: string, tree: Record<string, FileEntry[]>) => void;
  setLoading: (projectId: string, path: string, loading: boolean) => void;
  setSelectedPath: (projectId: string, path: string | null) => void;

  // Per-project file viewer
  openFile: (projectId: string, path: string, content: string) => void;
  updateFileContent: (projectId: string, content: string) => void;
  clearFile: (projectId: string) => void;

  // Per-project mode
  setMode: (projectId: string, mode: "conversation" | "viewer" | "terminal") => void;
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
  addConversationMessage: (projectId: string, message: ConversationMessage) => void;
  updateLastAssistantContent: (projectId: string, content: ContentBlock[]) => void;
  appendToLastAssistantText: (projectId: string, text: string) => void;
  appendToLastAssistantThinking: (projectId: string, thinking: string) => void;
  setLastThinkingSignature: (projectId: string, signature: string) => void;
  setConversationSessionId: (projectId: string, sessionId: string) => void;
  setConversationModel: (projectId: string, model: string) => void;
  setConversationReady: (projectId: string, isReady: boolean) => void;
  setConversationProcessing: (projectId: string, isProcessing: boolean) => void;
  setConversationError: (projectId: string, error: string | null) => void;
  setLastMessageStreamingDone: (projectId: string) => void;
  setLastAssistantMeta: (projectId: string, costUsd: number, durationMs: number, inputTokens?: number, outputTokens?: number, numTurns?: number) => void;
  clearConversation: (projectId: string) => void;
  setHasUnreadCompletion: (projectId: string, hasUnread: boolean) => void;
  restoreConversation: (projectId: string, messages: ConversationMessage[], sessionId: string | null) => void;
  setConversationTodos: (projectId: string, todos: import("../lib/claude-types").Todo[]) => void;
  setPendingPlanApproval: (projectId: string, pending: boolean) => void;
  setIsPlanning: (projectId: string, isPlanning: boolean) => void;
  updateLastToolUseInput: (projectId: string, input: Record<string, unknown>) => void;

  // Terminal tabs
  addTerminalTab: (projectId: string, tab: TerminalTab) => void;
  removeTerminalTab: (projectId: string, tabId: string) => void;
  setActiveTerminalTab: (projectId: string, tabId: string) => void;
  markTerminalTabDead: (projectId: string, tabId: string) => void;
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
      if (project && project.hasUnreadCompletion) {
        // Clear the notification badge when viewing the project
        const updatedProject = { ...project, hasUnreadCompletion: false };
        const updatedProjects = new Map(state.projects);
        updatedProjects.set(id, updatedProject);
        return { activeProjectId: id, projects: updatedProjects };
      }
      return { activeProjectId: id };
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
    set((state) => updateProject(state, projectId, () => ({ selectedPath: path }))),

  // File viewer
  openFile: (projectId, path, content) =>
    set((state) =>
      updateProject(state, projectId, () => ({
        activeFilePath: path,
        activeFileContent: content,
        mode: "viewer" as const,
      })),
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

  // Mode
  setMode: (projectId, mode) =>
    set((state) => updateProject(state, projectId, () => ({ mode }))),

  toggleMode: (projectId) =>
    set((state) =>
      updateProject(state, projectId, (p) => {
        // Cycle through: conversation → viewer → terminal → conversation
        let nextMode: "conversation" | "viewer" | "terminal";
        if (p.mode === "conversation") {
          nextMode = p.activeFilePath ? "viewer" : "terminal";
        } else if (p.mode === "viewer") {
          nextMode = "terminal";
        } else {
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
        fileIndex: { ...p.fileIndex, files, lastIndexed: Date.now(), isLoading: false },
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
      updateProject(state, projectId, (p) => ({
        conversation: {
          ...p.conversation,
          messages: [...p.conversation.messages, message],
        },
      })),
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
              thinking: (lastBlock as { type: "thinking"; thinking: string }).thinking + thinking,
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

  setConversationSessionId: (projectId, sessionId) =>
    set((state) =>
      updateProject(state, projectId, (p) => ({
        conversation: { ...p.conversation, sessionId },
      })),
    ),

  setConversationModel: (projectId, model) =>
    set((state) =>
      updateProject(state, projectId, (p) => ({
        conversation: { ...p.conversation, model },
      })),
    ),

  setConversationReady: (projectId, isReady) =>
    set((state) =>
      updateProject(state, projectId, (p) => ({
        conversation: { ...p.conversation, isReady },
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

  setLastAssistantMeta: (projectId, costUsd, durationMs, inputTokens, outputTokens, numTurns) =>
    set((state) =>
      updateProject(state, projectId, (p) => {
        const msgs = [...p.conversation.messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]!.type === "assistant") {
            msgs[i] = { ...msgs[i]!, costUsd, durationMs, inputTokens, outputTokens, numTurns };
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

  setHasUnreadCompletion: (projectId, hasUnread) =>
    set((state) =>
      updateProject(state, projectId, () => ({
        hasUnreadCompletion: hasUnread,
      })),
    ),

  setConversationTodos: (projectId, todos) =>
    set((state) =>
      updateProject(state, projectId, (p) => ({
        conversation: { ...p.conversation, todos },
      })),
    ),

  setPendingPlanApproval: (projectId, pending) =>
    set((state) =>
      updateProject(state, projectId, (p) => ({
        conversation: { ...p.conversation, pendingPlanApproval: pending },
      })),
    ),

  setIsPlanning: (projectId, isPlanning) =>
    set((state) =>
      updateProject(state, projectId, (p) => ({
        conversation: { ...p.conversation, isPlanning },
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

  restoreConversation: (projectId, messages, sessionId) =>
    set((state) =>
      updateProject(state, projectId, () => ({
        conversation: {
          messages,
          sessionId,
          model: null,
          serviceTier: null,
          isProcessing: false,
          isPlanning: false,
          isReady: false,
          error: null,
          todos: [],
          pendingPlanApproval: false,
          isProcessActive: false,
          lastActivity: Date.now(),
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
