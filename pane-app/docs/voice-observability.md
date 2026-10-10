# Voice Observability — Agent Threads

How the voice layer queries live per-thread agent status.

## The problem this solves

Before this existed, voice reconstructed agent state from partial signals:
the injected `[workspace]` line (thread count + running names), the
`isProcessing` flag, and the last assistant message. That told voice *that*
something was running, but not *what phase* it was in, whether it was
editing files or just reading, or which model was doing the work. The
underlying `intents.ndjson` activities store prompt excerpts (200 chars)
— unsuitable for a voice-read surface — and is a log, not a state store:
reading it means guessing current state from appended records.

## The store

`src/main/agent-status.mjs` — an in-memory, per-thread status store in the
main process. **Single source of truth**: writes happen at the exact
phase-transition points inside the executor, so a read returns current
state plus a bounded event ring, never a reconstruction.

In-memory by design. This is live monitoring state, not history —
persisting would recreate the stale-reconstruction problem. Stale threads
(no event for 30 min, matching the intents TTL) are marked `stale` and
excluded from active counts but still listed.

### Phase vocabulary

| Phase | Meaning | Written when |
|---|---|---|
| `planning` | Read-only exploration / thinking | Turn start; every read-only tool call |
| `editing` | Write tools in play | Any write-classified tool call |
| `waiting` | Agent called `ask_user`, paused for the user | `http-backend` ask_user site |
| `done` | Run finished cleanly | Turn loop success exit |
| `error` | Run aborted | Non-recoverable catch path |
| `idle` | No run in flight | (reserved; initial state) |

Terminal phases (`done`/`error`/`idle`/`waiting`) clear `currentTool` —
"done" with a stale tool marker would read as still mid-action.

### Agent identity

`agent` is `model@provider` (e.g. `gpt-5.6-sol@openai`, `glm-5.3@z-ai`),
written at turn start from the resolved request. It persists across phase
changes within a run. This distinguishes which engine is on which thread —
the "Pane vs pane-alpha" question maps to whatever model/provider each
thread's run resolved to.

### Event ring

Every `setPhase` appends `{ts, phase, tool?, file?}` to a per-thread ring
capped at 20 (playbook: cap every buffer). Timestamps are monotonic —
two transitions in the same millisecond still order deterministically.

## Query paths

### Voice (the primary consumer)

The `agent_threads` tool — defined in `VOICE_TOOLS`, routed in
`VoiceRelay.runTool` before the whitelist (same pattern as
`workspace_state`). Call it and you get:

```json
{
  "total": 6,
  "activeThreads": 2,
  "threads": [
    {
      "threadId": "88e8331a-…",
      "threadName": "",
      "phase": "editing",
      "readOnly": false,
      "currentTool": "replace",
      "lastFile": "Profile.tsx",
      "turnCount": 0,
      "agent": "gpt-5.6-sol@openai",
      "updatedAt": 1725166800000,
      "updatedAtAgoSec": 4,
      "stale": false,
      "events": [{ "ts": 1725166800000, "phase": "editing", "tool": "replace", "file": "Profile.tsx" }]
    }
  ],
  "note": "phases: planning=exploring read-only, editing=writing files, waiting=paused for user, done/error=finished"
}
```

Optional `thread` arg filters by thread name/id substring. Bounded to the
12 most recently active threads.

When to prefer it over `workspace_state`: "what is the agent doing right
now", "is it safe to interrupt", "which model is running where".
`workspace_state` remains better for thread counts, message history
counts, and peer grouping by root.

### Renderer / future UI

IPC channel `agent_status_snapshot` (`{ limit? }`) returns the full
snapshot — same shape, unprojected. The voice relay does **not** go
through this channel; it queries the store in-process.

## Security model

1. **Fixed schema.** `setPhase` accepts only known fields. There is no
   free-form detail field, so user prompts, file contents, and command
   output cannot enter the store. (Contrast: `intents.mjs` deliberately
   stores prompt excerpts for peer awareness — that stays internal.)
2. **Whitelist projection.** `voiceSnapshot()` picks each record through
   `VOICE_SAFE_FIELDS`. A field added to the store later is invisible to
   voice until explicitly whitelisted — the structural guarantee.
3. **Basenames only.** File references are stored as the last path
   segment: enough for "editing Profile.tsx", never directory structure.
4. **No secrets.** No tokens or API keys pass through this module.

## Emission points

| Site | File | Emits |
|---|---|---|
| Turn start | `http-backend.mjs` (after `turn_start` activity) | `planning` + agent identity + readOnly from request phase |
| Tool call | `tool-executor.mjs` executeTool | `editing` (write tools) / `planning` (reads), with tool + file |
| `ask_user` | `http-backend.mjs` | `waiting` |
| Clean exit | `http-backend.mjs` success block | `done` (or `waiting` if paused for user) |
| Fatal error | `http-backend.mjs` non-recoverable catch | `error` |

`tool-executor` keeps `STATUS_WRITE_TOOLS`, a mirror of http-backend's
`WRITE_TOOL_NAMES` — dual-copy rule: change both together.

## Tests

`src/main/__tests__/agent-status.test.mjs` — 21 tests covering: unknown
phase rejection, extra-field dropping (secrets can't enter), basename
redaction, voice projection (future fields invisible), agent identity
persistence, full phase lifecycle, ring cap, terminal-phase tool clearing,
staleness, active-thread counting, monotonic ordering.
