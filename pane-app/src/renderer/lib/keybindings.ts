// Keyboard shortcut rebinding system — types, defaults, matching, display

export type ActionId =
  | "toggle-panel"
  | "toggle-mode"
  | "fuzzy-finder"
  | "file-search"
  | "focus-chat"
  | "new-file"
  | "settings"
  | "cycle-theme"
  | "font-size-increase"
  | "font-size-decrease"
  | "font-size-reset";

export interface KeyBinding {
  mod: boolean;   // Cmd (Mac) / Ctrl (Win/Linux)
  shift: boolean;
  alt: boolean;
  key: string;    // lowercase KeyboardEvent.key
}

interface ActionDefinition {
  id: ActionId;
  label: string;
  defaultBinding: KeyBinding;
}

const isMac = navigator.platform.includes("Mac");

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  { id: "toggle-panel",       label: "toggle sidebar",    defaultBinding: { mod: true, shift: false, alt: false, key: "b" } },
  { id: "toggle-mode",        label: "toggle chat / editor", defaultBinding: { mod: true, shift: false, alt: false, key: "/" } },
  { id: "fuzzy-finder",       label: "search files",      defaultBinding: { mod: true, shift: false, alt: false, key: "p" } },
  { id: "file-search",        label: "search in files",   defaultBinding: { mod: true, shift: true,  alt: false, key: "f" } },
  { id: "focus-chat",         label: "focus chat",        defaultBinding: { mod: true, shift: false, alt: false, key: "k" } },
  { id: "new-file",           label: "new file",          defaultBinding: { mod: true, shift: false, alt: false, key: "n" } },
  { id: "settings",           label: "settings",          defaultBinding: { mod: true, shift: false, alt: false, key: "," } },
  { id: "cycle-theme",        label: "cycle theme",       defaultBinding: { mod: true, shift: true,  alt: false, key: "t" } },
  { id: "font-size-increase", label: "increase font size", defaultBinding: { mod: true, shift: false, alt: false, key: "=" } },
  { id: "font-size-decrease", label: "decrease font size", defaultBinding: { mod: true, shift: false, alt: false, key: "-" } },
  { id: "font-size-reset",    label: "reset font size",   defaultBinding: { mod: true, shift: false, alt: false, key: "0" } },
];

export const DEFAULT_BINDINGS: Record<ActionId, KeyBinding> = Object.fromEntries(
  ACTION_DEFINITIONS.map((a) => [a.id, a.defaultBinding])
) as Record<ActionId, KeyBinding>;

// System-reserved keys that can't be rebound
const RESERVED: KeyBinding[] = [
  { mod: true, shift: false, alt: false, key: "q" },
  { mod: true, shift: false, alt: false, key: "w" },
  { mod: true, shift: false, alt: false, key: "c" },
  { mod: true, shift: false, alt: false, key: "v" },
  { mod: true, shift: false, alt: false, key: "x" },
  { mod: true, shift: false, alt: false, key: "a" },
  { mod: true, shift: false, alt: false, key: "z" },
  { mod: true, shift: false, alt: false, key: "h" },
  { mod: true, shift: false, alt: false, key: "m" },
];

export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

export function isReserved(binding: KeyBinding): boolean {
  return RESERVED.some((r) => bindingsEqual(r, binding));
}

export function isModifierOnly(e: KeyboardEvent): boolean {
  return e.key === "Meta" || e.key === "Control" || e.key === "Shift" || e.key === "Alt";
}

export function eventToBinding(e: KeyboardEvent): KeyBinding {
  return {
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key: e.key.toLowerCase(),
  };
}

export function matchBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
  const mod = e.metaKey || e.ctrlKey;
  return (
    binding.mod === mod &&
    binding.shift === e.shiftKey &&
    binding.alt === e.altKey &&
    binding.key === e.key.toLowerCase()
  );
}

export function matchAction(
  e: KeyboardEvent,
  bindings: Record<ActionId, KeyBinding>,
): ActionId | null {
  for (const [actionId, binding] of Object.entries(bindings)) {
    if (matchBinding(e, binding)) return actionId as ActionId;
  }
  return null;
}

export function resolveBindings(
  overrides: Partial<Record<ActionId, KeyBinding>> | null,
): Record<ActionId, KeyBinding> {
  if (!overrides) return DEFAULT_BINDINGS;
  return { ...DEFAULT_BINDINGS, ...overrides };
}

export function findConflict(
  binding: KeyBinding,
  bindings: Record<ActionId, KeyBinding>,
  excludeAction: ActionId,
): ActionId | null {
  for (const [actionId, b] of Object.entries(bindings)) {
    if (actionId !== excludeAction && bindingsEqual(b, binding)) {
      return actionId as ActionId;
    }
  }
  return null;
}

export function getActionLabel(id: ActionId): string {
  return ACTION_DEFINITIONS.find((a) => a.id === id)?.label ?? id;
}

// Key labels for display
const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "Enter",
  escape: "Esc",
  backspace: "⌫",
  delete: "Del",
  tab: "Tab",
  ",": ",",
  ".": ".",
  "/": "/",
  "=": "=",
  "-": "-",
  "[": "[",
  "]": "]",
  "\\": "\\",
  ";": ";",
  "'": "'",
  "`": "`",
};

export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(isMac ? "⇧" : "Shift");
  if (binding.alt) parts.push(isMac ? "⌥" : "Alt");
  const keyLabel = KEY_LABELS[binding.key] ?? binding.key.toUpperCase();
  parts.push(keyLabel);
  return isMac ? parts.join("") : parts.join("+");
}
