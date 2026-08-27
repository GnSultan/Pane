# Getting started

## Prerequisites

- **macOS** (Apple Silicon arm64). An x64 build exists but is less tested.
- **Node.js 20+** and **npm** (for development builds only — not needed if you download the DMG)
- An **API key** from at least one supported provider

## Install

### Download (recommended)

Download the latest `.dmg` from [GitHub Releases](https://github.com/GnSultan/Pane/releases).

Open the DMG, drag Pane to Applications, and open it. macOS will warn you about an unidentified developer — right-click → Open to bypass.

### Build from source

```bash
git clone https://github.com/GnSultan/Pane.git
cd pane/pane-app
npm ci
npm run download-models
npm run dev
```

The dev script handles native binary re-signing for Apple Silicon automatically.

## Configure API keys

After launching, press `Cmd+,` to open **Profile** → **API Keys**. Add a key for at least one provider:

| Provider | Key prefix | Get one at |
|---|---|---|
| **Anthropic** (Claude) | `sk-ant-...` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **Google Gemini** | `AI...` | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **OpenRouter** | `sk-or-...` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **DeepSeek** | `sk-...` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |

Keys are stored in `~/.pane/settings.json`. They never leave your machine.

## Open a project

When you first open Pane, you'll see an empty thread panel. Click **New thread**, give it a name, and optionally bind it to a project directory. If you skip the directory, the thread works in memory only — useful for conversations that don't need file access.

If you do bind a directory, Pane will index its files for the file tree, fuzzy finder, and code search.

## Your first message

Press `Cmd+/` to focus the chat input. Type your message and hit Enter.

Try something like:

> What does this project do? Read the README and give me a summary.

Or if you're in a codebase:

> Find all the places where authentication logic lives and explain how they connect.

The model reads your files, reasons about them, and responds. When it proposes changes, you'll see diffs. You can accept, reject, or ask it to revise.
