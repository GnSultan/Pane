/**
 * computer-use.mjs — Native macOS screen-capture and input-actuation layer.
 *
 * WHY THIS EXISTS: before this module the model had no computer-use surface
 * and improvised through run_shell_command → osascript/screencapture. Cached
 * session evidence (Sep 2026) shows that path failing two ways:
 *   1. "osascript is not allowed assistive access. (-1719)" — System Events
 *      clicks die at TCC when Pane lacks Accessibility.
 *   2. "screencapture: no file specified" — an inner osascript failure was
 *      swallowed by 2>/dev/null, the window-id came back empty, and
 *      screencapture mis-parsed its arguments. Two stacked errors, one hid
 *      the other.
 * The model retried ~8 times across sessions with no terminal state saying
 * the capability structurally couldn't work. This module makes it a
 * first-class tool that probes permissions up front and returns instructive
 * errors instead of cryptic ones.
 *
 * COORDINATE CONVENTION (verified live on this 2× display):
 *   The model always works in SCREENSHOT pixels — physical pixels, the same
 *   space a full screenshot occupies (e.g. 2992×1934). Every public function
 *   here accepts physical pixels and converts to logical points internally,
 *   in exactly one place (physicalToLogical), because:
 *     - screencapture -R regions are LOGICAL points (verified: -R0,0,100,100
 *       yields a 200×200 PNG on a 2× display)
 *     - CGEvent coordinates are LOGICAL points
 *     - System Events keystroke has no coordinates
 *
 * PERMISSIONS (macOS TCC), probed per call, never cached across restarts:
 *   - Screen Recording — needed by /usr/sbin/screencapture.
 *   - Accessibility — needed by System Events AND CGEventPost (synthesized
 *     input events are gated).
 *   Grants bind to the app's cdhash under adhoc signing, so they decay
 *   across rebuilds. probePermissions() tells the user exactly what to grant.
 *
 * INPUT ACTUATION (routes verified live):
 *   - Mouse (click/right/double/drag/scroll): CGEvent via JXA — one uniform
 *     path; handles button variants and click-state natively.
 *   - Keyboard (type/key): System Events keystroke / key code (compile-
 *     verified primitives).
 *
 * Virtual keycodes below are transcribed from HIToolbox's Events.h
 * (Xcode SDK header — the authoritative source; never hand-invented).
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { app, systemPreferences, desktopCapturer } from "electron";
import { execThroughWorker } from "./tool-executor.mjs";

// ── Keycodes from HIToolbox Events.h ──────────────────────────────────────
const K = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07,
  c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10,
  t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
  "=": 0x18, "9": 0x19, "7": 0x1a, "-": 0x1b, "8": 0x1c, "0": 0x1d,
  "]": 0x1e, o: 0x1f, u: 0x20, "[": 0x21, i: 0x22, p: 0x23,
  return: 0x24, enter: 0x24, l: 0x25, j: 0x26, "'": 0x27, k: 0x28,
  ";": 0x29, "\\": 0x2a, ",": 0x2b, "/": 0x2c, n: 0x2d, m: 0x2e,
  ".": 0x2f, tab: 0x30, space: 0x31, "`": 0x32,
  delete: 0x33, backspace: 0x33, escape: 0x35, esc: 0x35,
  command: 0x37, cmd: 0x37, shift: 0x38, capslock: 0x39,
  option: 0x3a, alt: 0x3a, opt: 0x3a, control: 0x3b, ctrl: 0x3b,
  rightcommand: 0x36, rightshift: 0x3c, rightoption: 0x3d,
  rightcontrol: 0x3e, fn: 0x3f,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62,
  f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
  f13: 0x69, f14: 0x6b, f15: 0x71, f16: 0x6a, f17: 0x40,
  f18: 0x4f, f19: 0x50, f20: 0x5a,
  keypad0: 0x52, keypad1: 0x53, keypad2: 0x54, keypad3: 0x55,
  keypad4: 0x56, keypad5: 0x57, keypad6: 0x58, keypad7: 0x59,
  keypad8: 0x5b, keypad9: 0x5c, keypaddecimal: 0x41, keypadplus: 0x45,
  keypadminus: 0x4e, keypadmultiply: 0x43, keypaddivide: 0x4b,
  keypadequal: 0x51, keypadenter: 0x4c, keypadclear: 0x47,
  help: 0x72, home: 0x73, pageup: 0x74, forwarddelete: 0x75,
  end: 0x77, pagedown: 0x79,
  leftarrow: 0x7b, rightarrow: 0x7c, downarrow: 0x7d, uparrow: 0x7e,
  left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
  "↑": 0x7e, "↓": 0x7d, "←": 0x7b, "→": 0x7c,
  volumeup: 0x48, volumedown: 0x49, mute: 0x4a,
};

/** Modifier name → AppleScript `using` token. */
const MODS = {
  cmd: "command down", command: "command down", "⌘": "command down",
  ctrl: "control down", control: "control down", "⌃": "control down",
  alt: "option down", opt: "option down", option: "option down",
  "⌥": "option down",
  shift: "shift down", "⇧": "shift down",
  fn: "fn down",
};

