import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * updater.mjs behavior:
 *   - consent defaults (autoDownload off, install-on-quit on)
 *   - handler registration + idempotent init
 *   - status push to lastStatus + push events to windows
 *   - dev mode: same channels registered, machinery off, honest responses
 * electron + electron-updater are lazy-getter hostile at plain import —
 * both mocked here, mirroring vision-normalize / computer-orchestration.
 */

// Mutable so tests can flip packaging mode; module state is isolated via
// vi.resetModules() + dynamic import.
const electronMock = {
  default: {
    app: { isPackaged: true, getVersion: () => "0.4.168" },
    BrowserWindow: {
      getAllWindows: vi.fn(() => []),
    },
    ipcMain: {
      handle: vi.fn(),
    },
  },
};

let autoUpdaterInstance;
const updaterMock = {
  default: {
    get autoUpdater() {
      // Mirror electron-updater's lazy-getter shape.
      if (!autoUpdaterInstance) {
        autoUpdaterInstance = Object.assign(new EventEmitter(), {
          autoDownload: true, // starts permissive — consent must flip it off
          autoInstallOnAppQuit: false,
          checkForUpdates: vi.fn(async () => ({ updateInfo: { version: "9.9.9" } })),
          downloadUpdate: vi.fn(async () => "downloaded"),
          quitAndInstall: vi.fn(),
        });
      }
      return autoUpdaterInstance;
    },
  },
};

vi.mock("electron", () => electronMock);
vi.mock("electron-updater", () => updaterMock);

async function freshInit({ isPackaged = true, windows = [] } = {}) {
  vi.resetModules();
  autoUpdaterInstance = undefined;
  electronMock.default.app.isPackaged = isPackaged;
  electronMock.default.BrowserWindow.getAllWindows = vi.fn(() => windows);
  electronMock.default.ipcMain.handle = vi.fn();
  const mod = await import("../updater.mjs");
  mod.initUpdater();
  return mod;
}

// Extract handlers registered via ipcMain.handle from the current mock.
function registeredHandlers() {
  const map = new Map();
  for (const call of electronMock.default.ipcMain.handle.mock.calls) {
    map.set(call[0], call[1]);
  }
  return map;
}

describe("updater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the four updater handlers when packaged", async () => {
    await freshInit({ isPackaged: true });
    const handlers = registeredHandlers();
    expect([...handlers.keys()].sort()).toEqual(
      ["update:check", "update:download", "update:get_status", "update:install"],
    );
  });

  it("enforces consent: autoDownload off, install-on-quit on", async () => {
    await freshInit({ isPackaged: true });
    expect(autoUpdaterInstance.autoDownload).toBe(false);
    expect(autoUpdaterInstance.autoInstallOnAppQuit).toBe(true);
  });

  it("dev mode registers the same channels, machinery stays off", async () => {
    await freshInit({ isPackaged: false });
    const handlers = registeredHandlers();
    // Symmetry: the renderer can invoke update:* in dev, so the channels
    // must be registered — exactly as in packaged mode.
    expect([...handlers.keys()].sort()).toEqual(
      ["update:check", "update:download", "update:get_status", "update:install"],
    );
    // But the lazy autoUpdater getter is never touched — no feed machinery.
    expect(autoUpdaterInstance).toBeUndefined();
    // Handlers answer with honest dev state, never the feed.
    expect(await handlers.get("update:check")()).toEqual({ ok: true, devMode: true });
    expect(await handlers.get("update:download")()).toEqual({ ok: true, devMode: true });
    expect(handlers.get("update:install")()).toEqual({ ok: true, devMode: true });
    expect(handlers.get("update:get_status")()).toEqual({ state: "dev" });
    // And the consent flip never happened.
    expect(autoUpdaterInstance?.autoDownload).toBeUndefined();
  });

  it("init is idempotent — no double registration", async () => {
    const mod = await freshInit({ isPackaged: true });
    mod.initUpdater();
    mod.initUpdater();
    expect(electronMock.default.ipcMain.handle.mock.calls.length).toBe(4);
  });

  it("update:check returns the feed version", async () => {
    await freshInit({ isPackaged: true });
    const result = await registeredHandlers().get("update:check")();
    expect(result).toEqual({ ok: true, version: "9.9.9" });
  });

  it("pushes update-available status readable via get_status", async () => {
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } };
    await freshInit({ isPackaged: true, windows: [win] });
    autoUpdaterInstance.emit("update-available", { version: "9.9.9" });

    const status = registeredHandlers().get("update:get_status")();
    expect(status).toEqual({ state: "available", version: "9.9.9" });
    // And the window got the push on the ungated channel.
    expect(win.webContents.send).toHaveBeenCalledWith(
      "pane://update-status",
      { state: "available", version: "9.9.9" },
    );
  });

  it("pushes download progress and ready states", async () => {
    await freshInit({ isPackaged: true });
    autoUpdaterInstance.emit("download-progress", { percent: 42.7 });
    expect(registeredHandlers().get("update:get_status")()).toEqual({
      state: "downloading",
      percent: 43,
    });
    autoUpdaterInstance.emit("update-downloaded", { version: "9.9.9" });
    expect(registeredHandlers().get("update:get_status")()).toEqual({
      state: "ready",
      version: "9.9.9",
    });
  });

  it("surfaces errors as visible state, never swallows them", async () => {
    await freshInit({ isPackaged: true });
    autoUpdaterInstance.emit("error", new Error("ENOTFOUND feed"));
    const status = registeredHandlers().get("update:get_status")();
    expect(status.state).toBe("error");
    expect(status.message).toContain("ENOTFOUND");
  });

  it("update:download delegates and reports failure honestly", async () => {
    await freshInit({ isPackaged: true });
    const ok = await registeredHandlers().get("update:download")();
    expect(ok).toEqual({ ok: true });
    expect(autoUpdaterInstance.downloadUpdate).toHaveBeenCalledOnce();

    autoUpdaterInstance.downloadUpdate = vi.fn(async () => {
      throw new Error("network gone");
    });
    const failed = await registeredHandlers().get("update:download")();
    expect(failed).toEqual({ ok: false, error: "network gone" });
  });

  it("update:install calls quitAndInstall", async () => {
    await freshInit({ isPackaged: true });
    const result = registeredHandlers().get("update:install")();
    expect(result).toEqual({ ok: true });
    expect(autoUpdaterInstance.quitAndInstall).toHaveBeenCalledOnce();
  });
});
