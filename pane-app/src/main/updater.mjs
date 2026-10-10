// electron-updater wiring — consent-based, renderer-informed.
//
// Decisions baked in here:
// - autoDownload is FALSE. Pane is a tool you work inside; a silent
//   download-and-restart mid-session would destroy work context. Every
//   update is offered, never forced.
// - All state reaches the renderer as push events on "pane://update-status"
//   (push channels are ungated by design — no preload change needed).
// - Handlers register inside initUpdater(), which main.mjs calls BEFORE
//   createWindow — so the IPC allowlist snapshot includes them. They register
//   in dev too (with honest "dev" responses): the allowlist is built from
//   actual registrations, so a channel the renderer can invoke in one mode
//   must be registered in every mode. Only the feed machinery is dev-skipped.
// - macOS: electron-updater cannot auto-install a Developer-ID-signed
//   mac app unless the build is actually signed (build:mac currently
//   strips native-module signatures, no signing identity in CI). On mac
//   the updater still CHECKS and still notifies — install works the day
//   signing credentials land in the release pipeline. Windows (NSIS) and
//   Linux (AppImage/deb) auto-install out of the box.
import electronPkg from "electron";
const { app, BrowserWindow, ipcMain } = electronPkg;
import electronUpdater from "electron-updater";

// electron-updater's `autoUpdater` is a LAZY GETTER: first access builds
// the platform updater (MacUpdater etc.) which immediately reads
// `app.getVersion()`. Destructuring it at module load crashes anywhere
// electron's `app` isn't live (plain node, tests), so the access is
// deferred to initUpdater — the one place guaranteed to run inside the
// real main process.
let autoUpdater = null;

const STATUS_CHANNEL = "pane://update-status";

// Last status pushed, kept for `update:get_status` so a renderer that
// mounts after an event fired can catch up instead of missing it.
let lastStatus = { state: "idle" };

function pushStatus(status) {
  lastStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(STATUS_CHANNEL, status);
    }
  }
}

let initialized = false;
let devMode = false;

export function initUpdater() {
  if (initialized) return;
  initialized = true;

  // Channels register in EVERY mode. The IPC allowlist snapshot (taken at
  // createWindow) is built from actual ipcMain.handle registrations — if the
  // renderer can invoke a channel in one mode, it must be registered there.
  // In dev the handlers answer with honest state; only the feed machinery
  // (events, timers, autoUpdater) is skipped, because a local build has no
  // feed and autoUpdater would just error.
  ipcMain.handle("update:check", async () => {
    if (devMode) return { ok: true, devMode: true };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version ?? null };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  });
  ipcMain.handle("update:download", async () => {
    if (devMode) return { ok: true, devMode: true };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  });
  ipcMain.handle("update:install", () => {
    if (devMode) return { ok: true, devMode: true };
    // quitAndInstall is fire-and-forget by design — the app exits here.
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  ipcMain.handle("update:get_status", () =>
    devMode ? { state: "dev" } : lastStatus,
  );

  // Dev run: symmetric IPC surface, no machinery. UpdateToast renders
  // nothing for state "dev", and no feed checks ever fire.
  if (!app.isPackaged) {
    devMode = true;
    console.log("[updater] dev mode — feed machinery disabled, handlers active");
    return;
  }

  // First touch of the lazy getter — safe here: real app is live.
  autoUpdater = electronUpdater.autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    pushStatus({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    pushStatus({ state: "available", version: info?.version ?? null });
  });
  autoUpdater.on("update-not-available", () => {
    pushStatus({ state: "up-to-date" });
  });
  autoUpdater.on("download-progress", (progress) => {
    pushStatus({
      state: "downloading",
      percent: Math.round(progress.percent ?? 0),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    pushStatus({ state: "ready", version: info?.version ?? null });
  });
  autoUpdater.on("error", (err) => {
    // Surface, never swallow: renderer shows this, log carries the detail.
    console.error("[updater] error:", err?.message ?? err);
    pushStatus({ state: "error", message: String(err?.message ?? err).slice(0, 200) });
  });

  // First check 30s after launch, then every 6h. The renderer asks for a
  // manual check anytime via update:check (settings surface / banner).
  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] scheduled check failed:", err?.message ?? err);
    });
  }, 30_000);
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] scheduled check failed:", err?.message ?? err);
    });
  }, CHECK_INTERVAL_MS);

  console.log("[updater] initialized (consent-based, autoDownload off)");
}

/** Test seam: current push-channel name and last status. */
export function getUpdaterState() {
  return { statusChannel: STATUS_CHANNEL, lastStatus, initialized };
}
