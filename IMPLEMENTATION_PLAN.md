# Pane Agent Architecture — Implementation Plan

## Vision
Pane is the senior developer. The user directs, Pane owns the process. The user may not read or write code. Every quality check, architectural decision, and verification step is Pane's responsibility.

## Architecture Overview

```
User ──► Kickoff ──► Planning ──► Execution ──► Verification ──► Reflection
              │           │            │              │               │
              ▼           ▼            ▼              ▼               ▼
          roadmap      roadmap      roadmap        roadmap         roadmap
          created      steps        steps           milestone      next milestone
                       populated    completed       verified       activated
```

The **Roadmap** is the backbone. Everything hangs off it — session continuity, progress tracking, scoping, verification, and the user-facing project overview.

---

## Phase 0 — Roadmap System

### Goal
Persistent, project-level milestone tracking that replaces handoff for cross-session continuity and replaces floating todos with milestone-scoped steps.

### Data Model

```typescript
// src/renderer/lib/roadmap-types.ts

interface Roadmap {
  projectId: string;
  name: string;                    // "Delivery Tracker"
  purpose: string;                 // the why, from kickoff
  stack: {
    framework: string;
    language: string;
    database: string;
    runtime: string;
    notes: string;                 // any stack-level context
  };
  createdAt: number;
  updatedAt: number;
  milestones: Milestone[];
  decisions: Decision[];
  sessionLog: SessionEntry[];
}

interface Milestone {
  id: string;                      // nanoid
  title: string;                   // user language: "Create and view orders"
  description: string;             // one sentence: what the user gets
  status: "upcoming" | "active" | "done";
  order: number;
  steps: Step[];
  verification: VerificationResult;
  startedAt: number | null;
  completedAt: number | null;
}

interface Step {
  id: string;
  title: string;                   // "order form with validation"
  status: "pending" | "in_progress" | "done" | "blocked";
  notes: string | null;            // Pane's internal notes
}

interface VerificationResult {
  status: "pending" | "running" | "passed" | "failed";
  checks: VerificationCheck[];
  completedAt: number | null;
}

interface VerificationCheck {
  type: "typescript" | "lint" | "security" | "wiring" | "requirements" | "build" | "dependency_audit";
  passed: boolean;
  details: string;                 // human-readable result
}

interface Decision {
  question: string;
  answer: string;
  madeAt: number;
  milestoneId: string | null;      // null = project-level decision
}

interface SessionEntry {
  startedAt: number;
  endedAt: number;
  milestoneId: string;
  stepsCompleted: number;
  notes: string;
}
```

### Backend — RoadmapManager

**New file:** `src/main/roadmap-manager.mjs`

**Location:** `~/.pane/projects/{projectId}/roadmap.json`

**Follows existing persistence pattern** (sync fs, try-catch with defaults, mkdirSync recursive):

```javascript
// Exports:
export function createRoadmap(projectId, data)     // → writes roadmap.json
export function readRoadmap(projectId)             // → returns Roadmap | null
export function updateMilestone(projectId, milestoneId, delta)  // → partial update
export function updateStep(projectId, milestoneId, stepId, delta)
export function addDecision(projectId, decision)
export function addSessionEntry(projectId, entry)
export function getActiveMilestone(projectId)      // → current active milestone
export function advanceToNextMilestone(projectId)  // → mark current done, activate next
export function hasRoadmap(projectId)              // → boolean, used for kickoff detection
```

**Directory structure:**
```
~/.pane/
  projects/
    {projectId}/
      roadmap.json          ← NEW
```

Note: `~/.pane/projects/` may not exist yet. Use `fs.mkdirSync(dir, { recursive: true })` on first write.

### IPC Handlers

**Add to:** `src/main/main.mjs` inside `registerClaudeHandlers()`

```javascript
ipcMain.handle("roadmap:read", async (_event, { projectId }) => {
  return readRoadmap(projectId);
});

ipcMain.handle("roadmap:create", async (_event, { projectId, data }) => {
  return createRoadmap(projectId, data);
});

ipcMain.handle("roadmap:update-milestone", async (_event, { projectId, milestoneId, delta }) => {
  return updateMilestone(projectId, milestoneId, delta);
});

ipcMain.handle("roadmap:update-step", async (_event, { projectId, milestoneId, stepId, delta }) => {
  return updateStep(projectId, milestoneId, stepId, delta);
});

ipcMain.handle("roadmap:add-decision", async (_event, { projectId, decision }) => {
  return addDecision(projectId, decision);
});
```

### Frontend — IPC Bridge

**Add to:** `src/renderer/lib/tauri-commands.ts`

```typescript
export async function readRoadmap(projectId: string): Promise<Roadmap | null> {
  return window.electronAPI.invoke("roadmap:read", { projectId });
}

export async function createRoadmap(projectId: string, data: Partial<Roadmap>): Promise<Roadmap> {
  return window.electronAPI.invoke("roadmap:create", { projectId, data });
}

export async function updateRoadmapMilestone(projectId: string, milestoneId: string, delta: Partial<Milestone>): Promise<void> {
  return window.electronAPI.invoke("roadmap:update-milestone", { projectId, milestoneId, delta });
}

export async function updateRoadmapStep(projectId: string, milestoneId: string, stepId: string, delta: Partial<Step>): Promise<void> {
  return window.electronAPI.invoke("roadmap:update-step", { projectId, milestoneId, stepId, delta });
}

export async function addRoadmapDecision(projectId: string, decision: Decision): Promise<void> {
  return window.electronAPI.invoke("roadmap:add-decision", { projectId, decision });
}
```

### Frontend — Store Integration

**Option A (recommended):** Extend `useProjectsStore` — add roadmap field to each project.

**Add to Project interface in projects.ts:**
```typescript
interface Project {
  // ... existing fields
  roadmap: Roadmap | null;
}
```

**Add actions:**
```typescript
setRoadmap: (projectId: string, roadmap: Roadmap | null) => void;
updateMilestoneInStore: (projectId: string, milestoneId: string, delta: Partial<Milestone>) => void;
updateStepInStore: (projectId: string, milestoneId: string, stepId: string, delta: Partial<Step>) => void;
```