/** Resolve a key name to its virtual keycode; null if unknown. */
export function resolveKeyCode(name) {
  if (typeof name !== "string") return null;
  return K[name.trim().toLowerCase()] ?? null;
}

// ── Shell helpers ──────────────────────────────────────────────────────────
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function osaEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function firstErr(r, fallback) {
  return (r.stderr || r.stdout || r.errorMessage || fallback || "unknown").toString().trim();
}

async function runJxa(code, timeout = 15) {
  return execThroughWorker(`osascript -l JavaScript -e ${shellQuote(code)}`, { timeout });
}

async function runOsa(script, timeout = 15) {
  return execThroughWorker(`osascript -e ${shellQuote(script)}`, { timeout });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Permission probes (per call; grants decay across rebuilds) ────────────

async function probeScreenRecording() {
  // Native probe — systemPreferences.getMediaAccessStatus('screen') is the
  // exact TCC state ('granted' | 'denied' | 'restricted' | 'not-determined')
  // with no side effects and no shell round-trip. Falls back to the
  // screencapture probe only when the native API is unavailable (non-macOS
  // main processes, exotic Electron builds).
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return { ok: true };
    return {
      ok: false,
      error:
        "Screen Recording permission is not granted to Pane " +
        `(TCC state: ${status}). Tell the user: System Settings → Privacy & Security → ` +
        "Screen Recording → enable Pane, then retry.",
    };
  } catch (e) {
    console.warn("[computer-use] native screen probe unavailable, falling back to shell:", e.message);
  }
  const tmp = path.join(os.tmpdir(), `pane-cu-probe-${Date.now()}.png`);
  const r = await execThroughWorker(
    `/usr/sbin/screencapture -x -R0,0,1,1 "${tmp}" 2>/tmp/pane-cu-sr-err.txt; sips -g pixelWidth -g pixelHeight "${tmp}" 2>/dev/null`,
    { timeout: 10 }
  );
  const stderrDetail = fs.existsSync("/tmp/pane-cu-sr-err.txt")
    ? fs.readFileSync("/tmp/pane-cu-sr-err.txt", "utf8").trim().slice(0, 200)
    : "";
  try { fs.rmSync("/tmp/pane-cu-sr-err.txt", { force: true }); } catch (e) { console.warn("[computer-use] probe temp cleanup:", e.message); }
  fs.rmSync(tmp, { force: true });
  const m = (r.stdout || "").match(/pixelWidth: (\d+)/);
  if (r.success && m && Number(m[1]) > 0) return { ok: true };
  return {
    ok: false,
    error:
      "Screen Recording permission is not granted to Pane (or the display is unavailable). " +
      "Tell the user: System Settings → Privacy & Security → Screen Recording → enable Pane, then retry. " +
      `Probe detail: ${stderrDetail || firstErr(r, "no output")}`,
  };
}

/**
 * Canonical Accessibility probe. AXIsProcessTrusted() is the exact TCC check
 * macOS applies before allowing synthesized input — no side effects, and
 * unlike a System Events query it does NOT pass on a mere AppleScript/
 * Automation grant. Empirically verified on this machine: with
 * trusted=false, keystroke returns error 1002 and CGEventPost SILENTLY
 * DROPS events (CGEventSourceSecondsSinceLastEventType stayed >240s after a
 * "successful" post). A weak probe here would let every input call report
 * success while doing nothing.
 */
