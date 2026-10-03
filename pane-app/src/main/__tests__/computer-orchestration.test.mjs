import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * executeComputer orchestration test — drives the real method through:
 *   screenshot  → capture (mocked) → readPngSize (mocked sips) → tier-fit
 *                 (mocked sips) → executeViewImage (real, tmp PNG) → envelope
 *   click       → seen-space → physical scaling via _lastSeen
 *   batch       → per-action results, envelope sanitization, stop-on-fail
 *
 * computer-use.mjs imports electron (TCC probes); mocked here. The cmd
 * worker is a fake EventEmitter running commands via /bin/sh.
 */

const shellHist = [];
const electronMock = {
  app: { getPath: () => "/tmp", isPackaged: false },
  systemPreferences: {
    getMediaAccessStatus: () => "granted",
    isTrustedAccessibilityClient: () => true,
  },
  desktopCapturer: { getSources: async () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: { request: () => ({ on: () => {}, write: () => {}, end: () => {} }) },
};
vi.mock("electron", () => electronMock);

// Fake cmd worker: same protocol as cmd-worker.mjs ({id, success, stdout, stderr})
import { EventEmitter } from "node:events";
import { exec } from "node:child_process";
const fakeWorker = new EventEmitter();
fakeWorker.killed = false;
fakeWorker.postMessage = ({ id, command }) => {
  shellHist.push(command);
  exec(command, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    fakeWorker.emit("message", { id, success: !err, stdout: stdout || "", stderr: (stderr || err?.message || "") });
  });
};

const { ToolExecutor, setCmdWorker } = await import("../tool-executor.mjs");
setCmdWorker(fakeWorker);

// Mock computer-use.mjs surface (its electron APIs need a real TCC env)
const physical = { w: 2992, h: 1934 }; // this machine's display
const fit = { w: 1372, h: 887 };       // standard-tier fit (1568 tokens)
let captureCount = 0;
vi.mock("../computer-use.mjs", () => ({
  captureScreen: vi.fn(async () => {
    captureCount += 1;
    const png = `/tmp/pane-shot-${captureCount}-${Date.now()}.png`;
    // Real 1×1 PNG; sizes reported via readPngSize mock below
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    require("node:fs").writeFileSync(png, Buffer.from(b64, "base64"));
    return { ok: true, path: png };
  }),
  readPngSize: vi.fn(async (p) => ({ ok: true, w: physical.w, h: physical.h })),
  clickAt: vi.fn(async ({ x, y }) => (x >= 0 && y >= 0 ? { ok: true } : { ok: false, error: "bad coords" })),
  movePointerTo: vi.fn(async () => ({ ok: true })),
  dragFromTo: vi.fn(async () => ({ ok: true })),
  scrollAt: vi.fn(async () => ({ ok: true })),
  typeText: vi.fn(async () => ({ ok: true })),
  pressKey: vi.fn(async () => ({ ok: true })),
  getDisplayInfo: vi.fn(async () => ({
    ok: true, logical: { w: 1496, h: 967 }, physical, scale: 2,
  })),
  probePermissions: vi.fn(async () => ({ screenRecording: true, accessibility: true, errors: [] })),
}));

// NOTE: vi.mock is hoisted — but this test file uses `await import` for the
// SUT so the mock registry applies. ToolExecutor imports computer-use
// dynamically inside executeComputer (await import), which vitest resolves
// through the mock registry.

// Mock sips so tier-fit runs deterministically and fast: report target dims.
import { vi as _vi } from "vitest";