**Load on project select:** When `activeProjectId` changes, call `readRoadmap(projectId)` and set in store.

### Frontend — Roadmap Panel UI

**New file:** `src/renderer/components/ControlPanel/RoadmapPanel.tsx`

**Renders:**
- Milestone list with status indicators (✓ done, ◐ active, ○ upcoming)
- Steps within active milestone (expandable)
- Progress: "Step 3 of 6" for active milestone
- Overall: "Milestone 2 of 4"

**Styling rules (from design system):**
- `bg-pane-bg` container
- `ring-1 ring-pane-border/40` border
- No solid borders, no shadows
- Terminal accent (`--pane-terminal` / `#8AACCA`) for step numbers
- `text-pane-text-secondary/35` for completed items
- Terse labels: "create orders", not "Milestone 1: Create and View Customer Orders"

**Placement:** In ControlPanel, as an option alongside FileTree. Could be a tab or toggle. FileTree and RoadmapPanel are not mutually exclusive — roadmap is always visible, file tree is toggled.

### Claude Tool — pane_roadmap

**New tool definition in:** `src/main/http-backend.mjs` TOOL_DEFINITIONS array

```javascript
{
  type: "function",
  function: {
    name: "pane_roadmap",
    description: "Read or update the project roadmap. Use 'read' to see current milestones and progress. Use 'update_step' to mark a step as done. Use 'add_decision' to log a product decision.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "update_step", "add_decision", "complete_milestone"],
          description: "The roadmap action to perform"
        },
        milestone_id: { type: "string", description: "Target milestone ID" },
        step_id: { type: "string", description: "Target step ID (for update_step)" },
        step_status: { type: "string", enum: ["pending", "in_progress", "done", "blocked"] },
        decision: {
          type: "object",
          properties: {
            question: { type: "string" },
            answer: { type: "string" }
          }
        }
      },
      required: ["action"]
    }
  }
}
```

**Tool handler in:** `src/main/tool-executor.mjs`

```javascript
case "pane_roadmap": {
  const roadmap = readRoadmap(projectId);
  if (input.action === "read") return { success: true, output: JSON.stringify(roadmap, null, 2), toolId };
  if (input.action === "update_step") {
    updateStep(projectId, input.milestone_id, input.step_id, { status: input.step_status });
    // Emit event to frontend
    emitToRenderer(projectId, { event: "roadmap_updated", data: readRoadmap(projectId) });
    return { success: true, output: `Step updated to ${input.step_status}`, toolId };
  }
  // ... other actions
}
```

**Frontend event handler:** Listen for `roadmap_updated` events in `usePunk` hook, update store.

### Deliverables Checklist
- [ ] `src/renderer/lib/roadmap-types.ts` — type definitions
- [ ] `src/main/roadmap-manager.mjs` — CRUD operations, file persistence
- [ ] IPC handlers in `src/main/main.mjs`
- [ ] IPC bridge functions in `src/renderer/lib/tauri-commands.ts`
- [ ] Store integration in `src/renderer/stores/projects.ts`
- [ ] `src/renderer/components/ControlPanel/RoadmapPanel.tsx` — UI
- [ ] `pane_roadmap` tool definition in `http-backend.mjs`
- [ ] `pane_roadmap` handler in `tool-executor.mjs`
- [ ] `roadmap_updated` event type in `punk-types.ts`
- [ ] Event listener in `usePunk` hook

---

## Phase 1 — Pane Principles

### Goal
Encode Pane's behavioral identity into tier-1 frozen context so every conversation includes non-negotiable working principles.

### Implementation

**Modify:** `src/main/pane-system-prompt.mjs` → `compileContext()`

**Add after core instructions, before operating principles block:**

```javascript
// PANE PRINCIPLES — Tier 1 frozen, always injected
stableParts.push(
  "## Pane Principles",
  "",
  "These are non-negotiable. They override user requests when in conflict.",
  "",
  "1. SCOPE REALISTICALLY — Never attempt to deliver an entire application in one session. Break work into milestones. Deliver each one completely before starting the next.",
  "",
  "2. VERIFY OWN WORK — The user may not read code. Never assume they will catch mistakes. Every milestone passes verification before being marked done.",
  "",
  "3. PUSH BACK ON UNREALISTIC SCOPE — Rather deliver less that works than more that doesn't. Explain tradeoffs clearly. Do not fold on quality.",
  "",
  "4. ASK BEFORE ASSUMING — Product decisions belong to the user. Technical decisions belong to you. When the line is blurry, ask. Never guess on product intent.",
  "",
  "5. NEVER SUPPRESS OR SHORTCUT — No @ts-ignore, no eslint-disable, no empty catches, no 'as any' shortcuts. If the code needs a workaround, explain why and get approval.",
  "",
  "6. BUILD INCREMENTALLY — Each session produces something the user can see and interact with. Abstract infrastructure without visible output is not a deliverable.",
  "",
  "7. OWN YOUR REPUTATION — Handing the user broken work is not acceptable. Say 'this isn't ready' rather than pretend it is. Quality is non-negotiable.",
  "",
);
```

**No new files needed.** This is a ~15-line addition to an existing function.

### Testing
- Start a conversation, ask Claude to "build me a full e-commerce platform"
- Expected: Claude should scope it into milestones, refuse to build everything in one session
- If it doesn't push back, the principles aren't being injected or aren't strong enough — adjust wording

### Deliverables Checklist
- [ ] Principles block added to `compileContext()` in `pane-system-prompt.mjs`
- [ ] Verified principles appear in system prompt (add a debug log temporarily)
- [ ] Behavioral test: vague broad request → Claude scopes and pushes back

---

## Phase 2 — Workflow State Machine

### Goal
Replace passive phase detection with enforced phase transitions that gate tool access.

### State Machine Definition

```
States: kickoff | planning | execution | verification | reflection | idle

Transitions:
  idle → kickoff         when: project opened + no roadmap exists
  idle → planning        when: project opened + roadmap exists + active milestone has no steps
  idle → execution       when: project opened + roadmap exists + active milestone has steps in progress

  kickoff → planning     when: roadmap created
  planning → execution   when: user approves plan (steps populated)
  execution → verification   when: all non-verification steps done
  verification → reflection  when: all checks passed
  reflection → planning      when: next milestone activated + needs steps
  reflection → idle          when: no more milestones or session ends

Suspend:
  execution can suspend for clarification (flag, not phase change)
  { phase: "execution", suspended: true, clarification: { question, options } }
```

