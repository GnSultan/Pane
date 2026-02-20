# Pane — One View. No Noise.

> A distraction-free, single-focus coding environment that wraps Claude Code in a clean, minimal UI. One pane. One focus. That's it.

## Philosophy

Every modern code editor forces a multi-panel paradigm: file tree + code editor + terminal + agent window — all fighting for attention in the same viewport. Pane rejects this. You see **one thing at a time** in the main workspace, with a quiet control strip on the side. You toggle. You focus. You build.

---

## Architecture Overview

```
┌─────────────┬──────────────────────────────────────────┐
│             │                                          │
│  Control    │         Main Workspace (~70%)            │
│  Panel      │                                          │
│  (~30%)     │    ┌──────────────────────────────┐      │
│             │    │                              │      │
│  ┌────────┐ │    │   MODE A: Claude Code        │      │
│  │ Files  │ │    │   (Full terminal emulator)   │      │
│  │ Tree   │ │    │                              │      │
│  │        │ │    │   MODE B: File Viewer         │      │
│  │        │ │    │   (Syntax-highlighted code)   │      │
│  ├────────┤ │    │                              │      │
│  │ Status │ │    │   Never both. You toggle.     │      │
│  │ Bar    │ │    │                              │      │
│  ├────────┤ │    └──────────────────────────────┘      │
│  │ Quick  │ │                                          │
│  │Actions │ │                                          │
│  └────────┘ │                                          │
│             │                                          │
└─────────────┴──────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Shell | **Tauri v2** | Native performance, tiny bundle (~5MB vs Electron's 150MB+), Rust backend |
| Frontend | **React + TypeScript** | Familiar, fast, component-driven |
| Styling | **Tailwind CSS** | Utility-first, no bloat, easy dark theme |
| Terminal | **xterm.js** | Battle-tested terminal emulator, used by VS Code |
| File Viewer | **CodeMirror 6** | Lightweight, extensible, better than Monaco for read-focused use |
| File Watching | **Tauri fs + watcher API** | Native file system access and change detection |

---

## Core Components

### 1. Control Panel (Left — ~30% width)

The quiet side. Never demands attention.

#### File Tree
- Shows project directory structure
- Click a file → switches main workspace to **File Viewer** mode with that file
- Minimal icons, no clutter
- Collapsible directories
- Shows file status indicators (modified, new, deleted) based on git

#### Status Strip
- Current mode indicator (Terminal / Viewer)
- Active file name (when in viewer mode)
- Project root path
- Git branch (if in a repo)

#### Quick Actions
- **Toggle mode** — keyboard shortcut `Cmd+/` or `Ctrl+/`
- **Open in terminal** — opens current file's directory in Claude Code
- **New chat** — resets Claude Code session

### 2. Main Workspace (Right — ~70% width)

One view at a time. Two modes:

#### Mode A: Claude Code Terminal
- Full xterm.js terminal emulator
- Spawns `claude` CLI process directly (not wrapped — raw PTY)
- Supports all Claude Code features: tool use, file editing, bash execution
- Respects Claude Code's own theming/colors
- Auto-focuses on switch

#### Mode B: File Viewer
- CodeMirror 6 in **read-only mode** by default
- Syntax highlighting for all common languages
- Line numbers
- Clean, distraction-free view
- Optional: toggle to edit mode with `Cmd+E` (lightweight edits, not a full IDE)
- File watching: auto-refreshes when Claude Code modifies the file

### 3. Toggle System

The heart of the UX. Switching between modes should feel instant.

- **Keyboard**: `Cmd+/` or `Ctrl+/` toggles between Terminal ↔ Viewer
- **File click**: Clicking any file in the tree switches to Viewer with that file
- **Transition**: No animation. Instant swap. The previous mode's state is preserved in memory
- Terminal stays alive in background when viewing files
- File viewer remembers scroll position and last-viewed file

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + /` | Toggle Terminal ↔ File Viewer |
| `Cmd/Ctrl + E` | Toggle edit mode in File Viewer |
| `Cmd/Ctrl + P` | Quick file open (fuzzy finder) |
| `Cmd/Ctrl + B` | Toggle Control Panel visibility (full-screen workspace) |
| `Cmd/Ctrl + K` | Focus Claude Code terminal |
| `Cmd/Ctrl + 1-9` | Jump to nth file in tree |
| `Esc` | Return focus to terminal from viewer |

---

## Visual Design

