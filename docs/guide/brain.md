# Brain — persistent memory

The brain engine is what makes Pane different from pasting your codebase into a chat window. It accumulates context across sessions so the model doesn't start from scratch every time.

## How it works

Every session, the model reads your project and makes observations — architectural decisions, common patterns, past bugs and their fixes, file structure conventions. The brain engine extracts these into a persistent knowledge graph stored alongside your project.

When you open a new session three days later, the model doesn't ask "what were we working on?" It reads the brain and continues from where you left off.

## What gets stored

- **Decisions** — "we chose SQLite over Postgres because single-file deployment"
- **Patterns** — "all API routes follow the pattern `src/routes/[resource]/[action].ts`"
- **Lessons** — "the race condition in the queue worker was caused by missing transactions"
- **Error fixes** — "when the build fails on `TS2835`, add explicit `.js` extensions to imports"

## What doesn't

- Raw conversation transcripts
- API keys or credentials (these are never in the brain)
- Personal data unrelated to the project

## Manual control

You can add to the brain directly — preface a message with "remember:" and it'll be stored as a decision, lesson, pattern, or error fix. You can also browse and prune existing entries from the History panel.

The brain is the difference between an AI that feels like a tool and an AI that feels like it knows your codebase. That's the whole point.