### Backend — WorkflowManager

**New file:** `src/main/workflow-manager.mjs`

```javascript
// Phase definitions with allowed tools
const PHASE_TOOL_GATES = {
  kickoff: {
    allowed: new Set([
      // Conversation only — no code, no files
      "pane_roadmap",       // to create the roadmap
      "pane_recall",        // to check memory
      "pane_brief",         // to read brief
      "WebSearch",          // to research if needed
    ]),
    description: "Discovery phase — gathering requirements, no implementation"
  },
  planning: {
    allowed: new Set([
      // Read-only + research
      "read_file", "glob", "grep_search", "search", "list_directory",
      "get_directory_tree", "pane_find_symbol", "pane_codebase_compass",
      "pane_roadmap", "pane_recall", "pane_brief",
      "WebSearch",
      "pane_project_context", "pane_open_files",
    ]),
    description: "Planning phase — research and architecture, no implementation"
  },
  execution: {
    allowed: null, // all tools — null means no restriction
    description: "Implementation phase — full tool access"
  },
  verification: {
    allowed: new Set([
      // Read + shell (for tsc, lint, test) — no writes
      "read_file", "glob", "grep_search", "search", "list_directory",
      "get_directory_tree", "run_shell_command", "pane_run_in_terminal",
      "pane_roadmap", "pane_recall", "pane_project_context",
      "pane_find_symbol", "pane_codebase_compass",
    ]),
    description: "Verification phase — checking work, no new features"
  },
  reflection: {
    allowed: new Set([
      "read_file", "pane_roadmap", "pane_recall", "pane_remember", "pane_brief",
    ]),
    description: "Reflection phase — logging and reporting"
  },
  idle: {
    allowed: null, // unrestricted when no workflow active
    description: "No active workflow"
  }
};

// Exports:
export function getCurrentPhase(projectId)
export function transitionPhase(projectId, targetPhase, reason)
export function isToolAllowed(projectId, toolName)      // ← called by tool executor
export function suspendForClarification(projectId, question, options)
export function resumeFromClarification(projectId, answer)
export function getPhaseContext(projectId)               // ← returns description for system prompt
```

**Phase stored in session state:**
```javascript
mergeState(projectId, {
  phase: "execution",
  phaseEnteredAt: Date.now(),
  suspended: false,
  clarification: null,
});
```

### Tool Gating Integration

**Modify:** `src/main/tool-executor.mjs`

Before executing any tool, check phase:

```javascript
// At the top of tool execution (before the switch statement)
import { isToolAllowed, getPhaseContext } from "./workflow-manager.mjs";

const allowed = isToolAllowed(projectId, toolName);
if (!allowed) {
  const phaseCtx = getPhaseContext(projectId);
  return {
    success: false,
    output: `Tool "${toolName}" is not available during ${phaseCtx.description}. Current phase: ${phaseCtx.phase}.`,
    toolId
  };
}
```

### System Prompt Integration

**Modify:** `src/main/pane-system-prompt.mjs` → `compileContext()`

Inject current phase context into tier-3 (turn) parts:

```javascript
// In compileContext, add to turnParts:
const phaseCtx = getPhaseContext(projectId);
if (phaseCtx && phaseCtx.phase !== "idle") {
  turnParts.push(
    `## Current Workflow Phase: ${phaseCtx.phase.toUpperCase()}`,
    phaseCtx.description,
    `Available tools are restricted to this phase. ${phaseCtx.guidance || ""}`,
    ""
  );
}
```

**Phase-specific guidance (injected with phase context):**
```javascript
const PHASE_GUIDANCE = {
  kickoff: "Ask the user questions to understand their project. Do not write code. Do not create files. Focus on: what are we building, why, for whom, on what platform, at what scale. When you have enough context, create the roadmap using pane_roadmap.",
  planning: "Research the technical approach. Read existing code. Break the active milestone into concrete steps. Present the plan to the user for approval. Do not implement anything yet.",
  execution: "Work through milestone steps one at a time. Announce each step before starting. When you hit a product decision you can't make alone, use pane_clarify to ask the user. Mark steps done as you complete them.",
  verification: "Review all work done in this milestone. Run type checks, lint, security scan. Trace the data flow end to end. Compare implementation against the milestone description. Fix any issues found. Do not add new features.",
  reflection: "Summarize what was built. Compare against the original milestone description. Log the session. Activate the next milestone if appropriate. Report to the user in plain language."
};
```

### Replace conversation-phase.mjs

**Delete or gut:** `src/main/conversation-phase.mjs`

The `detectPhase()` function is replaced by `getCurrentPhase()` from workflow-manager. The `filterAtomsForPhase()` can be adapted to use the new phase names.

**Modify callers:**
- `context-orchestrator.mjs` — replace `detectPhase(signals)` with `getCurrentPhase(projectId)`
- Anywhere `filterAtomsForPhase()` is called — update phase names mapping:
  ```
  kickoff    → "opening"   (full atoms)
  planning   → "review"    (drop execute/plan atoms, keep orient/scope)
  execution  → "mid-work"  (drop orient/scope, keep execute)
  verification → "review"  (drop execute/plan)
  reflection → "closing"   (verify + record only)
  ```

### Frontend — Phase Display

**Modify:** existing UI that shows conversation phase (if any)

Show current phase as a subtle label in the workspace header or near the input bar:
```
kickoff        → "scoping project"
planning       → "planning milestone 2"
execution      → "building: step 3 of 6"
verification   → "verifying milestone 2"
reflection     → "wrapping up"
idle           → (nothing shown)
```

**Event from backend:** Add `phase_changed` event to `PunkStreamEvent` union:
```typescript
interface PunkEventPhaseChanged {
  event: "phase_changed";
  data: { phase: string; milestone?: string; step?: string };
}
```

### Deliverables Checklist
- [ ] `src/main/workflow-manager.mjs` — phase state, transitions, tool gating
- [ ] Tool gating in `tool-executor.mjs` — check before every tool call
- [ ] Phase context injection in `pane-system-prompt.mjs`
- [ ] Phase guidance per phase
- [ ] Replace `conversation-phase.mjs` usage in `context-orchestrator.mjs`
- [ ] `phase_changed` event type in `punk-types.ts`
- [ ] Frontend phase display
- [ ] Phase transition triggers wired to roadmap state changes

---

## Phase 3 — Kickoff Flow

### Goal
When a project has no roadmap, Pane leads a structured discovery conversation, makes the stack decision, proposes milestones, and creates the roadmap on user approval.

### Detection

**Where:** `src/main/http-backend.mjs` — at the start of message processing, before system prompt compilation

```javascript
import { hasRoadmap } from "./roadmap-manager.mjs";
import { getCurrentPhase, transitionPhase } from "./workflow-manager.mjs";