async function probeAccessibility() {
  const r = await runJxa(
    'ObjC.import("ApplicationServices"); JSON.stringify({trusted: ObjC.unwrap($.AXIsProcessTrusted())})'
  );
  const m = (r.stdout || "").match(/\{.*\}/);
  if (r.success && m) {
    try {
      if (JSON.parse(m[0]).trusted === true) return { ok: true };
    } catch { /* fall through to error */ }
  }
  return {
    ok: false,
    error:
      "Accessibility permission is not granted to Pane. macOS silently drops synthesized mouse/keyboard events " +
      "in this state — retrying will not help. Tell the user: System Settings → Privacy & Security → " +
      "Accessibility → enable Pane (toggle it off/on if already on), then retry.",
  };
}

/** Probe both TCC permissions. Cheap; safe to call anytime. */
export async function probePermissions() {
  const [screen, a11y] = await Promise.all([probeScreenRecording(), probeAccessibility()]);
  return {
    screenRecording: screen.ok,
    accessibility: a11y.ok,
    errors: [!screen.ok && screen.error, !a11y.ok && a11y.error].filter(Boolean),
    note: "Permissions bind to this app build; re-probe after any app restart or rebuild.",
  };
}

/**
 * Trigger macOS's NATIVE Accessibility prompt (the system dialog asking to
 * grant Accessibility in System Settings). Idempotent — safe when already
 * granted; no prompt appears in that case. JS-literal → NSDictionary bridge
 * verified working on this machine (the dictionaryWithDictionary: JXA route
 * throws wrong-number-of-arguments; the mutable-dict route segfaults osascript).
 */
export async function requestAccessibilityPrompt() {
  const r = await runJxa(
    'ObjC.import("ApplicationServices"); ' +
      'JSON.stringify({trusted: ObjC.unwrap($.AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true}))})'
  );
  const m = (r.stdout || "").match(/\{.*\}/);
  try {
    if (r.success && m && JSON.parse(m[0]).trusted === true) return { ok: true, already: true };
  } catch { /* fall through */ }
  // trusted=false means the prompt fired (or is already pending). Not an error.
  if (r.success) return { ok: true, already: false, prompted: true };
  return { ok: false, error: `AXIsProcessTrustedWithOptions failed: ${firstErr(r)}` };
}

/**
 * Trigger macOS's NATIVE Screen Recording prompt. CGRequestScreenCaptureAccess()
 * exists on 10.15+ but is not JXA-bridgable (verified: symbol absent from the
 * JXA bridge). Electron's desktopCapturer.getSources() is the documented
 * substitute: when TCC state is 'not-determined' the system renders its
 * Screen Recording permission dialog; when already granted it simply returns
 * sources. thumbnailSize 1×1 keeps it cheap — we only want the TCC effect.
 */
export async function requestScreenRecordingPrompt() {
  try {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted") return { ok: true, already: true };
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
    // If sources came back non-empty, permission was granted along the way.
    const grantedAfter = systemPreferences.getMediaAccessStatus("screen") === "granted";
    return {
      ok: true,
      already: false,
      prompted: true,
      grantedAfter,
      sources: sources.length,
    };
  } catch (e) {
    return { ok: false, error: `desktopCapturer screen prompt failed: ${e.message}` };
  }
}

/**
 * The app's code-signature identity as TCC sees it. TCC grants bind to this
 * value — a rebuild or re-sign changes it and silently voids every grant.
 * Persisted under userData; on next launch a mismatch is detectable.
 */
export async function getTccIdentity() {
  // Derive the running .app bundle from the executable — works packaged
  // (…/Pane.app/Contents/MacOS/Pane) and dev (…/Electron.app/…/Electron).
  // Hardcoding /Applications/Pane.app would describe a different build than
  // the one actually running whenever dev-mode launches precede a reinstall.
  const exeDir = path.dirname(process.execPath);
  const appBundle = path.resolve(exeDir, "..", "..");
  const r = await execThroughWorker(
    `codesign -dv "${appBundle}" 2>&1 | grep -m1 -E "^Identifier|^TeamIdentifier"`,
    { timeout: 10 }
  );
  const out = (r.stdout || "") + (r.stderr || "");
  const id = (out.match(/Identifier=(\S+)/) || [])[1] || "unknown";
  const team = (out.match(/TeamIdentifier=(\S+)/) || [])[1] || "none";
  return { identifier: id, team, raw: out.trim().slice(0, 300) };
}

