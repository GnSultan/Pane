import { useEffect, useState } from "react";

type UpdateStatus =
  | { state: "idle" | "checking" | "up-to-date" | "dev" }
  | { state: "available"; version: string | null }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string | null }
  | { state: "error"; message: string };

/**
 * Consent-based update toast. Main decides WHEN (scheduled checks);
 * this surface decides HOW (offer → download on click → install on click).
 * Never auto-installs: "ready" stays visible until the user chooses.
 * Dismissable — skipping an update is a first-class choice.
 * Bottom-right, so it never collides with the TaskNotification stack
 * (top-right). Visual language matches TaskNotification: pane tokens.
 * State "dev" (dev builds, machinery off) renders nothing — silent.
 */
export function UpdateToast() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Catch up on any status pushed before mount (e.g. a ready update).
    // The IPC gate throws synchronously (not a rejected promise) when main
    // hasn't registered a channel — e.g. an older main during dev HMR — so
    // this is try/caught in the effect, never allowed to reach the boundary.
    try {
      window.electronAPI
        .invoke<{ state: UpdateStatus["state"] }>("update:get_status")
        .then((s) => {
          if (s && s.state !== "idle" && s.state !== "up-to-date") {
            setStatus(s as UpdateStatus);
          }
        })
        .catch(() => {});
    } catch {
      // Skew (renderer newer than main): stay silent.
    }
    const unlisten = window.electronAPI.on<UpdateStatus>("pane://update-status", (s) => {
      // A new state re-shows the toast even if a previous one was dismissed.
      setStatus(s);
      if (s.state === "available" || s.state === "ready" || s.state === "downloading") {
        setDismissed(false);
      }
    });
    return () => {
      unlisten();
    };
  }, []);

  // Only these four states render anything; checking/up-to-date stay silent.
  const actionable =
    status?.state === "available" ||
    status?.state === "downloading" ||
    status?.state === "ready" ||
    status?.state === "error";
  if (!status || !actionable || dismissed) return null;

  const dismiss = () => setDismissed(true);

  return (
    <div
      className="fixed bottom-3.5 right-3.5 z-50 flex items-center gap-3 bg-pane-bg/90 backdrop-blur-md rounded-xl ring-1 ring-pane-border/40 px-4 py-3 shadow-lg pointer-events-auto"
    >
      <span
        className="w-2 h-2 rounded-full bg-pane-status-added shrink-0"
        aria-hidden
      />
      {status.state === "available" && (
        <div className="flex items-center gap-3">
          <span className="text-pane-text" style={{ fontSize: "var(--pane-panel-font-size)" }}>
            Pane {status.version ?? "— new version"} is available.
          </span>
          <button
            className="text-pane-accent hover:underline font-medium shrink-0"
            style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            onClick={() => window.electronAPI.invoke("update:download")}
          >
            Download
          </button>
        </div>
      )}
      {status.state === "downloading" && (
        <span
          className="text-pane-text-secondary"
          style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        >
          Downloading update… {status.percent}%
        </span>
      )}
      {status.state === "ready" && (
        <div className="flex items-center gap-3">
          <span className="text-pane-text" style={{ fontSize: "var(--pane-panel-font-size)" }}>
            Update ready. Restart to install.
          </span>
          <button
            className="text-pane-accent hover:underline font-medium shrink-0"
            style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
            onClick={() => window.electronAPI.invoke("update:install")}
          >
            Restart
          </button>
        </div>
      )}
      {status.state === "error" && (
        <span
          className="text-pane-text-secondary"
          style={{ fontSize: "var(--pane-panel-font-size-sm)" }}
        >
          Update check failed.
        </span>
      )}
      <button
        className="text-pane-text-secondary hover:text-pane-text shrink-0 leading-none"
        style={{ fontSize: "var(--pane-panel-font-size)" }}
        onClick={dismiss}
        aria-label="Dismiss update"
      >
        ×
      </button>
    </div>
  );
}
