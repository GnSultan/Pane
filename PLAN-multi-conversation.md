# Multi-Conversation per Project — Full Implementation Plan

Created: 2025-07-16  
Status: Planned (not started)  
Estimated: 3-4 sessions, ~1,090 lines across ~16 files

---

## Why

One project = one conversation today. But think/build split needs two conversations per project without cross-polluting memory. A longer-term direction is arbitrary conversation count per project.

## Core Change

```diff
- Project.conversation: ConversationState         // single conversation
+ Project.conversations: Map<string, Conversation> // multiple conversations
+ Project.activeConversationId: string | null
+ Project.conversationOrder: string[]
```

Where `Conversation` wraps `ConversationState` with metadata (label, phase, timestamps, archive flag).

---

## Phase 0: Schema Migration (v6)

SQL changes in `pane-db.mjs`:

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '',
  phase           TEXT NOT NULL DEFAULT 'idle',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  is_archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at);

ALTER TABLE messages ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
```

Migration steps (v5 → v6):
1. Create `conversations` table
2. `ALTER TABLE messages ADD COLUMN conversation_id TEXT` (idempotent via try/catch)
3. For each project with messages: generate UUID, insert conversation row, backfill `conversation_id`
4. Set version = 6

## Phase 1: Database Layer (`pane-db.mjs`)

New prepared statements:
- `insertConversation`
- `getConversation`
- `getProjectConversations` (non-archived, ordered by updated_at DESC)
- `updateConversation` (label, phase, updated_at)
- `archiveConversation`
- `countMessagesForConv`
- `selectMessagesSliceForConv`

Updated: `insertMessage` now takes optional `conversation_id` (13th param)

## Phase 2: Type Layer (`punk-types.ts`)

```ts
export interface Conversation {
  id: string;
  label: string;
  phase: PanePhase;
  state: ConversationState;
  createdAt: number;
  updatedAt: number;
  isArchived: boolean;
}
```

Helper:
```ts
function getActiveConv(project: Project): ConversationState {
  const conv = project.conversations.get(project.activeConversationId ?? "");
  return conv?.state ?? createEmptyConversation();
}
```

## Phase 3: Store Layer (`projects.ts`)

New actions:
- `addConversation(projectId, label?, phase?): string`
- `removeConversation(projectId, conversationId)`
- `archiveConversation(projectId, conversationId)`
- `setActiveConversation(projectId, conversationId)`
- `renameConversation(projectId, conversationId, label)`

All ~80 existing mutators refactored to use `getActiveConv()` and operate on `conversations.get(cid).state` instead of `conversation` directly. Dual-write during transition, then remove deprecated field.

`createProject()` auto-creates a default "main" conversation.

## Phase 4: IPC Layer (`main.mjs`)

Updated handlers:
- `save_conversation`: accepts `conversationId`, writes messages with that ID
- `get_conversation_slice`: accepts `conversationId`, queries scoped

New handlers:
- `get_project_conversations`
- `create_conversation`
- `archive_conversation`
- `rename_conversation`

## Phase 5: Renderer IPC (`tauri-commands.ts`)

Updated: `saveConversationToMain`, `getConversationSlice` — add `conversationId` param  
New: `getProjectConversations`, `createConversation`, `archiveConversation`, `renameConversation`

## Phase 6: Persistence Hook (`useSettingsPersistence.ts`)

Save subscriber iterates ALL conversations per project.  
Load/restore all conversations for each project from DB.  
Project state persists `activeConversationId`, `conversationOrder`, `conversationLabels`.

## Phase 7: UI Layer

### Tab Bar in ConversationLayer
```
┌─────────────────────────────────────────────┐
│ [think] [build] [main]        [+ new]       │
├─────────────────────────────────────────────┤
│  (Conversation for active tab)              │
└─────────────────────────────────────────────┘
```

- `ConversationTabBar`: renders tabs for each non-archived conversation highlight active, color by phase
- `ConversationTabPanel`: lazy-mounts its Conversation, inactive panels use `contentVisibility: hidden`
- `+` button: creates new conversation with label picker
- Right-click: rename/archive

### Conversation Component
Accepts `conversationId` prop. All selectors scoped to that conversation.

## Phase 8: Context & Lifecycle

- `compileContext`: messages load scoped by `conversation_id`
- `manageConversation` (lifecycle): receives conversation-scoped array
- `session-turns.mjs`: keyed by `(projectId, conversationId)` instead of `projectId`
- Handoff stays project-level (shared state)

## Phase 9: Backwards Compatibility

- Migration backfills `conversation_id` on all existing messages
- Dual-write pattern during store transition
- Old code with `conversation_id IS NULL` queries still works
- `conversation_meta` table kept for now, deprecated in v7

## Implementation Order

| Step | What | Risk |
|------|------|------|
| 0 | Schema migration v6 | Low |
| 1 | `pane-db.mjs` new prepared statements | Low |
| 2 | `punk-types.ts` Conversation interface + Project changes | Medium |
| 3 | `projects.ts` store — addConversation, conversations Map, all mutator refactors | **High** |
| 4 | `main.mjs` IPC handlers updated + new handlers | Medium |
| 5 | `tauri-commands.ts` updated + new IPC calls | Low |
| 6 | `useSettingsPersistence.ts` conversation save/restore | Medium |
| 7 | `ConversationLayer` tab bar + `ConversationTabPanel` | Medium |
| 8 | All selectors in `Conversation.tsx`, `InputBar.tsx`, `usePunk.ts` refactored | **High** |
| 9 | `compileContext` + `context-orchestrator.mjs` conversation scoping | Medium |
| 10 | `conversation-lifecycle.mjs` + `session-turns.mjs` scoping | Low |
| 11 | Integration testing + edge cases | — |

## What NOT to Do

- Don't add `conversation_id` to token_usage, quality_metrics, correction_events (stay project-scoped)
- Don't add persistent tab indices — stable conversation IDs, order via `conversationOrder`
- Don't use React routing for conversation switching — local state only
- Don't scope brain memories per conversation (project-level for now)
- Don't delete `conversation` field until all consumers migrated

## Files Touched (~16)

- `src/main/pane-db.mjs` — schema migration, prepared statements
- `src/renderer/lib/punk-types.ts` — Conversation type, Project changes
- `src/renderer/stores/projects.ts` — all actions + selectors refactored
- `src/main/main.mjs` — IPC handlers
- `src/renderer/lib/tauri-commands.ts` — IPC calls
- `src/renderer/hooks/useSettingsPersistence.ts` — save/restore multiple conversations
- `src/renderer/components/Workspace/Workspace.tsx` — ConversationLayer with tab bar
- `src/renderer/components/Workspace/Conversation.tsx` — accept conversationId
- `src/renderer/components/Workspace/InputBar.tsx` — conversation-scoped send
- `src/renderer/hooks/usePunk.ts` — conversation-scoped hook
- `src/main/context-orchestrator.mjs` — compileContext scope
- `src/main/conversation-lifecycle.mjs` — scope pruning
- `src/main/session-turns.mjs` — key by (projectId, conversationId)
