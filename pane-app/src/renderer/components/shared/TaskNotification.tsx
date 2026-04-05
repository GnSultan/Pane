import { useState, useEffect, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";

interface Notification {
  id: string;
  projectId: string;
  projectName: string;
  timestamp: number;
}


export function TaskNotification() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const notifTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const setActiveProject = useProjectsStore((s) => s.setActiveProject);
  const setHasUnreadCompletion = useProjectsStore((s) => s.setHasUnreadCompletion);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ projectId: string; projectName: string }>;
      const notification: Notification = {
        id: `${Date.now()}-${Math.random()}`,
        projectId: customEvent.detail.projectId,
        projectName: customEvent.detail.projectName,
        timestamp: Date.now(),
      };

      setNotifications((prev) => [...prev, notification]);

      // Auto-dismiss the toast after 3s — dot persists until user activates the project
      const timer = setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
        notifTimers.current.delete(notification.id);
      }, 3000);
      notifTimers.current.set(notification.id, timer);
    };

    window.addEventListener("pane:task-complete", handler);
    return () => {
      window.removeEventListener("pane:task-complete", handler);
      for (const timer of notifTimers.current.values()) clearTimeout(timer);
      notifTimers.current.clear();
    };
  }, []);

  // Listen for review completion — mark Lens as having unread findings
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    const unlisten = electronAPI.on(
      "pane://review-complete",
      (data: { projectId?: string; findings?: unknown[] }) => {
        if (!data?.projectId || !data?.findings?.length) return;
        const s = useProjectsStore.getState();
        const isViewingLens =
          s.activeProjectId === data.projectId &&
          s.projects.get(data.projectId)?.mode === "lens";
        if (!isViewingLens) {
          s.setHasUnreadLens(data.projectId, true);
        }
      }
    );
    return () => unlisten();
  }, []);

  // Listen for new Lens posts — set badge if user isn't already on Lens
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    const unlisten = electronAPI.on(
      "pane://lens-post",
      (post: { project_id?: string }) => {
        if (!post?.project_id) return;
        const s = useProjectsStore.getState();
        const isViewingLens =
          s.activeProjectId === post.project_id &&
          s.projects.get(post.project_id)?.mode === "lens";
        if (!isViewingLens) {
          s.setHasUnreadLens(post.project_id, true);
        }
      }
    );
    return () => unlisten();
  }, []);

  const handleClick = (notification: Notification) => {
    const timer = notifTimers.current.get(notification.id);
    if (timer) { clearTimeout(timer); notifTimers.current.delete(notification.id); }
    setActiveProject(notification.projectId); // setActiveProject already clears hasUnreadCompletion
    setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
  };

  const handleDismiss = (e: React.MouseEvent, notificationId: string, projectId: string) => {
    e.stopPropagation();
    const timer = notifTimers.current.get(notificationId);
    if (timer) { clearTimeout(timer); notifTimers.current.delete(notificationId); }
    setHasUnreadCompletion(projectId, false);
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
  };

  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-3.5 right-3.5 flex flex-col gap-2 z-50 pointer-events-none">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          onClick={() => handleClick(notification)}
          className="bg-pane-bg/90 backdrop-blur-md rounded-xl ring-1 ring-pane-border/40 px-4 py-3
                     animate-fadeSlideUp pointer-events-auto cursor-pointer
                     hover:bg-pane-surface/90 btn-press
                     flex items-center gap-3 min-w-[280px]"
        >
          <span className="w-2 h-2 rounded-full bg-pane-status-added shrink-0" />
          <div className="flex-1">
            <p className="text-pane-text font-sans font-medium" style={{ fontSize: "var(--pane-panel-font-size)" }}>
              {notification.projectName}
            </p>
            <p className="text-pane-text-secondary" style={{ fontSize: "var(--pane-panel-font-size-sm)" }}>
              Task completed
            </p>
          </div>
          <button
            onClick={(e) => handleDismiss(e, notification.id, notification.projectId)}
            className="text-pane-text-secondary/40 hover:text-pane-text-secondary
                       w-5 h-5 flex items-center justify-center btn-press"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            ×
          </button>
        </div>
      ))}

    </div>
  );
}
