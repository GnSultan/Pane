/**
 * macOS accessibility-tree element discovery for the computer tool.
 *
 * Pixel coordinates fail for small/dense targets; the AX tree gives
 * element-level identity (role + name + bounds) that never drifts. This
 * module exposes:
 *
 *   listElements(opts)  — filtered enumeration of the frontmost app's window
 *   readFocusedUI()     — what currently has keyboard focus
 *
 * Bounds are returned in the MODEL'S SEEN SPACE (logical points converted
 * via the last screenshot's seen/physical ratio) so results are directly
 * clickable through the existing pixel path. AX for discovery, CGEvent for
 * actuation — synthesized AX actions are slower and app-dependent.
 *
 * Implementation notes (empirically verified Oct 2026):
 * - System Events AppleScript is the only route: the JXA ObjC bridge cannot
 *   call AXUIElementCopyAttributeValue (C out-parameters unbridgeable —
 *   returns error -25201).
 * - `every button of window 1` returns DIRECT children only; deep discovery
 *   requires a recursive walk (walk handler below).
 * - Walk cost is per-element AX round trips: Safari full window ≈3s/12
 *   hits; dense trees (Music ≈400 elems) exceed 30s uncapped. Hence hard
 *   budgets: visited cap + matched cap + depth cap + exec timeout.
 * - Chromium/Electron apps (including Pane itself) expose NO AX tree until
 *   accessibility is enabled in the app — listElements returns empty there
 *   and the pixel path remains the only option. This layer targets native
 *   macOS apps (System Settings, native dialogs, Finder...), which is where
 *   coordinates hurt most anyway.
 * - AppleScript strings cannot contain \uXXXX escapes and control
 *   characters are mangled through osascript stdout — use printable
 *   sentinels for field/record separators.
 */

import { execThroughWorker } from "./tool-executor.mjs";

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const F = "@@F@@"; // field separator
const R = "@@R@@"; // record separator
const A = "@@A@@"; // app-name separator

/** AppleScript class names for our role vocabulary. */
const ROLE_TO_CLASS = {
  button: "button",
  checkbox: "checkbox",
  "radio button": "radio button",
  "text field": "text field",
  "static text": "static text",
  menu: "menu",
  "menu item": "menu item",
  "menu button": "menu button",
  "pop up button": "pop up button",
  list: "list",
  row: "row",
  slider: "slider",
  tab: "tab",
  table: "table",
  toolbar: "toolbar",
  image: "image",
};

// Role description (AX) → our canonical role names. class of e returns
// AppleScript class names which match ROLE_TO_CLASS keys already.
const ROLE_DESCRIPTIONS = new Set(Object.keys(ROLE_TO_CLASS));

/** Escape text for an AppleScript string literal. */
function asEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the recursive walk script. Budgets: maxVisited bounds total AX
 * queries (runtime ≈ 10-15ms per visited element), maxMatched bounds output
 * size, maxDepth bounds recursion.
 */
function buildWalkScript({ roles, nameContains, nameIs, maxVisited, maxDepth }) {
  const roleList = roles.map((r) => `"${asEscape(ROLE_TO_CLASS[r] || r)}"`).join(", ");
  const nameFilter = nameIs
    ? `if n is not "${asEscape(nameIs)}" then set skip to true`
    : nameContains
      ? `if n does not contain "${asEscape(nameContains)}" then set skip to true`
      : "";
  return `
on walk(e, depth, maxDepth, budget)
  set out to ""
  set visited to 0
  if depth is greater than maxDepth then return out
  tell application "System Events"
    try
      set kids to UI elements of e
    on error
      return out
    end try
    repeat with c in kids
      if budget's visited is greater than or equal to ${maxVisited} then exit repeat
      set budget's visited to (budget's visited) + 1
      try
        set theClass to (class of c) as text
        if theClass is in {${roleList}} then
          set n to ""
          try
            set n to (name of c) as text
          end try
          set skip to false
          ${nameFilter}
          if skip is false then
            set p to (position of c) as list
            set s to (size of c) as list
            set out to out & theClass & "${F}" & n & "${F}" & ((item 1 of p) as text) & "${F}" & ((item 2 of p) as text) & "${F}" & ((item 1 of s) as text) & "${F}" & ((item 2 of s) as text) & "${R}"
          end if
        end if
      end try
      set out to out & my walk(c, depth + 1, maxDepth, budget)
    end repeat
  end tell
  return out
end walk

tell application "System Events"
  tell (first application process whose frontmost is true)
    set appName to name
    set budget to {visited:0}
    set theResult to my walk(window 1, 0, ${maxDepth}, budget)
    return appName & "${A}" & theResult
  end tell
end tell`;
}

/**
 * Enumerate AX elements of the frontmost application's frontmost window.
 * @param {{role?: string, nameContains?: string, nameIs?: string, limit?: number}} opts
 * @param {{width:number, height:number, physicalW:number, physicalH:number}|null} lastSeen
 *        pixel space of the model's last screenshot; bounds are converted
 *        into this space. Null → logical points returned raw.
 */