/**
 * Launch-time permission gate. Call once from app.whenReady() on macOS.
 * Behavior:
 *   1. Probe Screen Recording + Accessibility (cheap, no prompts).
 *   2. If Accessibility missing → fire the NATIVE macOS prompt (once per
 *      launch) so the user grants it in System Settings without any model
 *      turn having to fail first.
 *   3. If Screen Recording missing → log a clear warning. (No direct API to
 *      trigger its native prompt; CGPreflightScreenCaptureAccess /
 *      CGRequestScreenCaptureAccess exist on macOS 10.15+ — see note below.)
 *   4. Watch the app's TCC identity across launches. A rebuild re-signs the
 *      bundle and silently voids grants — surface that instead of letting
 *      every subsequent probe fail with a stale-identity denial.
 */
export async function checkPermissionsAtLaunch() {
  if (process.platform !== "darwin") return { skipped: true, reason: "not macOS" };
  const result = { screenRecording: false, accessibility: false, prompted: false, identityChanged: false };
  const [screen, a11y] = await Promise.all([probeScreenRecording(), probeAccessibility()]);
  result.screenRecording = screen.ok;
  result.accessibility = a11y.ok;

  // TCC identity watch — detect rebuild-induced grant invalidation.
  try {
    const identity = await getTccIdentity();
    const markerPath = path.join(app.getPath("userData"), "tcc-identity.json");
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { /* first run */ }
    if (prev && (prev.identifier !== identity.identifier || prev.team !== identity.team)) {
      result.identityChanged = true;
      console.warn(
        `[computer-use] TCC identity changed since last launch ` +
        `(${prev.identifier}/${prev.team} → ${identity.identifier}/${identity.team}). ` +
        `macOS has voided Pane's Screen Recording and Accessibility grants for the new build. ` +
        `Re-grant in System Settings → Privacy & Security → Screen Recording and Accessibility.`
      );
    }
    fs.writeFileSync(markerPath, JSON.stringify({ ...identity, at: new Date().toISOString() }));
  } catch (e) {
    console.warn("[computer-use] TCC identity watch failed:", e.message);
  }

  if (result.accessibility && result.screenRecording) return result;

  // Missing permission(s) → fire the NATIVE macOS prompts (once per launch).
  // Both are idempotent when already granted; neither blocks startup.
  const prompts = [];
  if (!result.accessibility) {
    result.prompted = true;
    prompts.push(
      requestAccessibilityPrompt().then(p => {
        if (!p.ok) console.warn("[computer-use] accessibility prompt request failed:", p.error);
      })
    );
  }
  if (!result.screenRecording) {
    result.prompted = true;
    prompts.push(
      requestScreenRecordingPrompt().then(p => {
        if (!p.ok) console.warn("[computer-use] screen recording prompt request failed:", p.error);
      })
    );
  }
  await Promise.all(prompts);

  // Re-probe after prompting — if the user granted instantly, the gate
  // result reflects it; also guards against prompt-then-grant races.
  const [screen2, a11y2] = await Promise.all([probeScreenRecording(), probeAccessibility()]);
  result.screenRecordingAfterPrompt = screen2.ok;
  result.accessibilityAfterPrompt = a11y2.ok;
  return result;
}

// ── Display geometry ───────────────────────────────────────────────────────

/**
 * Main display geometry in both spaces.
 * Returns { ok, logical:{w,h}, physical:{w,h}, scale }.
 */
export async function getDisplayInfo() {
  const r = await runJxa(
    'ObjC.import("AppKit");' +
      'const s = $.NSScreen.mainScreen, f = s.frame;' +
      'JSON.stringify({w: ObjC.unwrap(f.size.width), h: ObjC.unwrap(f.size.height), scale: ObjC.unwrap(s.backingScaleFactor)});'
  );
  try {
    const d = JSON.parse((r.stdout || "").trim());
    if (!d.w || !d.h) throw new Error("empty frame");
    return {
      ok: true,
      logical: { w: d.w, h: d.h },
      physical: { w: Math.round(d.w * d.scale), h: Math.round(d.h * d.scale) },
      scale: d.scale || 1,
    };
  } catch {
    return { ok: false, error: `Could not read display info: ${firstErr(r)}` };
  }
}

