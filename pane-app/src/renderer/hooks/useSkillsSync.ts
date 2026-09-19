import { useEffect } from "react";
import { useProjectsStore } from "../stores/projects";

const electronAPI: import("../lib/electron").ElectronAPI = window.electronAPI;

/**
 * Skills visibility sync — keeps `project.activeSkills` in the renderer store
 * aligned with the main-process skill registry.
 *
 * Pull: on app start and whenever a project is added. Cheap (reads an
 *       in-memory Set), so no synced-marker bookkeeping — correctness first.
 * Push: main fires `pane-skills-changed` on every activate/deactivate/hydrate
 *       (agent tool call, Profile toggle, or session restore), carrying the
 *       full replacement set.
 */
export function useSkillsSync() {
  const projectIds = useProjectsStore((s) => s.projectOrder);

  // Push subscription — replacement, not merge, so ordering drift can't
  // accumulate stale entries.
  useEffect(() => {
    return electronAPI.on<{ projectId: string; active: string[] }>(
      "pane-skills-changed",
      ({ projectId, active }) => {
        useProjectsStore.getState().setActiveSkills(projectId, active);
      },
    );
  }, []);

  // Pull per project as projects appear. projectOrder identity only changes
  // when the set of projects changes.
  useEffect(() => {
    for (const id of projectIds) {
      electronAPI
        .invoke<string[]>("skills_get_active", { projectId: id })
        .then((active) => {
          if (Array.isArray(active)) {
            useProjectsStore.getState().setActiveSkills(id, active);
          }
        })
        .catch(() => {});
    }
  }, [projectIds]);
}