### Theme: Dark Minimal
- Background: `#0D0D0D` (near-black, not pure black)
- Panel background: `#141414`
- Border/divider: `#1E1E1E` (subtle, almost invisible)
- Text primary: `#E0E0E0`
- Text secondary: `#6B6B6B`
- Accent: `#3B82F6` (blue — for active states, toggle indicator)
- No gradients. No shadows. No rounded corners on panels.
- Monospace font: `JetBrains Mono` or `Fira Code`
- UI font: `Inter`

### Design Principles
- **Density over decoration** — maximize content, minimize chrome
- **Single visual hierarchy** — the main workspace dominates, control panel whispers
- **No borders that shout** — 1px subtle dividers only
- **State through color, not shape** — active file is highlighted with accent, not boxed

---

## Project Structure

```
pane-app/
├── src-tauri/           # Rust backend
│   ├── src/
│   │   ├── main.rs      # App entry, window config
│   │   ├── terminal.rs  # PTY management, Claude Code spawning
│   │   ├── fs.rs        # File system operations & watching
│   │   └── commands.rs  # Tauri IPC commands
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                 # React frontend
│   ├── App.tsx          # Root — layout manager
│   ├── components/
│   │   ├── ControlPanel/
│   │   │   ├── FileTree.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   └── QuickActions.tsx
│   │   ├── Workspace/
│   │   │   ├── Terminal.tsx      # xterm.js wrapper
│   │   │   ├── FileViewer.tsx    # CodeMirror wrapper
│   │   │   └── WorkspaceToggle.tsx
│   │   └── shared/
│   │       └── FuzzyFinder.tsx   # Cmd+P file search
│   ├── hooks/
│   │   ├── useTerminal.ts       # Terminal lifecycle
│   │   ├── useFileWatcher.ts    # FS change detection
│   │   └── useWorkspaceMode.ts  # Toggle state management
│   ├── stores/
│   │   └── workspace.ts         # Zustand store for app state
│   ├── styles/
│   │   └── globals.css          # Tailwind + custom theme tokens
│   └── lib/
│       ├── terminal-bridge.ts   # Tauri ↔ xterm.js communication
│       └── file-utils.ts        # File reading, language detection
├── package.json
├── tailwind.config.ts
└── README.md
```

---

## Implementation Order

### Phase 1 — Shell (Get it running)
1. Initialize Tauri v2 + React + TypeScript project
2. Set up the two-panel layout (30/70 split)
3. Embed xterm.js and spawn a basic shell (bash/zsh)
4. Verify Claude Code runs inside the terminal

### Phase 2 — File System
5. Build file tree component with directory reading via Tauri
6. Implement file viewer with CodeMirror 6
7. Wire up: click file → switch to viewer mode
8. Add toggle shortcut (Cmd+/)

### Phase 3 — Polish
9. File watching (auto-refresh when files change)
10. Fuzzy file finder (Cmd+P)
11. Git status indicators in file tree
12. Theme refinement and typography
13. Window state persistence (remember size, last project, etc.)

### Phase 4 — Personal Touches
14. Session memory integration (Punk Records hooks)
15. Project switcher in control panel
16. Custom status messages / session context

---

## Tauri Backend Notes

### Terminal/PTY Setup
Tauri needs to spawn Claude Code as a PTY (pseudo-terminal) process so it gets proper terminal behavior (colors, cursor movement, interactive input). Use the `portable-pty` Rust crate for cross-platform PTY support.

```rust
// Pseudocode for PTY spawning
let pty = PtyPair::new()?;
let child = pty.slave.spawn_command(CommandBuilder::new("claude"))?;
// Stream pty.master read/write to frontend via Tauri events
```

### IPC Commands Needed
- `spawn_terminal(cwd: String)` — Start Claude Code PTY in a directory
- `write_terminal(data: String)` — Send keystrokes to PTY
- `read_directory(path: String)` — List directory contents
- `read_file(path: String)` — Read file content
- `watch_directory(path: String)` — Start file watcher, emit events on change
- `get_git_status(path: String)` — Get git branch + file statuses

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tauri over Electron | ✅ | 30x smaller, faster, Rust backend for PTY |
| CodeMirror over Monaco | ✅ | Lighter, we're viewing not editing IDE-level |
| No tabs | ✅ | One file at a time. Use fuzzy finder or tree to switch |
| No split views | ✅ | The whole point. One focus area. |
| Zustand over Redux | ✅ | Minimal state, minimal boilerplate |
| Dark only (for now) | ✅ | Ship fast, add light theme later if wanted |

---

## Name

**Pane** — one pane. One view. The name is the product. No explanation needed.

---

*Built by Aslam. Designed for focus.*