/** Physical screenshot px → logical points (the ONLY conversion site). */
function toLogical(x, y, scale) {
  return { x: Math.round(x / scale), y: Math.round(y / scale) };
}

/** Read PNG pixel dimensions via sips. Returns {ok,w,h} or {ok:false,error}. */
export async function readPngSize(pngPath) {
  const r = await execThroughWorker(`sips -g pixelWidth -g pixelHeight "${pngPath}"`, { timeout: 10 });
  const w = (r.stdout || "").match(/pixelWidth: (\d+)/);
  const h = (r.stdout || "").match(/pixelHeight: (\d+)/);
  if (r.success && w && h) return { ok: true, w: Number(w[1]), h: Number(h[1]) };
  return { ok: false, error: `could not read PNG size: ${firstErr(r)}` };
}

// ── Screen capture ─────────────────────────────────────────────────────────

/**
 * Capture the screen (or a region) to a PNG.
 * @param {{x?:number,y?:number,w?:number,h?:number}} region — PHYSICAL pixels
 *        (screenshot space); converted to logical for -R internally.
 * @param {string} [outPath] — destination; default tmp.
 */
export async function captureScreen(region, outPath) {
  const perm = await probeScreenRecording();
  if (!perm.ok) return perm;

  const out = outPath || path.join(os.tmpdir(), `pane-shot-${Date.now()}.png`);

  let cmd = "/usr/sbin/screencapture -x";
  if (region) {
    const info = await getDisplayInfo();
    if (!info.ok) return info;
    const p = toLogical(region.x, region.y, info.scale);
    const w = Math.max(1, Math.round((region.w || 1) / info.scale));
    const h = Math.max(1, Math.round((region.h || 1) / info.scale));
    cmd += ` -R${p.x},${p.y},${w},${h}`;
  }
  cmd += ` "${out}"`;

  const r = await execThroughWorker(cmd, { timeout: 20 });
  if (!r.success) {
    fs.rmSync(out, { force: true });
    return { ok: false, error: `screencapture failed: ${firstErr(r)}` };
  }
  try {
    const st = fs.statSync(out);
    if (st.size === 0) throw new Error("empty file");
    return { ok: true, path: out, bytes: st.size };
  } catch {
    return { ok: false, error: `screenshot file missing or empty: ${out}` };
  }
}

// ── Mouse actuation (CGEvent via JXA — one uniform path) ──────────────────

// CGEvent types (kCGEvent*): leftDown 1, leftUp 2, rightDown 3, rightUp 25,
// mouseMoved 5, scrollWheel 22. Button 0 = left, 1 = right (CGMouseButton).
const JXA_PREAMBLE = 'ObjC.import("CoreGraphics"); ObjC.import("AppKit"); const tap = $.kCGHIDEventTap;';

