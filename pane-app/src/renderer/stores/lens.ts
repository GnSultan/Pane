import { create } from "zustand";
import type { LensPost } from "../lib/tauri-commands";

interface LensState {
  posts: LensPost[];
  loaded: Record<string, boolean>; // projectId -> loaded
  expandedPostId: string | null;
  setPosts: (posts: LensPost[]) => void;
  appendPost: (post: LensPost) => void;
  setLoaded: (projectId: string, loaded: boolean) => void;
  isLoaded: (projectId: string) => boolean;
  setExpandedPostId: (id: string | null) => void;
}

function createLensStore() {
  return create<LensState>()((set, get) => ({
    posts: [],
    loaded: {},
    expandedPostId: null,

    setPosts: (posts) =>
      set((s) => {
        // Merge by project: replace posts for projects represented in the new
        // batch, keep posts for all other projects untouched.
        const incomingProjects = new Set(posts.map((p) => p.project_id));
        const kept = s.posts.filter((p) => !incomingProjects.has(p.project_id));
        return { posts: [...kept, ...posts] };
      }),

    appendPost: (post) =>
      set((s) => ({
        posts: s.posts.some((p) => p.id === post.id) ? s.posts : [...s.posts, post],
      })),

    setLoaded: (projectId, loaded) =>
      set((s) => ({ loaded: { ...s.loaded, [projectId]: loaded } })),

    isLoaded: (projectId) => !!get().loaded[projectId],

    setExpandedPostId: (id) => set({ expandedPostId: id }),
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
