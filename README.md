# Pane

The lightest IDE ever built for Claude.

Multiple threads. Multiple Claude sessions. One window. Ask for something, see it get done.

No feature bloat. No panels you'll never open. No configuration rituals. Just a conversation, a file editor, and a terminal — everything an agentic coding session needs, nothing it doesn't.

---

### What Pane does differently

**Threads, not workspaces.** Every other IDE treats a window as a project. Pane treats a window as a collection of ongoing conversations. Each thread is a Claude session with its own history, context, and terminal state — you're not opening a project, you're picking up where you left off. Switch threads with Cmd+1/2/3. No new windows. No lost context.

**Built for agentic coding.** Pane isn't a code editor with AI bolted on. It's a Claude session with a code editor built in. The conversation is the primary interface. The editor and terminal exist to support it.

**Radically minimal.** Three modes: conversation, editor, terminal. Toggle with a keystroke. No sidebars you'll never use, no settings pages with 200 options, no marketplace of extensions. If you have to configure it, we failed.

**Fast by architecture, not by spec.** Zero React re-renders on thread switch. DOM-level visibility toggling. Viewport-only message painting. 120Hz native on ProMotion displays. Pane doesn't feel fast because of the hardware — it feels fast because of the decisions.

---

### Who this is for

People who build with Claude, not around it. Vibe coders. Agentic-first developers. People who don't want an IDE — they want a result.

If you've ever opened Cursor and thought "I just want to talk to Claude and see what happens" — this is that, and only that, done as well as it can be done.

---

### Stack

Electron 40 / React 19 / Tailwind v4 / Zustand v5 / node-pty

macOS only. For now.

---

### Features

**Syntax Highlighting**: Code blocks display with proper syntax highlighting for JavaScript, TypeScript, Python, HTML, CSS, JSON, and more. Uses Pane's native design language with subtle surface backgrounds that blend seamlessly with the interface — no harsh black backgrounds that violate the minimal aesthetic.

**Context Window Management**: Automatic conversation compaction prevents hitting file size limits while preserving critical context and decision markers.

**Model-Specific Context Limits**: Accurate context windows for all supported models (Gemini: 1M-2M tokens, Claude: 200K tokens, DeepSeek: 128K tokens, etc.).

---

### Shortcuts

| Key | Action |
|-----|--------|
| `Cmd+/` | Toggle conversation / editor |
| `Cmd+1-9` | Switch threads |
| `Cmd+B` | Toggle sidebar |
| `Cmd+P` | Open file |
| `Cmd+K` | Focus chat |
| `Cmd+Shift+F` | Search in files |

---

Built by [Aslam](https://aslamabdul.com).