// At the beginning of handling a new message:
if (!hasRoadmap(projectId)) {
  const phase = getCurrentPhase(projectId);
  if (phase !== "kickoff") {
    transitionPhase(projectId, "kickoff", "no roadmap exists");
  }
}
```

### Kickoff System Prompt

**Inject when phase is `kickoff`** (in `compileContext()` or via phase guidance):

```
You are starting a new project with the user. Your job is to understand what they want to build before writing any code.

DO NOT:
- Write any code
- Create any files
- Suggest specific implementations
- Present more than 2 stack options

DO:
- Ask questions one or two at a time
- Listen carefully to answers
- Make the stack decision yourself based on their answers
- Present a clear, realistic milestone plan

INFORMATION YOU NEED (ask until you have all of these):
1. PRODUCT: What is this app/tool? What problem does it solve?
2. USERS: Who uses it? Walk me through their typical workflow.
3. PLATFORM: Web, mobile, desktop? Which devices matter most?
4. SCALE: Personal project, team tool, or public product? How many users?
5. CONSTRAINTS: Any specific requirements? Offline use? Real-time? Integrations?

ONCE YOU HAVE ENOUGH CONTEXT:
1. Choose the right stack. Present exactly two options as a brief comparison. Let the user pick.
2. Design 3-6 milestones. Each milestone is a user-visible deliverable, not a technical task.
3. Milestone 1 must be achievable in one session and produce something the user can see and interact with.
4. Present the milestones and ask the user to approve or adjust.
5. On approval, call pane_roadmap with action "create" to save the roadmap.
```

### Interactive UI Components

**New file:** `src/renderer/components/Workspace/ChoiceCards.tsx`

Renders when Claude's response includes a structured choice block. The model outputs a special format that the frontend detects:

```
<pane-choice>
{
  "type": "stack_selection",
  "options": [
    { "id": "a", "title": "Next.js + PostgreSQL", "subtitle": "Web-first, fast iteration, great for dashboards", "best_if": "Your users are on laptops/desktops" },
    { "id": "b", "title": "React Native + Supabase", "subtitle": "Mobile-first, works offline, native feel", "best_if": "Your users are on phones in the field" }
  ]
}
</pane-choice>
```

**Frontend parsing:** In `MessageBubble.tsx`, detect `<pane-choice>` blocks in text content. Parse JSON. Render as `ChoiceCards` component instead of markdown.

**ChoiceCards styling:**
```
- Two cards side by side
- bg-pane-surface, ring-1 ring-pane-border/40
- Hover: ring-pane-terminal/60
- Selected: ring-pane-terminal, bg-pane-terminal/5
- Title: text-pane-text font-medium
- Subtitle: text-pane-text-secondary text-sm
- "Best if" label: text-pane-terminal text-xs
- No shadows, no borders — ring only
```

**On selection:** Send user message with the choice: "Option A: Next.js + PostgreSQL" — this feeds back into the conversation naturally.

**New file:** `src/renderer/components/Workspace/ScopeProposal.tsx`

Similar pattern — model outputs `<pane-scope>` block with milestone list. Frontend renders as interactive list with "Start building" button.

```
<pane-scope>
{
  "milestones": [
    { "title": "Create and view orders", "description": "You can open the app and add a delivery order" },
    { "title": "Track deliveries live", "description": "See where each delivery is on a map" },
    { "title": "Process payments", "description": "Customers can pay online, you see the revenue" }
  ],
  "session_1": "We'll complete milestone 1 in this session. You'll have a working order form."
}
</pane-scope>
```

**On "Start building":** Triggers roadmap creation (model calls `pane_roadmap` with action "create") and phase transition to planning.

### Roadmap Creation Tool

The `pane_roadmap` tool (from Phase 0) needs a `create` action:

```javascript
if (input.action === "create") {
  const roadmap = createRoadmap(projectId, {
    name: input.name,
    purpose: input.purpose,
    stack: input.stack,
    milestones: input.milestones.map((m, i) => ({
      id: nanoid(),
      title: m.title,
      description: m.description,
      status: i === 0 ? "active" : "upcoming",
      order: i,
      steps: [],           // populated during planning phase
      verification: { status: "pending", checks: [], completedAt: null },
      startedAt: i === 0 ? Date.now() : null,
      completedAt: null,
    })),
    decisions: [],
    sessionLog: [],
  });
  transitionPhase(projectId, "planning", "roadmap created");
  emitToRenderer(projectId, { event: "roadmap_updated", data: roadmap });
  return { success: true, output: "Roadmap created. Transitioning to planning phase.", toolId };
}
```

### Deliverables Checklist
- [ ] Kickoff detection in `http-backend.mjs`
- [ ] Kickoff system prompt in `pane-system-prompt.mjs`
- [ ] `src/renderer/components/Workspace/ChoiceCards.tsx`
- [ ] `src/renderer/components/Workspace/ScopeProposal.tsx`
- [ ] `<pane-choice>` and `<pane-scope>` parsing in `MessageBubble.tsx`
- [ ] `pane_roadmap` create action in tool executor
- [ ] Auto-transition kickoff → planning on roadmap creation
- [ ] Test: new project → 4-5 turn conversation → roadmap created

---

## Phase 4 — Planning Phase

### Goal
Research-backed, structured step breakdown for the active milestone. Presented to user for approval before implementation begins.

### Trigger
Phase is `planning` (set by: kickoff completion, or reflection activating next milestone, or session start with active milestone lacking steps).

### Planning System Prompt

**Inject when phase is `planning`:**

```
You are planning the implementation for the current milestone. Follow this exact sequence:

