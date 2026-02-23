import { useState, useEffect } from "react";
import { useProjectsStore } from "../../stores/projects";

interface Notification {
  id: string;
  projectId: string;
  projectName: string;
  timestamp: number;
}

export function TaskNotification() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const setActiveProject = useProjectsStore((s) => s.setActiveProject);

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

      // Auto-dismiss after 5 seconds
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
      }, 5000);
    };

    window.addEventListener("pane:task-complete", handler);
    return () => window.removeEventListener("pane:task-complete", handler);
  }, []);

  const handleClick = (notification: Notification) => {
    setActiveProject(notification.projectId);
    setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
  };

  const handleDismiss = (e: React.MouseEvent, notificationId: string) => {
    e.stopPropagation();
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
  };

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 pointer-events-none">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          onClick={() => handleClick(notification)}
          className="bg-pane-surface border border-pane-border rounded-lg px-4 py-3
                     shadow-lg animate-fadeSlideUp pointer-events-auto cursor-pointer
                     hover:bg-pane-text/[0.04] btn-press
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
            onClick={(e) => handleDismiss(e, notification.id)}
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
