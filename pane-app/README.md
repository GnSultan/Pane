
# Pane

**v0.4.168** · macOS (arm64)

An agentic workspace for software. You talk to a model. It reads your codebase, edits files, runs commands, and commits changes. You review, correct, and guide.

Each thread is tied to a real project directory. Context accumulates across sessions — not resets every time you open it.

---

## What it is

The model is the active writer. You steer. You send a message — "fix this bug," "add a route," "what does this function do?" — and the model reads your project, plans, writes code, runs tests, and shows you diffs. You accept, correct, or iterate.

The file editor, terminal, and git UI exist because even when an AI drives, you need to see what's happening and make the occasional manual adjustment. They're secondary — supervision tools, not the primary workspace.

---

## How it works

### Start a thread

Open Pane. You see a picker. Type `~/my-project` or browse to a directory. The project appears in your thread list.

### Talk to a model

Type what you want. The model has access to your entire project — file system, shell, git. It reads, plans, writes, runs, iterates. You see every tool call and every file change in real time.

### Switch modes with keystrokes

10 views into the same project state, all toggled with keyboard shortcuts:

| Mode | What it is | Key |
|---|---|---|
| **Conversation** | Chat with the model. Primary mode. | `Cmd+/` |
| **Files** | File tree + Ace editor (35+ languages). Manual edits. | `Cmd+/` |
| **Terminal** | Multi-tab PTY. Shared with the model. | `Cmd+/` |
| **Git** | Staged diffs, commit history, branch switch. | — |
| **Mind** | A freeform thought dump. Type what's on your mind. Mark done. Move on. | `Cmd+M` |
| **Lens** | Automated code review. Punks scan and flag issues. | — |
| **History** | Change log. Every AI edit is recorded. Revert any change. | — |
| **Search** | Cmd+P fuzzy finder for files. | `Cmd+P` |
| **File Search** | Full-text search across the project. | `Cmd+Shift+P` |
| **Profile** | Settings, API keys, model config, themes, keybindings. | — |

(`Cmd+/` cycles between conversation, file viewer, and terminal — the three you use most.)

### Memory is persistent, not per-session

The brain engine stores decisions, patterns, and architecture choices. Open a thread three days later — the model knows where you left off. No "what were we working on?" No re-pasting context.

### Multi-model, bring your own keys

Claude, Gemini, GPT, DeepSeek. Each thread selects its model. Optional power combo: a thinking model plans and verifies, an execution model builds. Bring your own API keys.

---

## The thing itself

Pane is built entirely with Pane. Every line of code was written by an AI agent running inside Pane. Not a single line was manually typed. The app you're reading about wrote its own source code.

This has been true since the first commit.

---

## Stack

Electron 40 · React 18 · Tailwind v4 · Zustand 5 · node-pty · Ace editor · better-sqlite3 · Framer Motion · fuse.js · @anthropic-ai/claude-agent-sdk · @vscode/ripgrep · ONNX runtime

---

## Status

Active development. v0.4.168. Early enough that things change. Surfaces vary in polish. The architecture is solid; the UX is catching up. That's what happens when your app rewrites itself.

macOS only, arm64 (Apple Silicon). A reasonable x64 build exists.

---

## Who this is for

- Developers who direct more than they type
- People managing multiple projects who want persistent context
- Anyone tired of pasting project context into every new chat
- People curious what happens when an AI-native tool eats its own dogfood

---

Built by [Aslam Abdul](https://aslamabdul.com). Entirely by vibecoding.