export async function listElements(opts = {}, lastSeen = null) {
  const roles = opts.role && ROLE_TO_CLASS[opts.role] ? [opts.role]
    : ROLE_DESCRIPTIONS.has(opts.role) ? [opts.role]
    : Object.keys(ROLE_TO_CLASS);
  const maxMatched = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 60) : 30;
  const maxVisited = 400; // ≈4-6s worst case; bounds the walk on dense trees
  const maxDepth = 7;

  const script = buildWalkScript({
    roles,
    nameContains: typeof opts.nameContains === "string" ? opts.nameContains : null,
    nameIs: typeof opts.nameIs === "string" ? opts.nameIs : null,
    maxVisited,
    maxMatched,
    maxDepth,
  });

  const r = await execThroughWorker(`osascript -e ${shellQuote(script)}`, { timeout: 30 });
  if (!r.success) {
    const err = (r.stderr || r.stdout || r.errorMessage || "unknown").toString().trim();
    return { ok: false, error: `AX query failed: ${err.slice(0, 300)}` };
  }
  const raw = (r.stdout || "").trim();
  const parts = raw.split(A);
  const app = parts[0] || "unknown";
  const rows = (parts[1] || "").split(R).filter(Boolean).slice(0, maxMatched);

  // Convert logical points → model-seen space when a reference screenshot exists.
  const sx = lastSeen && lastSeen.physicalW ? lastSeen.width / lastSeen.physicalW : 1;
  const sy = lastSeen && lastSeen.physicalH ? lastSeen.height / lastSeen.physicalH : 1;
  const elements = rows.map((row) => {
    const [role, name, x, y, w, h] = row.split(F);
    const lx = Number(x), ly = Number(y), lw = Number(w), lh = Number(h);
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) return null;
    return {
      role: role || "element",
      name: name && name !== "missing value" ? name : "",
      x: Math.round(lx * sx),
      y: Math.round(ly * sy),
      w: Math.max(1, Math.round((Number.isFinite(lw) ? lw : 1) * sx)),
      h: Math.max(1, Math.round((Number.isFinite(lh) ? lh : 1) * sy)),
    };
  }).filter(Boolean);

  if (elements.length === 0) {
    return {
      ok: true,
      app,
      elements,
      note: "No matching elements. If this is a Chromium/Electron app (incl. browsers' web content), the AX tree may be empty — use the screenshot path instead.",
    };
  }
  return { ok: true, app, elements };
}

/**
 * Describe what currently has keyboard focus in the frontmost app —
 * useful to confirm a text field is focused before typing.
 */
export async function readFocusedUI(lastSeen = null) {
  const script = `
tell application "System Events"
  tell (first application process whose frontmost is true)
    set out to ""
    try
      set f to value of attribute "AXFocusedUIElement" of it
      if f is missing value then
        set out to "NONE" & "${F}"
      else
        set r to (role of f) as text
        set n to ""
        try
          set n to (name of f) as text
        end try
        set v to ""
        try
          set v to (value of f) as text
        end try
        set p to (position of f) as list
        set s to (size of f) as list
        set out to r & "${F}" & n & "${F}" & v & "${F}" & ((item 1 of p) as text) & "${F}" & ((item 2 of p) as text) & "${F}" & ((item 1 of s) as text) & "${F}" & ((item 2 of s) as text)
      end if
    on error errMsg
      set out to "ERROR" & "${F}" & errMsg
    end try
    return out
  end tell
end tell`;
  const r = await execThroughWorker(`osascript -e ${shellQuote(script)}`, { timeout: 15 });
  if (!r.success) {
    return { ok: false, error: `AX focus read failed: ${(r.stderr || "unknown").toString().trim().slice(0, 200)}` };
  }
  const raw = (r.stdout || "").trim();
  if (!raw) return { ok: false, error: "no focused element" };
  const [roleOrErr, name = "", value = "", x = "", y = "", w = "", h = ""] = raw.split(F);
  if (roleOrErr === "ERROR") return { ok: false, error: `AX focus read failed: ${name.slice(0, 200)}` };
  if (roleOrErr === "NONE") return { ok: true, role: "none", name: "", value: "", note: "No focused UI element reported (common for Electron/Chromium apps before a field is clicked)." };
  const sx = lastSeen && lastSeen.physicalW ? lastSeen.width / lastSeen.physicalW : 1;
  const sy = lastSeen && lastSeen.physicalH ? lastSeen.height / lastSeen.physicalH : 1;
  const lx = Number(x), ly = Number(y);
  return {
    ok: true,
    role: roleOrErr || "unknown",
    name: name === "missing value" ? "" : name,
    value: String(value === "missing value" ? "" : value).slice(0, 300),
    x: Number.isFinite(lx) ? Math.round(lx * sx) : undefined,
    y: Number.isFinite(ly) ? Math.round(ly * sy) : undefined,
    w: Number.isFinite(Number(w)) ? Math.max(1, Math.round(Number(w) * sx)) : undefined,
    h: Number.isFinite(Number(h)) ? Math.max(1, Math.round(Number(h) * sy)) : undefined,
  };
}