async function cgMouse(physX, physY, events, stepSleepMs = 16) {
  const info = await getDisplayInfo();
  if (!info.ok) return info;
  const perm = await probeAccessibility();
  if (!perm.ok) return perm;
  const { x, y } = toLogical(physX, physY, info.scale);

  // Build the JXA: a small runtime that takes event specs as arrays.
  // Spec: [type, x, y, button, clickState]
  const specs = events.map((e) => `[${e.type}, ${e.x ?? x}, ${e.y ?? y}, ${e.button ?? 0}, ${e.clickState ?? 1}]`);
  const jxa = `${JXA_PREAMBLE}
const specs = [${specs.join(", ")}];
for (const [t, mx, my, btn, cs] of specs) {
  const ev = $.CGEventCreateMouseEvent(null, t, $.CGPointMake(mx, my), btn);
  if (cs > 1) ev.setIntegerValueForField(1, cs); // kCGMouseEventClickState
  $.CGEventPost(tap, ev);
  if (specs.length > 1) ${stepSleepMs > 0 ? `$.NSThread.sleepForTimeInterval(${(stepSleepMs / 1000).toFixed(3)});` : ""}
}
// Post-hoc verification: confirm our event actually registered with the HID
// system. Untrusted processes can post without error while macOS silently
// drops the event — this check converts that silent no-op into a hard error.
const state = $.kCGEventSourceStateCombinedSessionState;
const sinceMouse = ObjC.unwrap($.CGEventSourceSecondsSinceLastEventType(state, $.kCGEventLeftMouseDown));
const sinceKey = ObjC.unwrap($.CGEventSourceSecondsSinceLastEventType(state, $.kCGEventKeyDown));
const recent = (s) => typeof s === "number" && s >= 0 && s < 1.5;
JSON.stringify({registered: recent(sinceMouse) || recent(sinceKey) ? true : false, sinceMouse, sinceKey});`;
  const r = await runJxa(jxa);
  if (!r.success) return { ok: false, error: `CGEvent mouse failed: ${firstErr(r)}` };
  const m = (r.stdout || "").match(/\{.*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (v.registered) return { ok: true };
      return {
        ok: false,
        error:
          `Input event was posted but did NOT register with the HID system (sinceMouse=${v.sinceMouse}s, sinceKey=${v.sinceKey}s). ` +
          "This is the macOS silent-drop state — almost always missing Accessibility permission for this exact app build. " +
          "Tell the user: System Settings → Privacy & Security → Accessibility → re-enable Pane, then retry.",
      };
    } catch { /* fall through */ }
  }
  return { ok: true };
}

/**
 * Click at PHYSICAL-pixel coordinates. double → two clicks with clickState 2;
 * right → right button.
 */
export async function clickAt(p) {
  if (p.double) {
    return cgMouse(p.x, p.y, [
      { type: 1, button: p.right ? 1 : 0, clickState: 1 },
      { type: p.right ? 3 : 2, button: p.right ? 1 : 0 },
      { type: 1, button: p.right ? 1 : 0, clickState: 2 },
      { type: p.right ? 3 : 2, button: p.right ? 1 : 0 },
    ]);
  }
  return cgMouse(p.x, p.y, [
    { type: 1, button: p.right ? 1 : 0 },
    { type: p.right ? 3 : 2, button: p.right ? 1 : 0 },
  ]);
}

/** Move the pointer to PHYSICAL-pixel coordinates (no click). */
export async function movePointerTo(p) {
  return cgMouse(p.x, p.y, [{ type: 5 }], 0);
}

/**
 * Drag between two PHYSICAL-pixel points: mouse-down at from, interpolated
 * moves, mouse-up at to.
 */
export async function dragFromTo(from, to) {
  const info = await getDisplayInfo();
  if (!info.ok) return info;
  const perm = await probeAccessibility();
  if (!perm.ok) return perm;
  const a = toLogical(from.x, from.y, info.scale);
  const b = toLogical(to.x, to.y, info.scale);
  const STEPS = 12;

  // Build interpolated move specs in JXA itself (cleaner than emitting 12 specs).
  const jxa = `${JXA_PREAMBLE}
const p1 = $.CGPointMake(${a.x}, ${a.y}), p2 = $.CGPointMake(${b.x}, ${b.y});
const down = $.CGEventCreateMouseEvent(null, 1, p1, 0);
$.CGEventPost(tap, down);
$.NSThread.sleepForTimeInterval(0.05);
for (let i = 1; i <= ${STEPS}; i++) {
  const t = i / ${STEPS};
  const mv = $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t), 0);
  $.CGEventPost(tap, mv);
  $.NSThread.sleepForTimeInterval(0.016);
}
const up = $.CGEventCreateMouseEvent(null, 2, p2, 0);
$.CGEventPost(tap, up);
// Post-hoc verification (see cgMouse): drag must register a left-mouse-down.
const state = $.kCGEventSourceStateCombinedSessionState;
const sinceMouse = ObjC.unwrap($.CGEventSourceSecondsSinceLastEventType(state, $.kCGEventLeftMouseDown));
JSON.stringify({registered: typeof sinceMouse === "number" && sinceMouse >= 0 && sinceMouse < 1.5, sinceMouse});`;
  const r = await runJxa(jxa);
  if (!r.success) return { ok: false, error: `drag failed: ${firstErr(r)}` };
  const m = (r.stdout || "").match(/\{.*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (!v.registered) {
        return {
          ok: false,
          error:
            `Drag posted but did not register (sinceMouse=${v.sinceMouse}s). macOS silent-drop state — missing Accessibility for this app build. ` +
            "Tell the user: System Settings → Privacy & Security → Accessibility → re-enable Pane, then retry.",
        };
      }
    } catch { /* fall through */ }
  }
  return { ok: true };
}

