# Pane

**An AI-native development environment for macOS.** Open a project, talk to a model. It reads your codebase, edits files, runs commands, and commits changes. You review, correct, and guide.

Every line of Pane was written by AI agents running inside Pane — including this file.

→ **[Read the docs](https://gnsultan.github.io/Pane)**

---

## What it is

The model is the active writer. You steer. Send a message — "fix this bug," "add a route," "what does this function do?" — and the model reads your project, plans, writes code, runs tests, and shows you diffs. You accept, correct, or iterate.

The file editor, terminal, and git UI exist because even when an AI drives, you need to see what's happening and make the occasional manual adjustment. They're secondary — supervision tools, not the primary workspace.

Each thread is tied to a real project directory. Context accumulates across sessions — not resets every time you open it.

---

## Features

| Mode | What it is | Key |
|---|---|---|
| **Conversation** | Chat with the model. Primary mode. | `Cmd+/` |
| **Files** | File tree + Ace editor (35+ languages). Manual edits. | `Cmd+/` |
| **Terminal** | Multi-tab PTY. Shared with the model. | `Cmd+/` |
| **Git** | Staged diffs, commit history, branch switch. | — |
| **Mind** | Freeform thought dump. Type what's on your mind. Mark done. Move on. | `Cmd+M` |
| **Lens** | Automated code review. Punks scan and flag issues. | — |
| **History** | Change log. Every AI edit is recorded. Revert any change. | — |
| **Search** | Fuzzy finder for files. | `Cmd+P` |
| **File Search** | Full-text search across the project. | `Cmd+Shift+P` |
| **Profile** | Settings, API keys, model config, themes, keybindings. | — |

(`Cmd+/` cycles between conversation, file viewer, and terminal — the three you use most.)

### Persistent memory

The brain engine stores decisions, patterns, and architecture choices. Open a thread three days later — the model knows where you left off. No "what were we working on?" No re-pasting context.

### Multi-model, bring your own keys

Claude, Gemini, GPT, DeepSeek — via OpenRouter or direct API. Each thread selects its model. Optional power combo: a thinking model plans and verifies, an execution model builds.

### Pane Cloud

Sign in with GitHub. Backups, sync, and cloud features handled by Pane Cloud — a centralized service. No infrastructure to self-host.

---

## Prerequisites

- **macOS** (Apple Silicon arm64). A reasonable x64 build exists.
- **Node.js 20+** and **npm** (for development builds)
- An API key from at least one supported provider (Anthropic, OpenRouter, Google, OpenAI, DeepSeek)

---

## Quick start

### Download (recommended)

Download the latest `.dmg` from [Releases](https://github.com/gnsultan/pane/releases).

### Build from source

```bash
git clone https://github.com/gnsultan/pane.git
cd pane/pane-app
npm ci
npm run download-models
npm run dev
```

The dev script handles native binary re-signing for Apple Silicon automatically.

### Configure

After launching, open the **Profile** mode to add API keys for your preferred model provider. Keys are stored in `~/.pane/settings.json`.

---

## Architecture

Pane is an Electron app organized as a monorepo:

- **`pane-app/`** — The desktop application (Electron 40, React 18, Tailwind v4, Zustand 5)
  - `src/main/` — Electron main process: HTTP backend, LLM routing, brain engine, model manager, tool execution, git operations, code arbiter, backup/cloud sync
  - `src/renderer/` — React UI: workspace panels, file viewer, terminal, stores, keybindings
  - `src/preload/` — Secure context bridge between main and renderer
- **`pane-cloud/`** — Cloudflare Worker backend for Pane Cloud (sync, auth, backups)

Key subsystems:

| Component | Role |
|---|---|
| **brain-engine** | Persistent knowledge graph — decisions, patterns, architecture learned across sessions |
| **punk-engine** | Automated code review — punks scan codebase for issues |
| **http-backend** | LLM provider routing, streaming, tool execution |
| **code-arbiter** | Quality gates — validates model output against project conventions |
| **model-manager** | Model registry, context window tracking, provider switching |
| **backup-engine** | Local + cloud backup with encryption |
| **symbol-index** | Project-wide symbol indexing for code navigation |

---

## Built with itself

Pane is built entirely with Pane. Every line of code was written by an AI agent running inside Pane. Not a single line was manually typed. This has been true since the first commit.

The proof is the app itself. It's not a claim about the future — it's evidence that the approach works.

---

## Stack

Electron 40 · React 18 · Tailwind v4 · Zustand 5 · node-pty · Ace editor · better-sqlite3 · Framer Motion · fuse.js · @anthropic-ai/claude-agent-sdk · @vscode/ripgrep · ONNX runtime · Cloudflare Workers · D1 · R2

---

## Status

**Active development.** v0.5.19. Early enough that things change. Surfaces vary in polish. The architecture is solid; the UX is catching up.

---

## Who this is for

- Developers who direct more than they type
- People managing multiple projects who want persistent context
- Anyone tired of pasting project context into every new chat
- People curious what happens when an AI-native tool eats its own dogfood

---

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Aslam Abdul](https://aslamabdul.com).
