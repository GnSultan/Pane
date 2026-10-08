---
name: writing
description: Clear prose — documentation, comments, naming, and commit messages. Write for the reader, not the writer.
version: 1.0.0
tags: [writing, documentation, comments, naming, prose]
extends: []
conflicts: []
requires: []
provides: [writing, documentation, prose, comments, naming]
priority: 5
---

# Writing

## When to use this skill
Activate when:
- Writing or reviewing documentation (README, API docs, architecture decisions)
- Writing comments in code
- Naming things — variables, functions, types, files
- Writing commit messages, PR descriptions, or changelogs
- The user asks about writing style, clarity, or communication

## First principle: writing is thinking made visible

Bad writing isn't a style problem — it's a thinking problem. If you can't explain it clearly, you don't understand it clearly. Every unclear sentence is a signal that the concept underneath is fuzzy. Fix the concept first, then the sentence writes itself.

## Documentation

### What to document, not how
Documentation should explain what a thing IS, what it DOES, and WHY it exists — not how it's implemented. The code already says how.

Good docs:
- "Auth middleware validates JWT tokens and attaches user context to the request. Fails with 401 if the token is expired, 403 if the user lacks the required role."
- "The compaction worker runs in a separate thread to prevent main-thread blocking. It uses a 3-phase approach: summarization, iterative turn dropping, and truncation."

Bad docs:
- "This function takes a token and returns a user." (says nothing the signature doesn't)
- "Helper function for auth." (vague, unhelpful)

### README structure
Every project README needs, in order:
1. **What it is** — one sentence. "Pane is a coding agent that persists context across sessions."
2. **Why it exists** — the problem. "Coding with AI today is a pain that never ends..."
3. **Quick start** — copy-paste to working. 3 commands max.
4. **How it works** — architecture overview, diagram if useful.
5. **Contributing / development** — how to set up locally.

Everything else (API reference, changelog, detailed config) goes in separate docs linked from the README. A README that scrolls for pages is a README nobody reads.

### Architecture decisions (ADRs)
Structure: **Context → Decision → Consequences → Alternatives considered**

A good ADR makes clear: what problem we faced, what we chose, what tradeoffs we accepted, and what we explicitly rejected. The "alternatives considered" section is the most valuable — it prevents future developers from re-litigating the same decision.

## Comments

### Comments explain WHY, not WHAT
The code already says what it does. Comments are for intent, context, and warnings — things the code cannot express.

Good comments:
```typescript
// We use a Map instead of an object because keys are Symbol-based
// and we need O(1) deletion during cleanup without rebuilding.
const handlers = new Map<symbol, Handler>();

// Timeout is 60s — Cloudflare's free tier kills workers at 50ms CPU,
// but paid tier allows up to 30s wall clock. We pad for safety.
const WORKER_TIMEOUT = 60_000;

// NOTE: This mutates the input array. Callers must clone if they
// need the original. Considered returning a new array but the
// allocation cost in the hot path was prohibitive.
function sortInPlace(items: Item[]): void {
```

Bad comments:
```typescript
// Loop through items
for (const item of items) {  // useless — the code says this

// This is the sort function
function sort(items: Item[]): Item[] {  // useless — the name says this
```

### When NOT to comment
- **Don't comment obvious code.** `// increment i` before `i++` is noise.
- **Don't use comments as a crutch for bad names.** If you need `// validates the token` above `function check(t: string)`, rename the function to `validateToken`.
- **Don't leave commented-out code.** Delete it. Git remembers. Dead code rots and confuses.
- **Don't write novels.** A comment should be read in under 5 seconds. If it needs more, write a doc instead.

### TODO comments
Format: `// TODO(username): what needs doing — why not now`

A TODO without a name and a reason is just litter. The username makes it accountable. The "why not now" prevents future developers from assuming it was forgotten.

```typescript
// TODO(aslam): replace with streaming parser once the v2 protocol
// is stable — currently blocked on handshake negotiation spec.
```

## Naming

### The read-aloud test
If you wouldn't say it out loud in a sentence, don't use it as a name. Names are for humans first, machines second.

Good names:
- `getUserById` → "get user by ID" (natural English)
- `compactConversation` → "compact the conversation" (natural English)
- `isTokenExpired` → "is token expired" (reads as a question)

Bad names:
- `getUsr` → abbreviations are cognitive friction
- `process` → process WHAT?
- `data` → meaningless; all variables hold data

### Specificity beats brevity
Longer, precise names are better than shorter, vague ones.

- `fetchUserPermissions` > `getPerms`
- `activeSessionTimeoutMs` > `timeout`
- `unrecoverableParseError` > `err`

The exception: very short-lived locals in tight scopes can be short. `i` in a 3-line loop is fine. `e` in a catch block is fine. `ctx` as a single-use parameter is fine. But `p` for "permissions" in a 50-line function is not.

### Consistency within a domain
Once you name a concept, stick with it everywhere. If it's `tenant` in one file, it's not `account` in another. If it's `compact` in one function, it's not `compress` in another. Synonyms create false distinctions that readers waste time trying to understand.

## Commit messages

Atomic commits with conventional format: `type(scope): behavior-focused outcome`

The subject line is the WHAT (what happens when this commit is applied). The body (if needed) is the WHY (why this approach, what alternatives were considered, what tradeoffs).

Good:
```
fix(compaction): prevent main thread blocking with worker-thread offload

Compaction was calling JSON.stringify on the full conversation,
blocking the main thread for 2-4s on large histories. Moved to a
worker thread with a 60s timeout. Added inline fast-path for
conversations under 200 messages that skips the worker.

Alternatives considered:
- Chunked processing: more complex, harder to reason about
- Web Worker in renderer: adds serialization overhead crossing
  the process boundary
```

Bad:
```
fix compaction bug
```

## Prose style

### Concrete over abstract
"Reduces build time by 40%" not "significantly improves performance"
"Handles 10,000 concurrent connections" not "scales to enterprise needs"
"Throws `AuthError` with code `EXPIRED`" not "fails gracefully"

### Active voice
"The parser rejects invalid input" not "Invalid input is rejected by the parser"

### No jargon without definition
If you use a domain term (Durable Object, CRDT, vector embedding), define it on first use or link to a definition. Never assume the reader knows your jargon.

### Show, don't tell
Instead of "the API is simple":
```
curl -X POST https://api.example.com/chat \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message": "hello"}'
```
The reader can judge simplicity for themselves.

## Anti-patterns

- **Documenting implementation instead of interface.** "Uses a red-black tree internally" — the user doesn't care. Tell them what it DOES.
- **Comments that restate code.** `// returns true if valid` above `return isValid()`. Delete.
- **Vague names with clarifying comments.** `process(x) // validates and transforms the input`. Rename to `validateAndTransform`.
- **Outdated docs.** Worse than no docs. If you change behavior, update the docs in the same commit.
- **Passive voice to dodge responsibility.** "Mistakes were made" → own it: "I made a mistake." "The decision was reached" → "We decided."
- **Hedging words.** "Basically", "kind of", "sort of", "just", "simply" — these undermine confidence. If it's simple, show it. Don't claim it.
