import { useState, useEffect, useRef } from "react";
import { useProjectsStore } from "../../stores/projects";

interface Notification {
  id: string;
  projectId: string;
  projectName: string;
  timestamp: number;
}

interface WorkerNotification {
  id: string;
  entryId?: string;
  workerType: string;
  preview: string;
  timestamp: number;
}

const WORKER_LABELS: Record<string, string> = {
  bug: "bug analysis",
  reflection: "reflection",
  sentinel: "sentinel finding",
};

export function TaskNotification() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [workerNotifications, setWorkerNotifications] = useState<WorkerNotification[]>([]);
  const workerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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
    };

    window.addEventListener("pane:task-complete", handler);
    return () => window.removeEventListener("pane:task-complete", handler);
  }, []);

  // Listen for worker findings from mind-workers
  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    const unlisten = electronAPI.on(
      "pane://worker-finding",
      (data: { entryId?: string; workerType?: string; preview?: string }) => {
        if (!data?.workerType) return;
        const wn: WorkerNotification = {
          id: `worker-${Date.now()}-${Math.random()}`,
          entryId: data.entryId,
          workerType: data.workerType,
          preview: data.preview || "",
          timestamp: Date.now(),
        };
        setWorkerNotifications((prev) => [...prev.slice(-4), wn]); // keep max 5

        // Auto-dismiss after 8 seconds
        const timer = setTimeout(() => {
          setWorkerNotifications((prev) => prev.filter((n) => n.id !== wn.id));
          workerTimers.current.delete(wn.id);
        }, 8000);
        workerTimers.current.set(wn.id, timer);
      }
    );
    return () => {
      unlisten();
      // Clear all pending auto-dismiss timers on unmount
      for (const timer of workerTimers.current.values()) clearTimeout(timer);
      workerTimers.current.clear();
    };
  }, []);

  const handleClick = (notification: Notification) => {
    setActiveProject(notification.projectId);
    setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
  };

  const handleDismiss = (e: React.MouseEvent, notificationId: string) => {
    e.stopPropagation();
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
  };

  const dismissWorkerNotification = (id: string) => {
    setWorkerNotifications((prev) => prev.filter((n) => n.id !== id));
    const timer = workerTimers.current.get(id);
    if (timer) { clearTimeout(timer); workerTimers.current.delete(id); }
  };

  if (notifications.length === 0 && workerNotifications.length === 0) return null;

  return (
    <div className="fixed top-3.5 right-3.5 flex flex-col gap-2 z-50 pointer-events-none">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          onClick={() => handleClick(notification)}
          className="bg-pane-bg rounded-xl ring-1 ring-pane-border/40 px-4 py-3
                     animate-fadeSlideUp pointer-events-auto cursor-pointer
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

      {workerNotifications.map((wn) => (
        <div
          key={wn.id}
          onClick={() => dismissWorkerNotification(wn.id)}
          className="bg-pane-bg rounded-xl ring-1 ring-pane-border/40 px-4 py-3
                     animate-fadeSlideUp pointer-events-auto cursor-pointer
                     hover:bg-pane-text/[0.04] btn-press
                     flex items-start gap-3 min-w-[280px] max-w-[360px]"
        >
          <span
            className="w-1.5 h-1.5 rounded-full mt-[5px] shrink-0"
            style={{ background: "var(--pane-terminal)" }}
          />
          <div className="flex-1 min-w-0">
            <p
              className="font-mono"
              style={{ fontSize: "var(--pane-font-size-xs)", color: "var(--pane-terminal)" }}
            >
              {WORKER_LABELS[wn.workerType] ?? wn.workerType}
            </p>
            {wn.preview && (
              <p
                className="text-pane-text-secondary truncate"
                style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
              >
                {wn.preview}
              </p>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              dismissWorkerNotification(wn.id);
            }}
            className="text-pane-text-secondary/40 hover:text-pane-text-secondary
                       w-5 h-5 flex items-center justify-center btn-press shrink-0"
            style={{ fontSize: "var(--pane-panel-font-size)" }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