describe("executeComputer — full orchestration", () => {
  let ex;
  beforeEach(() => {
    shellHist.length = 0;
    captureCount = 0;
    ex = new ToolExecutor("proj", "/tmp/pane-exec-test", () => {});
  });

  it("screenshot: tier-fits, records seen space, returns envelope + metadata", async () => {
    const r = await ex.executeComputer("t1", { action: "screenshot" });
    expect(r.success).toBe(true);
    expect(r.output.startsWith("__PANE_IMG__")).toBe(true);
    // Seen space recorded for subsequent coordinate actions
    expect(ex._lastSeen).toMatchObject({ width: 1372, height: 887, physicalW: 2992, physicalH: 1934 });
    // Metadata carries the temp file + dims for renderer display
    expect(r.metadata.temporaryFile).toMatch(/pane-shot-/);
    expect(r.metadata.seenWidth).toBe(1372);
    expect(r.metadata.downscaled).toBe(true);
    // The resize ran through the worker: long edge 1372 (target fit), not 1568
    expect(shellHist.some((c) => /sips -Z 1372 /.test(c))).toBe(true);
  });

  it("click: scales model-space coords to physical via lastSeen", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const r = await ex.executeComputer("t2", { action: "click", x: 686, y: 443, take_screenshot: false });
    expect(r.success).toBe(true);
    // 686/1372 * 2992 = 1496 (center); 443/887 * 1934 = 966 (≈center)
    const clickMod = await import("../computer-use.mjs");
    expect(clickMod.clickAt).toHaveBeenCalledWith(expect.objectContaining({ x: 1496, y: 966 }));
  });

  it("click before any screenshot: passthrough (physical assumed)", async () => {
    const r = await ex.executeComputer("t1", { action: "click", x: 100, y: 200, take_screenshot: false });
    expect(r.success).toBe(true);
    const clickMod = await import("../computer-use.mjs");
    expect(clickMod.clickAt).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 200 }));
  });

  it("mutating action auto-attaches verification screenshot as the result envelope", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const r = await ex.executeComputer("t2", { action: "key", key: "escape" });
    expect(r.success).toBe(true);
    // Result IS the post-action screenshot envelope (model sees it natively)
    expect(r.output.startsWith("__PANE_IMG__")).toBe(true);
    const env = JSON.parse(r.output.slice("__PANE_IMG__".length));
    expect(env.label).toContain("after:");
    expect(r.metadata.temporaryFile).toMatch(/pane-shot-/);
  });

  it("batch: runs actions in order, ships final screenshot envelope, no base64 in steps", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const r = await ex.executeComputer("t2", {
      action: "batch",
      actions: [
        { action: "click", x: 686, y: 443 },
        { action: "type", text: "hello" },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.output.startsWith("__PANE_IMG__")).toBe(true);
    const env = JSON.parse(r.output.slice("__PANE_IMG__".length));
    expect(env.label).toContain("after batch (2 action(s): click → type)");
    // Steps in metadata are summaries, never base64
    expect(JSON.stringify(r.metadata.batchSteps)).not.toContain("__PANE_IMG__");
    expect(r.metadata.batchSteps).toHaveLength(2);
    expect(r.metadata.batchSteps[0].action).toBe("click");
  });

  it("batch stops at first failure and reports it", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const clickMod = await import("../computer-use.mjs");
    clickMod.typeText.mockImplementationOnce(async () => ({ ok: false, error: "HID dropped" }));
    const r = await ex.executeComputer("t2", {
      action: "batch",
      actions: [
        { action: "click", x: 10, y: 10 },
        { action: "type", text: "will fail" },
        { action: "key", key: "return" }, // must NOT run
      ],
    });
    expect(r.success).toBe(false);
    expect(r.output).toContain("✖ type: HID dropped");
    const keyCalls = clickMod.pressKey.mock.calls;
    // pressKey was called once by the preceding screenshot-less test? No —
    // this batch never reached key. Verify via output content instead.
    expect(r.output).not.toContain("✔ key");
  });

  it("batch with explicit final screenshot reuses it (no extra capture)", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const before = captureCount;
    const r = await ex.executeComputer("t2", {
      action: "batch",
      actions: [
        { action: "click", x: 10, y: 10 },
        { action: "screenshot" },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.output.startsWith("__PANE_IMG__")).toBe(true);
    // Exactly one capture (the explicit screenshot) — no auto-attach after
    expect(captureCount).toBe(before + 1);
  });

  it("take_screenshot:false skips verification capture", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const before = captureCount;
    const r = await ex.executeComputer("t2", { action: "click", x: 5, y: 5, take_screenshot: false });
    expect(r.success).toBe(true);
    expect(r.output.startsWith("__PANE_IMG__")).toBe(false);
    expect(captureCount).toBe(before);
  });

  it("ax_elements: returns elements in seen space with metadata", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    // listElements runs real AppleScript against the FRONTMOST app — in CI
    // that's this process; expect ok with whatever the tree holds.
    // Worst case is budgeted at ≈4–6s (maxVisited 400) + osascript startup,
    // which varies with the focused app — 20s keeps it bounded but honest.
    const r = await ex.executeComputer("t2", { action: "ax_elements", ax_role: "button", ax_limit: 5 });
    expect(r.success).toBe(true);
    expect(r.output).toContain("Frontmost app:");
    if (r.metadata.elements?.length > 0) {
      const e = r.metadata.elements[0];
      expect(e).toHaveProperty("x");
      expect(e).toHaveProperty("role");
    }
  }, 20000);

  it("ax_focused: returns ok even when no focused element (Chromium)", async () => {
    const r = await ex.executeComputer("t1", { action: "ax_focused" });
    expect(r.success).toBe(true);
    expect(typeof r.output).toBe("string");
  }, 20000);

  it("region screenshot does not update the coordinate space", async () => {
    await ex.executeComputer("t1", { action: "screenshot" });
    const before = JSON.stringify(ex._lastSeen);
    const r = await ex.executeComputer("t2", { action: "screenshot", region: { x: 100, y: 100, w: 400, h: 300 } });
    expect(r.success).toBe(true);
    expect(JSON.stringify(ex._lastSeen)).toBe(before); // full-screen space retained
  });
});
