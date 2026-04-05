import { create } from "zustand";
import type { LensPost } from "../lib/tauri-commands";

interface LensState {
  posts: LensPost[];
  loaded: Record<string, boolean>;
  expandedCommentsId: string | null;
  setPosts: (posts: LensPost[]) => void;
  appendPost: (post: LensPost) => void;
  deletePost: (postId: string) => void;
  setLoaded: (projectId: string, loaded: boolean) => void;
  isLoaded: (projectId: string) => boolean;
  setExpandedCommentsId: (id: string | null) => void;
}

function createLensStore() {
  return create<LensState>()((set, get) => ({
    posts: [],
    loaded: {},
    expandedCommentsId: null,

    setPosts: (posts) =>
      set((s) => {
        const incomingProjects = new Set(posts.map((p) => p.project_id));
        const kept = s.posts.filter((p) => !incomingProjects.has(p.project_id));
        return { posts: [...kept, ...posts] };
      }),

    appendPost: (post) =>
      set((s) => {
        const alreadyExists = s.posts.some((p) => p.id === post.id);
        return { posts: alreadyExists ? s.posts : [...s.posts, post] };
      }),

    deletePost: (postId) =>
      set((s) => ({
        posts: s.posts.filter((p) => p.id !== postId),
      })),

    setLoaded: (projectId, loaded) =>
      set((s) => ({ loaded: { ...s.loaded, [projectId]: loaded } })),

    isLoaded: (projectId) => !!get().loaded[projectId],

    setExpandedCommentsId: (id) => set({ expandedCommentsId: id }),
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
