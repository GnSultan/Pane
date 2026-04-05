// @ Command Registry — the single source of truth for all @-prefixed commands.
// Parser and picker both read from this. Add new commands here only.

export type AtCommandType = "reference" | "mode" | "action";
export type ModeValue = "plan" | "discuss" | "analyze" | "execute";

interface AtCommandBase {
  name: string;
  aliases?: string[];
  description: string;
  type: AtCommandType;
}

export interface AtReferenceCommand extends AtCommandBase {
  type: "reference";
}

export interface AtModeCommand extends AtCommandBase {
  type: "mode";
  mode: ModeValue;
  serverDirective: string; // prepended to prompt on send
  color: string;           // CSS variable for badge color
  placeholder: string;     // textarea placeholder while mode is active
}

export interface AtSubcommand {
  name: string;
  description: string;
}

export interface AtActionCommand extends AtCommandBase {
  type: "action";
  subcommands?: AtSubcommand[];
}

export type AtCommand = AtReferenceCommand | AtModeCommand | AtActionCommand;

export const AT_COMMANDS: AtCommand[] = [
  // ── References ─────────────────────────────────────────────────────────
  {
    name: "thought",
    type: "reference",
    description: "attach a mind entry as context",
  },

  // ── Mode commands ───────────────────────────────────────────────────────
  // Modes are sticky — once activated, every message gets the directive
  // prepended until the user dismisses the mode badge.
  {
    name: "plan",
    type: "mode",
    mode: "plan",
    serverDirective: "/analyze ",
    color: "var(--pane-status-modified)",
    placeholder: "planning out loud...",
    description: "think and plan — no execution",
  },
  {
    name: "discuss",
    type: "mode",
    mode: "discuss",
    serverDirective: "/discuss ",
    color: "var(--pane-terminal)",
    placeholder: "let's talk this through...",
    description: "conversation only — no code changes",
  },
  {
    name: "analyze",
    aliases: ["investigate", "audit"],
    type: "mode",
    mode: "analyze",
    serverDirective: "/analyze ",
    color: "var(--pane-accent)",
    placeholder: "investigating...",
    description: "deep codebase investigation — read only",
  },
  {
    name: "execute",
    aliases: ["exec", "do"],
    type: "mode",
    mode: "execute",
    serverDirective: "/exec ",
    color: "var(--pane-status-added)",
    placeholder: "executing...",
    description: "direct execution — full tool access",
  },
  {
    name: "brainstorm",
    aliases: ["brain"],
    type: "mode",
    mode: "discuss",
    serverDirective: "/discuss ",
    color: "var(--pane-terminal)",
    placeholder: "brainstorming...",
    description: "open-ended thinking without execution",
  },

  // ── Action commands ─────────────────────────────────────────────────────
  {
    name: "todo",
    type: "action",
    description: "manage todo list",
    subcommands: [
      { name: "clear", description: "clear all todos" },
      { name: "show",  description: "open todo panel"  },
    ],
  },
  {
    name: "session",
    type: "action",
    description: "manage session state",
    subcommands: [
      { name: "clear", description: "wipe conversation and session context" },
    ],
  },
];

/** Returns commands whose name (or any alias) starts with the typed query. */
export function matchCommands(query: string): AtCommand[] {
  const q = query.toLowerCase();
  if (!q) return AT_COMMANDS;
  return AT_COMMANDS.filter(
    (cmd) =>
      cmd.name.startsWith(q) ||
      cmd.aliases?.some((a) => a.startsWith(q)),
  );
}