/**
 * Scroll. direction: "up"|"down". amount in wheel "lines" (~3 px each at
 * default settings). Position ignored by macOS for wheel events (scrolls the
 * view under the pointer), kept for API symmetry.
 */
export async function scrollAt(direction, amount) {
  const perm = await probeAccessibility();
  if (!perm.ok) return perm;
  const sign = direction === "up" ? -1 : 1;
  const wheel = Math.max(1, Math.round(amount || 3)) * sign;
  const jxa = `${JXA_PREAMBLE}
const ev = $.CGEventCreateScrollWheelEvent(null, 0, 1, ${wheel});
$.CGEventPost(tap, ev);
// Post-hoc verification (see cgMouse): a scroll that macOS dropped would
// leave seconds-since-last-scroll unchanged (large). kCGEventScrollWheel = 22.
const state = $.kCGEventSourceStateCombinedSessionState;
const since = ObjC.unwrap($.CGEventSourceSecondsSinceLastEventType(state, 22));
JSON.stringify({registered: typeof since === "number" && since >= 0 && since < 1.5, since});`;
  const r = await runJxa(jxa);
  if (!r.success) return { ok: false, error: `scroll failed: ${firstErr(r)}` };
  const m = (r.stdout || "").match(/\{.*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      if (!v.registered) {
        return {
          ok: false,
          error:
            `Scroll posted but did not register (since=${v.since}s). macOS silent-drop state — missing Accessibility for this app build. ` +
            "Tell the user: System Settings → Privacy & Security → Accessibility → re-enable Pane, then retry.",
        };
      }
    } catch { /* fall through */ }
  }
  return { ok: true };
}

// ── Keyboard actuation (System Events) ─────────────────────────────────────

/** Type literal text into the frontmost app. */
export async function typeText(text) {
  const perm = await probeAccessibility();
  if (!perm.ok) return perm;
  const r = await runOsa(`tell application "System Events" to keystroke "${osaEscape(text)}"`);
  if (r.success) return { ok: true };
  const err = firstErr(r);
  if (/assistive access|-1719/i.test(err)) {
    return { ok: false, error: perm.error || err };
  }
  return { ok: false, error: `keystroke failed: ${err}` };
}

/**
 * Press a named key with optional modifiers.
 * @param {string} key — any name in the keycode table (e.g. "return", "a", "⌘").
 * @param {string[]} modifiers — cmd/ctrl/alt/shift/fn (or symbols).
 */
export async function pressKey(key, modifiers = []) {
  const code = resolveKeyCode(key);
  if (code === null) {
    const modHint = MODS[String(key).trim().toLowerCase()];
    if (modHint) {
      return {
        ok: false,
        error: `"${key}" is a modifier, not a pressable key. Pass it in the modifiers array: pressKey("c", ["${String(key).trim()}"]).`,
      };
    }
    const known = Object.keys(K).filter((k) => k.length === 1 || !/^(left|right|up|down)$/.test(k)).sort().join(", ");
    return { ok: false, error: `Unknown key "${key}". Known keys: ${known}` };
  }
  const perm = await probeAccessibility();
  if (!perm.ok) return perm;
  const using = (modifiers || [])
    .map((m) => MODS[String(m).trim().toLowerCase()])
    .filter(Boolean);
  const script =
    `tell application "System Events" to key code ${code}` +
    (using.length ? ` using {${using.join(", ")}}` : "");
  const r = await runOsa(script);
  if (r.success) return { ok: true };
  const err = firstErr(r);
  if (/assistive access|-1719/i.test(err)) {
    return { ok: false, error: perm.error || err };
  }
  return { ok: false, error: `key code failed: ${err}` };
}
