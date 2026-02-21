import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useProjectsStore } from "../stores/projects";
import { getGitStatus } from "../lib/tauri-commands";

export function useGitStatus() {
  const projectOrder = useProjectsStore((s) => s.projectOrder);
  const projects = useProjectsStore((s) => s.projects);
  const lastFetchRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const fetchAllStatuses = () => {
      const state = useProjectsStore.getState();
      for (const [projectId, project] of state.projects) {
        const now = Date.now();
        const lastFetch = lastFetchRef.current.get(projectId) ?? 0;
        if (now - lastFetch < 1000) continue;
        lastFetchRef.current.set(projectId, now);

        getGitStatus(project.root)
          .then((status) => {
            const absoluteMap = new Map<string, string>();
            for (const [relPath, code] of Object.entries(status.files)) {
              absoluteMap.set(`${project.root}/${relPath}`, code);
            }
            useProjectsStore
              .getState()
              .setGitStatus(projectId, status.branch, absoluteMap, true);
          })
          .catch(() => {
            useProjectsStore
              .getState()
              .setGitStatus(projectId, "", new Map(), false);
          });
      }
    };

    fetchAllStatuses();

    const unlistenPromise = listen("pane://file-changed", () => {
      fetchAllStatuses();
    });

    const interval = setInterval(fetchAllStatuses, 5000);

    return () => {
      unlistenPromise.then((fn) => fn());
      clearInterval(interval);
    };
  }, [projectOrder, projects]);
}