1. RESEARCH (2-3 searches)
   Search for current best practices related to the stack and this milestone's topic.
   Example: if building an order form with Next.js, search for "next.js 15 server actions form handling" and "postgres order schema design patterns"
   Keep results internal — inform your plan, don't dump raw results on the user.

2. READ EXISTING CODE (if this isn't session 1)
   Read the existing codebase to understand what's already built.
   Trace the architecture — what connects to what.
   Know exactly where new work plugs in.

3. BREAK DOWN INTO STEPS
   Create 4-8 steps for this milestone. Each step must be:
   - Small enough for one focused implementation pass
   - Described in plain language (the user will see these)
   - Ordered by dependency
   - The last step is ALWAYS "Verify everything works end to end"

4. PRESENT THE PLAN
   Use the <pane-plan> format to present steps. Wait for user approval.
   Do NOT start implementing. Do NOT create files. Do NOT write code.
```

### Plan Proposal UI

**New file:** `src/renderer/components/Workspace/PlanProposal.tsx`

Model outputs `<pane-plan>` block:
```
<pane-plan>
{
  "milestone": "Create and view orders",
  "steps": [
    { "title": "Set up project structure and database", "detail": "Initialize Next.js project, configure PostgreSQL connection, create the orders table" },
    { "title": "Build the order creation form", "detail": "Form with fields for customer name, items, delivery address, and notes" },
    { "title": "Save orders to the database", "detail": "When the form is submitted, the order is stored and confirmed" },
    { "title": "Build the order list view", "detail": "A page showing all orders with status, date, and customer" },
    { "title": "Connect everything end to end", "detail": "Creating an order shows it immediately in the list" },
    { "title": "Verify everything works", "detail": "Full end-to-end check: create, view, edge cases, error handling" }
  ]
}
</pane-plan>
```

**Renders as:**
- Step list with numbers (terminal accent for numbers)
- Each step: title (bold) + detail (secondary text, collapsed by default)
- Two buttons: "Start building" / "Let's adjust"
- "Let's adjust" sends a message allowing the user to comment

**On "Start building":**
1. User message sent: "Approved. Start building."
2. Model calls `pane_roadmap` to populate steps
3. Phase transitions to `execution`

### Steps Population

Add `populate_steps` action to `pane_roadmap` tool:

```javascript
if (input.action === "populate_steps") {
  const steps = input.steps.map(s => ({
    id: nanoid(),
    title: s.title,
    status: "pending",
    notes: s.detail || null,
  }));
  updateMilestone(projectId, input.milestone_id, { steps });
  transitionPhase(projectId, "execution", "plan approved");
  emitToRenderer(projectId, { event: "roadmap_updated", data: readRoadmap(projectId) });
  return { success: true, output: `${steps.length} steps added. Entering execution phase.`, toolId };
}
```

### Deliverables Checklist
- [ ] Planning system prompt (phase-specific injection)
- [ ] `src/renderer/components/Workspace/PlanProposal.tsx`
- [ ] `<pane-plan>` parsing in `MessageBubble.tsx`
- [ ] `populate_steps` action in `pane_roadmap` tool
- [ ] Phase transition planning → execution on approval
- [ ] Test: planning phase → research → steps → user approves → execution starts

---

## Phase 5 — Execution Phase

### Goal
Step-by-step implementation with progress tracking, automatic step advancement, and mid-task clarification.

### Step Execution Prompt

**Inject when phase is `execution`:**

```
You are implementing milestone steps. The current milestone and steps are in your roadmap context.

RULES:
1. Work through steps IN ORDER. Do not skip ahead.
2. Before starting a step, announce it: "Working on: [step title]"
3. Call pane_roadmap(action: "update_step", step_status: "in_progress") when you start a step.
4. Call pane_roadmap(action: "update_step", step_status: "done") when you complete a step.
5. If you hit a product decision you cannot make alone, use pane_clarify to ask the user. DO NOT GUESS.
6. When all steps except verification are done, stop and tell Pane you're ready for verification.

DO NOT:
- Work on multiple steps simultaneously
- Skip verification
- Make product assumptions without asking
- Suppress any warning or error
```

### Progress Tracking

**Backend emits progress events** when roadmap updates:

```typescript
// In tool executor, after updating a step:
emitToRenderer(projectId, {
  event: "step_progress",
  data: {
    milestoneTitle: milestone.title,
    currentStep: step.title,
    stepIndex: currentIndex + 1,
    totalSteps: milestone.steps.length,
    status: step.status
  }
});
```

**Frontend — StepProgress component:**

**New file:** `src/renderer/components/Workspace/StepProgress.tsx`

Renders inline in conversation area (above input bar or as a persistent banner):
```
Building: Create and view orders
Step 3 of 6 · Save orders to database  ████░░░░
```

Styling:
- Compact single line
- Terminal accent for step number
- Progress bar: `bg-pane-terminal/20` track, `bg-pane-terminal` fill
- Disappears when phase exits execution

### Clarification Tool

**New tool:** `pane_clarify`

**Tool definition in `http-backend.mjs`:**

```javascript
{
  type: "function",
  function: {
    name: "pane_clarify",
    description: "Ask the user a product decision question. Use this when you encounter ambiguity that requires the user's input. Execution pauses until the user responds.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user" },
        context: { type: "string", description: "Why this matters — one sentence explaining the impact" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" }
            }
          },
          description: "2-3 options for the user to choose from. If empty, user provides free text."
        }
      },
      required: ["question"]
    }
  }
}
```

**Tool handler:**

```javascript
case "pane_clarify": {
  // Suspend execution
  suspendForClarification(projectId, input.question, input.options || []);

  // Emit to frontend
  emitToRenderer(projectId, {
    event: "clarification_needed",
    data: {
      question: input.question,
      context: input.context,
      options: input.options || []
    }
  });

  // Return the question as tool result — model sees this as "waiting"
  return {
    success: true,
    output: `Clarification requested: "${input.question}". Waiting for user response.`,
    toolId
  };
}
```

**Frontend — ClarificationCard component:**

**New file:** `src/renderer/components/Workspace/ClarificationCard.tsx`

Renders inline in conversation:
```
┌─ Decision needed ────────────────────────────┐
│                                               │
│  Should customers see the driver's real name? │
│  This affects how we store driver info.       │
│                                               │
│  ○ Real name — more personal                  │
│  ○ Anonymous — more private                   │
│                                               │
└───────────────────────────────────────────────┘
```

Styling:
- `bg-pane-surface` background
- `ring-1 ring-pane-terminal/40` — terminal accent ring (this is a machine question)
- Radio buttons or tappable options
- On selection: sends user message with the answer, resumes execution

**Decision logging:** When user answers, model calls `pane_roadmap(action: "add_decision")` to persist it. Decisions survive sessions.

### Auto-transition to Verification

**In workflow-manager.mjs:**

After every step update to "done", check if all non-verification steps are complete:

```javascript
export function checkMilestoneReadyForVerification(projectId) {
  const roadmap = readRoadmap(projectId);
  const active = roadmap.milestones.find(m => m.status === "active");
  if (!active) return false;

  const nonVerificationSteps = active.steps.filter(s => !s.title.toLowerCase().includes("verify"));
  const allDone = nonVerificationSteps.every(s => s.status === "done");

  if (allDone) {
    transitionPhase(projectId, "verification", "all implementation steps complete");
    return true;
  }
  return false;
}
```

Call this after every `update_step` in the tool handler.

### Deliverables Checklist
- [ ] Execution system prompt (phase-specific injection)
- [ ] `step_progress` event type in `punk-types.ts`
- [ ] `src/renderer/components/Workspace/StepProgress.tsx`
- [ ] `pane_clarify` tool definition in `http-backend.mjs`
- [ ] `pane_clarify` handler in `tool-executor.mjs`
- [ ] Suspend/resume logic in `workflow-manager.mjs`
- [ ] `clarification_needed` event type
- [ ] `src/renderer/components/Workspace/ClarificationCard.tsx`
- [ ] Decision logging via `pane_roadmap` add_decision
- [ ] Auto-transition to verification when steps complete

---

## Phase 6 — Verification Phase

### Goal
Multi-layer quality assurance that runs after every milestone. Not skippable, not optional. Pane reviews its own work because the user can't.

### Trigger
Auto-triggered when all implementation steps are done (from Phase 5).

### Verification System Prompt

**Inject when phase is `verification`:**

```
All implementation steps for this milestone are complete. You are now in VERIFICATION PHASE.

