import { create } from "zustand";
import type { LensPost } from "../lib/tauri-commands";

interface LensState {
  posts: LensPost[];
  loaded: Record<string, boolean>; // projectId -> loaded
  expandedCommentsId: string | null; // tracks which post has comments visible
  unreadPunkPosts: LensPost[]; // punk posts not yet seen in conversation view
  setPosts: (posts: LensPost[]) => void;
  appendPost: (post: LensPost) => void;
  deletePost: (postId: string) => void;
  setLoaded: (projectId: string, loaded: boolean) => void;
  isLoaded: (projectId: string) => boolean;
  setExpandedCommentsId: (id: string | null) => void;
  addUnreadPunkPost: (post: LensPost) => void;
  dismissPunkPost: (postId: string) => void;
  clearUnreadPunkPosts: (projectId: string) => void;
}

function createLensStore() {
  return create<LensState>()((set, get) => ({
    posts: [],
    loaded: {},
    expandedCommentsId: null,
    unreadPunkPosts: [],

    setPosts: (posts) =>
      set((s) => {
        // Merge by project: replace posts for projects represented in the new
        // batch, keep posts for all other projects untouched.
        const incomingProjects = new Set(posts.map((p) => p.project_id));
        const kept = s.posts.filter((p) => !incomingProjects.has(p.project_id));
        return { posts: [...kept, ...posts] };
      }),

    appendPost: (post) =>
      set((s) => {
        const alreadyExists = s.posts.some((p) => p.id === post.id);
        const newPosts = alreadyExists ? s.posts : [...s.posts, post];
        // Track non-user posts as unread for the conversation strip
        const isUnread = !alreadyExists && post.contributor !== "user";
        const newUnread = isUnread
          ? s.unreadPunkPosts.some((p) => p.id === post.id)
            ? s.unreadPunkPosts
            : [...s.unreadPunkPosts, post]
          : s.unreadPunkPosts;
        return { posts: newPosts, unreadPunkPosts: newUnread };
      }),

    deletePost: (postId) =>
      set((s) => ({
        posts: s.posts.filter((p) => p.id !== postId),
        unreadPunkPosts: s.unreadPunkPosts.filter((p) => p.id !== postId),
      })),

    setLoaded: (projectId, loaded) =>
      set((s) => ({ loaded: { ...s.loaded, [projectId]: loaded } })),

    isLoaded: (projectId) => !!get().loaded[projectId],

    setExpandedCommentsId: (id) => set({ expandedCommentsId: id }),

    addUnreadPunkPost: (post) =>
      set((s) => ({
        unreadPunkPosts: s.unreadPunkPosts.some((p) => p.id === post.id)
          ? s.unreadPunkPosts
          : [...s.unreadPunkPosts, post],
      })),

    dismissPunkPost: (postId) =>
      set((s) => ({
        unreadPunkPosts: s.unreadPunkPosts.filter((p) => p.id !== postId),
      })),

    clearUnreadPunkPosts: (projectId) =>
      set((s) => ({
        unreadPunkPosts: s.unreadPunkPosts.filter((p) => p.project_id !== projectId),
      })),
  }));
}

// Preserve store across HMR
export const useLensStore: ReturnType<typeof createLensStore> =
  (import.meta as any).hot?.data?.__LENS_STORE__ ??
  (() => {
    const store = createLensStore();
    if ((import.meta as any).hot) {
      (import.meta as any).hot.data.__LENS_STORE__ = store;
    }
    return store;
  })();