DO NOT add new features. DO NOT write new functionality. Only verify and fix.

Execute these checks IN ORDER:

LAYER 1 — AUTOMATED CHECKS
Run each command. Report results. Fix failures before moving to layer 2.
1. TypeScript: run `npx tsc --noEmit` — must be zero errors
2. Lint: run `npx eslint . --max-warnings 0` — must be zero warnings
3. Build: run `npm run build` (or equivalent) — must compile
4. Dependencies: run `npm audit` — flag high/critical vulnerabilities

LAYER 2 — SECURITY SCAN
Read every file you wrote or modified. Check for:
- Hardcoded API keys, passwords, or secrets
- Use of eval(), innerHTML, dangerouslySetInnerHTML
- SQL/NoSQL queries built with string concatenation
- Routes or endpoints without authentication/authorization
- CORS wildcards (*) in production config
- Environment variables exposed to client-side code
- Sensitive data in error messages or logs

LAYER 3 — ARCHITECTURE TRACE
- Read every file changed during this milestone
- For each step in the plan, confirm the implementation actually exists and works
- Trace the full data flow: user action → handler → database → response → UI
- Check: are all imports resolved? Are all routes connected? Does every form submit to a real endpoint?

LAYER 4 — EDGE CASES
- What happens with empty input?
- What happens with duplicate submissions?
- What happens if required fields are missing?
- What happens with unexpectedly long strings?
- What happens if the database is unreachable?

LAYER 5 — REQUIREMENT MATCH
- Re-read the milestone description
- Re-read all decisions made during this milestone
- Does the implementation match what the user asked for?
- Is anything missing that was part of the plan?

For each layer:
- If issues found: FIX THEM. Then re-run that layer's checks.
- Max 3 fix attempts per issue. If unfixable, document it.
- After all layers pass: call pane_roadmap to update verification status.

Report to user:
- "Milestone verified. Everything checks out." (if clean)
- "Milestone verified with notes: [brief issue list]" (if minor items remain)
```

### Verification Tool Actions

Add verification actions to `pane_roadmap`:

```javascript
if (input.action === "update_verification") {
  updateMilestone(projectId, input.milestone_id, {
    verification: {
      status: input.passed ? "passed" : "failed",
      checks: input.checks,  // array of { type, passed, details }
      completedAt: Date.now(),
    }
  });

  if (input.passed) {
    transitionPhase(projectId, "reflection", "verification passed");
  }

  emitToRenderer(projectId, { event: "roadmap_updated", data: readRoadmap(projectId) });
  return { success: true, output: input.passed ? "Verification passed." : "Verification failed. Fix issues and re-run.", toolId };
}
```

### Extended Reflex Gates (Security Patterns)

**Modify:** `src/main/tool-executor.mjs` — add to existing reflex gate patterns:

```javascript
// NEW security patterns (add to existing VIOLATION_PATTERNS or equivalent):
const SECURITY_PATTERNS = [
  { pattern: /['"][A-Za-z0-9_]{20,}['"]/g, type: "warning", message: "Possible hardcoded API key or secret. Use environment variables." },
  { pattern: /eval\s*\(/g, type: "error", message: "eval() is a security risk. Find an alternative." },
  { pattern: /innerHTML\s*=/g, type: "error", message: "Direct innerHTML assignment. Use safe DOM methods or a framework's built-in rendering." },
  { pattern: /dangerouslySetInnerHTML/g, type: "warning", message: "dangerouslySetInnerHTML used. Ensure input is sanitized." },
  { pattern: /`[^`]*\$\{[^}]*\}[^`]*`/g, type: "info", message: "Template literal in query context — verify this isn't SQL/NoSQL injection." },
  { pattern: /cors\(\s*\)/g, type: "warning", message: "CORS with no origin restriction. Specify allowed origins in production." },
  { pattern: /NEXT_PUBLIC_.*(?:KEY|SECRET|PASSWORD|TOKEN)/gi, type: "error", message: "Secret exposed as public environment variable." },
];
```

These augment existing reflex gates — same pattern, same flow, same <5ms execution.

### Verification Report UI

**New file:** `src/renderer/components/Workspace/VerificationReport.tsx`

Renders inline in conversation after verification completes:

```
┌─ Verification complete ──────────────────────┐
│                                               │
│  ✓ TypeScript     — zero errors               │
│  ✓ Lint           — zero warnings             │
│  ✓ Security       — no issues found           │
│  ✓ Architecture   — all connections verified  │
│  ✓ Requirements   — matches milestone scope   │
│                                               │
│  Milestone "Create and view orders" verified. │
└───────────────────────────────────────────────┘
```

Or with issues:
```
│  ✓ TypeScript     — zero errors               │
│  ✓ Lint           — zero warnings             │
│  ⚠ Security       — 1 note (expand ▼)         │
│  ✓ Architecture   — all connections verified  │
│  ✓ Requirements   — matches milestone scope   │
```

Collapsed by default. Expandable sections. Green checkmarks in terminal accent color.

### Deliverables Checklist
- [ ] Verification system prompt (phase-specific injection)
- [ ] `update_verification` action in `pane_roadmap` tool
- [ ] Security patterns added to reflex gates in `tool-executor.mjs`
- [ ] Auto-transition verification → reflection on pass
- [ ] `src/renderer/components/Workspace/VerificationReport.tsx`
- [ ] Verification report parsing in `MessageBubble.tsx`
- [ ] Test: complete a milestone → verification runs → report rendered

---

## Phase 7 — Reflection + Session Continuity

### Goal
Close the loop after verification. Summarize, log, activate next milestone, greet the user on next session.

### Reflection System Prompt

**Inject when phase is `reflection`:**

```
Verification has passed. You are in REFLECTION PHASE.

1. SUMMARIZE for the user (in plain language, not code terms):
   - What was built in this milestone
   - Any decisions that were made along the way
   - Any notes or limitations

2. LOG THE SESSION:
   - Call pane_roadmap(action: "complete_milestone") to mark the milestone done
   - Call pane_roadmap(action: "log_session") with session notes

3. NEXT MILESTONE:
   - If there are upcoming milestones, activate the next one
   - Tell the user what's coming next: "Next session we'll work on [milestone title]"
   - If this was the last milestone, congratulate the user — the project is complete

4. TRANSITION:
   - If the user wants to continue: transition to planning for the next milestone
   - If the session is ending: say goodbye with a brief status summary
```

### Session Greeting on Cold Start

**Modify:** `src/main/http-backend.mjs` — at the start of a new conversation (not journal resume):

```javascript
import { readRoadmap, getActiveMilestone } from "./roadmap-manager.mjs";

// When starting a new conversation (not resuming):
const roadmap = readRoadmap(projectId);
if (roadmap) {
  const active = getActiveMilestone(projectId);
  const completed = roadmap.milestones.filter(m => m.status === "done").length;
  const total = roadmap.milestones.length;

  let greeting = "";
  if (active) {
    const doneSteps = active.steps.filter(s => s.status === "done").length;
    if (doneSteps > 0) {
      greeting = `[Session context: Project "${roadmap.name}". ${completed}/${total} milestones complete. Currently on "${active.title}" — ${doneSteps}/${active.steps.length} steps done. Resume from where we left off.]`;
    } else {
      greeting = `[Session context: Project "${roadmap.name}". ${completed}/${total} milestones complete. Next milestone: "${active.title}". Ready to plan the implementation.]`;
    }
  } else if (completed === total) {
    greeting = `[Session context: Project "${roadmap.name}". All ${total} milestones complete. Project is done. User may want to add new milestones or discuss improvements.]`;
  }

  // Inject as a user context message at the start of conversation
  if (greeting) {
    messages.unshift({ role: "user", content: greeting });
  }
}
```

This makes Pane's first response contextual: "Welcome back. We finished the order form last time. Ready to start on delivery tracking?"

### Session Log

Add `log_session` and `complete_milestone` actions to `pane_roadmap`:

```javascript
if (input.action === "complete_milestone") {
  updateMilestone(projectId, input.milestone_id, {
    status: "done",
    completedAt: Date.now()
  });
  // Activate next milestone
  advanceToNextMilestone(projectId);
  emitToRenderer(projectId, { event: "roadmap_updated", data: readRoadmap(projectId) });
  return { success: true, output: "Milestone completed. Next milestone activated.", toolId };
}

if (input.action === "log_session") {
  addSessionEntry(projectId, {
    startedAt: readState(projectId).startedAt,
    endedAt: Date.now(),
    milestoneId: input.milestone_id,
    stepsCompleted: input.steps_completed || 0,
    notes: input.notes || ""
  });
  return { success: true, output: "Session logged.", toolId };
}
```

### Deliverables Checklist
- [ ] Reflection system prompt (phase-specific injection)
- [ ] `complete_milestone` and `log_session` actions in `pane_roadmap`
- [ ] `advanceToNextMilestone()` in roadmap-manager
- [ ] Session greeting injection in `http-backend.mjs`
- [ ] Phase transition reflection → planning (next milestone) or idle
- [ ] Test: verification passes → reflection → milestone marked done → next session opens with context

---

## Phase 8 — Pushback Mechanism

### Goal
Pane refuses unrealistic scope gracefully, with escalating concessions if the user insists.

### Implementation

**This is mostly prompt engineering + one state field.**

**Add to session state:**
```javascript
mergeState(projectId, {
  pushbackRound: 0  // 0 = no pushback, 1 = explained tradeoff, 2 = conceded scope, 3 = complied
});
```

**Add to planning phase prompt (conditionally):**

```javascript
// In compileContext, when phase is "planning" or "kickoff":
const state = readState(projectId);
if (state.pushbackRound === 0) {
  turnParts.push(
    "SCOPE MANAGEMENT:",
    "If the user's request exceeds what can be done in one session (typically 1 milestone with 4-8 steps):",
    "- Propose a realistic session scope",
    "- State what's deferred and why",
    "- Be direct: 'This is a [N]-session project. Let's start with [milestone 1].'",
    ""
  );
} else if (state.pushbackRound === 1) {
  turnParts.push(
    "SCOPE MANAGEMENT (user pushed back once):",
    "The user wants more scope than you recommended. Concede some ground but keep verification:",
    "- Expand scope to cover more, but state that verification will be thorough",
    "- 'I can cover more ground, but I'm keeping full verification — it'll take a bit longer.'",
    ""
  );
} else if (state.pushbackRound >= 2) {
  turnParts.push(
    "SCOPE MANAGEMENT (user insists on full scope):",
    "The user has overridden your scope recommendation. Comply but flag it:",
    "- Do the work, but note in verification what wasn't fully checked",
    "- 'Rapid build mode — I'll flag anything I'm not confident about.'",
    ""
  );
}
```

**Pushback detection:** When the model's response includes scope pushback and the user's next message insists, increment `pushbackRound`. This can be detected heuristically in `http-backend.mjs`:

```javascript
// After receiving user message, check if it's a scope override:
const scopeOverridePatterns = [
  /do it all/i, /build everything/i, /i don't care.*scope/i,
  /just do it/i, /i want all of/i, /don't.*limit/i, /full.*app/i
];
const isOverride = scopeOverridePatterns.some(p => p.test(userMessage));
if (isOverride && state.pushbackRound < 3) {
  mergeState(projectId, { pushbackRound: state.pushbackRound + 1 });
}
```

### Deliverables Checklist
- [ ] `pushbackRound` field in session state
- [ ] Conditional scope management prompts per pushback level
- [ ] Scope override detection heuristic
- [ ] Test: broad request → pushback → user insists → Pane concedes with transparency

---

## Phase 9 — Integration + Polish

### Goal
End-to-end flow works seamlessly. Edge cases handled. Dead code removed.

### Integration Tasks

1. **End-to-end test flow:**
   - New project → kickoff (4-5 turns) → stack selected → milestones proposed → approved
   - → planning (research → steps → approved)
   - → execution (step by step → clarification → resume → all steps done)
   - → verification (all layers → pass)
   - → reflection (summary → next milestone activated)
   - → close session → reopen → greeting with context → planning for milestone 2

2. **Edge cases to handle:**
   - Existing project with code but no roadmap → offer to create one from current state
   - User sends code or technical requests during kickoff → redirect to finishing discovery
   - Verification fails repeatedly → allow milestone to be marked "done with known issues"
   - User wants to skip a milestone → allow reordering, mark skipped
   - User wants to add a milestone mid-project → append to roadmap
   - Crash during execution → journal recovers, roadmap step status persists
   - Model switch mid-session → roadmap is source of truth, not conversation history

3. **Dead code removal:**
   - Remove or gut `planning-agent.mjs` (replaced by planning phase)
   - Remove handoff generation from `pane-system-prompt.mjs` (replaced by roadmap)
   - Remove `pane_get_handoff` tool definition
   - Remove `handoff.json` / `handoff-history.json` writes
   - Clean up `conversation-phase.mjs` (replaced by workflow-manager)

4. **UI polish:**
   - All new components match design system (verify: no borders on inputs, no shadows, terse labels, terminal accent)
   - Roadmap panel animations (fadeSlideUp on milestone completion)
   - Progress indicator visible but not distracting
   - Phase label in workspace header — subtle, informational
   - Mobile-responsive consideration for roadmap panel (if applicable)

5. **Prompt tuning:**
   - Run 5+ real conversations through the full flow
   - Identify where the model drifts from expected phase behavior
   - Tighten prompts where needed — add examples, add constraints
   - Test with deliberately vague user inputs
   - Test with deliberately adversarial inputs (user demanding everything at once)

### Deliverables Checklist
- [ ] Full end-to-end test pass
- [ ] Edge case handling for all scenarios listed above
- [ ] Dead code removed (planning-agent, handoff, conversation-phase)
- [ ] UI audit against design system
- [ ] 5+ real conversation tests with prompt adjustments
- [ ] Performance check: roadmap reads/writes don't add noticeable latency

---

## Dependency Graph

```
Phase 0 (Roadmap) ─────┬──► Phase 2 (State Machine) ──┬──► Phase 3 (Kickoff)
                        │                               │
Phase 1 (Principles) ───┤                               ├──► Phase 4 (Planning)
                        │                               │
                        │                               ├──► Phase 5 (Execution)
                        │                               │
                        │                               ├──► Phase 6 (Verification)
                        │                               │
                        │                               └──► Phase 7 (Reflection)
                        │
                        └──► Phase 8 (Pushback) ← also needs Phase 4

Phase 9 (Integration) ← needs all of the above
```

**Parallel tracks:**
- Phase 0 + Phase 1 can be built simultaneously
- Phase 3 + Phase 8 can overlap (both are prompt-heavy)
- Phase 5 + Phase 6 are sequential (verification needs execution to test)

## Total Estimated Effort

| Phase | Days | Running Total |
|-------|------|---------------|
| 0. Roadmap System | 3-4 | 3-4 |
| 1. Principles | 1 | 4-5 |
| 2. State Machine | 3-4 | 7-9 |
| 3. Kickoff Flow | 5-6 | 12-15 |
| 4. Planning Phase | 4-5 | 16-20 |
| 5. Execution Phase | 5-6 | 21-26 |
| 6. Verification Phase | 5-6 | 26-32 |
| 7. Reflection + Continuity | 3-4 | 29-36 |
| 8. Pushback Mechanism | 2-3 | 31-39 |
| 9. Integration + Polish | 4-5 | 35-44 |

**~5-7 weeks of focused work.**
