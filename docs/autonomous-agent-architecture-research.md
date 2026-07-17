# Autonomous Agent Architecture — Research & Strategy

> Compiled: June 2025
> Sources: Anthropic (Building Effective AI Agents PDF, re:Invent 2025 talk, Writing Tools for Agents blog), Google Cloud Architecture Center, CLAUSE framework paper, Advanced Context Engineering (HumanLayer/ACE), industry surveys.

---

## 1. The Core Shift: Context Engineering Replaces Prompt Engineering

The single biggest insight from every source: **the quality of your agent is determined by the quality of what's in its context window**. LLMs are stateless functions — every turn is a stateless function call. Context window in, next step out. The only lever is the inputs.

This means the architecture around the model matters more than the model itself. Pane's founding thesis is correct.

### Key Corollary: Cacheability is the New Optimization Target

System prompts and core tool definitions should remain cacheable. Expensive tools and rarely-used context should be loaded on demand (deferred). This is what Anthropic's advanced tool use API enables — tools only enter context when Claude searches for them.

---

## 2. The Five Dominant Design Patterns (2025)

### Pattern 1: Reflection (The Self-Correcting Agent)

Generate → Evaluate → Revise. A controlled verification layer before output is used downstream.

- **When to use**: High-stakes where mistakes are costly, difficult to detect, or expensive to fix later.
- **Cost**: Every reflection cycle = additional model calls = increased latency + token consumption.
- **Must have**: Explicit stopping rules. Without them, you get loops that consume resources without improving results.
- **Best fit**: Legal tech (contract review), Healthcare (clinical validation), Software engineering (security audits).
- **The rule**: Only introduce Reflection when failure data shows single-pass accuracy is not meeting the required standard.

### Pattern 2: Plan and Solve (Task → Agent)

Separate task design from task execution. The system breaks the objective into a sequence of steps before executing.

- **When to use**: Multi-step tasks where order of operations matters, data migration, deep research synthesis.
- **Cost**: Mandatory upfront computational overhead ("planning tax").
- **Failure modes**:
  - Over-decomposition: breaking tasks into excessive trivial steps, compounding latency.
  - Plan staleness: following a fixed roadmap when the environment has changed. Need re-planning checkpoints.
- **Key insight**: In production, a planning step produces a task sequence, and a separate execution layer carries it out. Mature systems include re-planning checkpoints.

### Pattern 3: Tool Use

The model interacts with external systems through defined tools with controlled interfaces.

- **Key insight**: Tools are a new kind of software — a contract between deterministic systems and non-deterministic agents. This requires fundamentally rethinking how we write software.
- **Design principles**:
  - Namespace tools by service and resource (e.g. `asana_search`, `jira_projects_search`)
  - Consolidate frequently chained operations into single tools (e.g. `schedule_event` instead of `list_users` + `list_events` + `create_event`)
  - Return meaningful context, not raw data (e.g. `search_logs` returning relevant lines + surrounding context, not all logs)
  - Optimize for tokens — pagination, filters, compression
- **Failure modes**: Weak schema → poor tool selection. Unstable execution layer → workflow failures. Growing tool library → routing/validation challenges.

### Pattern 4: Multi-Agent Collaboration (The Specialized Team)

Distribute work across a network of specialized agents, mirroring human organization.

- **Structure**: Central orchestrator/manager decomposes objectives → assigns sub-tasks to dedicated agents → each agent has narrow prompts, specific tools, appropriate model.
- **When to use**: Work spans multiple domains, requires diverse expertise, benefits from parallel processing.
- **Key insight**: Multi-agent isn't just about capability — it's about reducing concentration of responsibility in a single agent.
- **Evolution path** (from Anthropic): Single agent → routing pattern → specialized agents → multi-agent with shared context → evaluator agents for quality assurance.

### Pattern 5: Human-in-the-Loop

Combine AI execution speed with human judgment for high-stakes decisions.

- **When to use**: Mistakes are expensive, irreversible, or require contextual judgment the model cannot possess.
- **Implementation**: Request human input at decision points, present AI reasoning + recommendation, let human approve/modify/reject.

---

## 3. Anthropic's Key Learnings (From Building Claude Code)

### Start Simple, Scale Intelligently

Single-purpose agents that do one thing well. Gradually develop them as requirements evolve. Simple systems are:
- Cheaper to run (fewer tokens, less compute)
- Easier to debug when things go wrong
- Give clear metrics that tie to business outcomes

### Choose the Right Model for the Job

Balance three factors: capabilities, speed, and cost.

- Complex multi-step coding or financial analysis → most capable model available
- High-volume straightforward tasks → lighter, faster model
- Running simple tasks through premium models is wasteful, slower, and more expensive at scale

### Practice Modular Design

The space moves quickly. Design for modularity so capabilities can evolve without radical redesign.

- Prompts defined in centralized configuration files or libraries
- Tools as discrete reusable modules
- Agents defined as needed, leveraging only the tools/resources needed for their assigned task
- Frameworks like LangGraph or Mastra enable this composition pattern

### Agent Skills

Modular capability packages that agents can leverage when needed, beyond base capabilities.

- Skills can work together on complex tasks and invoke other skills as needed
- In single-agent systems, Skills extend baseline capabilities
- In multi-agent systems, different agents configure different skills based on specialization
- Skills can be updated independently without rewriting agent logic
- Skills can be shared across multiple agents

### Build Observable Systems That Explain Themselves

Agents are inherently black boxes. Beyond standard logging:
- Structured logging with standardized schemas
- Centralized monitoring across sessions
- Traceability of decisions and reasoning paths
- Provenance preservation for debugging and auditing

---

## 4. Tool Design Best Practices (From Anthropic's Engineering Blog)

### The Core Insight

When we traditionally write software, we establish a contract between deterministic systems. Tools are a different kind of software — a contract between deterministic systems and non-deterministic agents. The same inputs can produce different outputs. This requires a fundamentally different design approach.

### Choosing Which Tools to Build

**More tools ≠ better outcomes.** Common error: wrapping existing API endpoints without considering agent affordances.

- Build a few thoughtful tools targeting specific high-impact workflows
- Tools should consolidate functionality — handle multiple operations under the hood
- Examples of consolidation:
  - Instead of `list_users` + `list_events` + `create_event` → `schedule_event` (finds availability and schedules)
  - Instead of `read_logs` → `search_logs` (only returns relevant lines + context)
  - Instead of `get_customer_by_id` + `list_transactions` + `list_notes` → `get_customer_context` (compiles all relevant info at once)
- Each tool must have a clear, distinct purpose

### Namespacing

As tools grow to dozens across multiple servers, namespacing prevents confusion:

- By service: `asana_search`, `jira_search`
- By resource: `asana_projects_search`, `asana_users_search`

The choice between prefix-based and suffix-based namespacing has non-trivial effects on evaluation performance.

### Tool Description & Parameter Design

- Write descriptions for the agent, not for humans. The agent reads them as guidance for when to use the tool.
- Include input examples in parameter descriptions
- Be explicit about edge cases and failure modes
- Avoid vague or overlapping tool purposes

### Evaluation Methodology

1. **Generate evaluation tasks** grounded in real-world use — strong tasks might require dozens of tool calls
2. **Run programmatic evaluations** with simple agentic loops (while-loop wrapping alternating LLM API and tool calls)
3. **Analyze results** — observe where agents get confused, read transcripts, track metrics (runtime, tool calls, token consumption, errors)
4. **Collaborate with agents** — let Claude analyze transcripts and refactor tools. Most of Anthropic's own tool improvements came from this process.

### The Three Pillars (from MCP)

- **Test in loops** — iterate rapidly with evaluations
- **Design for humans** — ergonomic for agents is also intuitive for humans
- **Format like context matters** — because it does

---

## 5. The CLAUSE Framework (State-of-the-Art Multi-Agent)

CLAUSE (Context Learning And Understanding for Symbolic Execution) uses three specialized agents working together, jointly optimized via Lagrangian-Constrained Multi-Agent PPO (LC-MAPPO):

### Agent 1: Subgraph Architect
- Decides what to explore (which knowledge graph edges to expand)
- Manages growth under resource constraints
- Uses information-theoretic edge scoring: `score(e) = I(e|current_context) - cost(e)`
- Greedy expansion with backtracking capability

### Agent 2: Path Navigator
- Discovers reasoning paths through the knowledge graph
- Implements backtracking when paths become invalid
- Uses multi-objective path search (accuracy, length, confidence)
- Beam search with adaptive beam width

### Agent 3: Context Curator
- Selects evidence, manages token budgets, determines stopping conditions
- Evidence scoring: `score(evidence) = relevance × importance / cost`
- Token budget allocation across evidence pieces
- Provenance-preserving outputs

### Joint Optimization

Objective: `max E[R] - λ₁·C_latency - λ₂·C_tokens - λ₃·C_cost`

Agents learn policies jointly. Constraints enforced via Lagrangian multipliers. Multi-agent PPO updates policies jointly. Multipliers adapt based on constraint satisfaction.

**Results**: 39.3% improvement in Exact Match @ Top-1, 18.6% latency reduction, 40.9% lower subgraph growth.

### Resource Constraint Framework

- **Latency Budget**: Maximum number of interaction steps
- **Token Budget**: Maximum context size — dynamic allocation based on information value
- **Cost Budget**: Maximum computational/API cost — cumulative tracking during execution
- **Per-Query Adaptation**: User specifies constraints per query, system adapts without retraining

---

## 6. Advanced Context Engineering (ACE / HumanLayer)

The "frequent intentional compaction" workflow — what makes coding agents work on 300k LOC codebases.

### The Problem

Naive agent usage is like a chatbot: back-and-forth until context fills up, then degradation. Slightly better: restart with more instruction. Best: work in structured cycles with compaction.

### The Workflow: Research → Plan → Implement

**Research Phase:**
- Explore the codebase to understand relevant files, architecture, patterns
- Build a mental (and documented) model of what needs to change
- Output: structured understanding of the problem space

**Plan Phase:**
- Write an explicit plan before executing
- Include: goal, approach, steps, dependencies, risks
- The plan becomes a compact artifact that can seed a fresh session
- Output: plan document

**Implement Phase:**
- Execute the plan step-by-step
- At each compaction checkpoint, distill progress into a structured artifact
- Start fresh sessions with the compacted artifact

### How Compaction Works

**What eats context:**
- File contents
- Error messages and stack traces
- Chat history
- Tool call results
- Previous outputs

**Compaction** = distilling these into structured artifacts:
- Goal (what we're trying to achieve)
- Approach (how we're doing it)
- Steps completed so far
- Current state / failure being worked on
- Next steps

**The key metric**: Keep context utilization at 40-60%. When you exceed this, compact and start fresh.

### Why This Works

LLMs are stateless functions. The contents of your context window are the ONLY lever you have to affect output quality. Optimize your context window for:
1. **Relevant information** — what's needed for the current step
2. **Signal, not noise** — no irrelevant file contents, no redundant tool outputs
3. **Current state** — not the full history, but a compact summary of where you are

---

## 7. Where Pane Stands Today

| Pane Feature | Industry Equivalent | Status |
|---|---|---|
| Persistent memory (pane_remember) | Episodic memory + semantic memory | ✅ Built |
| User profile / philosophy/rules | Agent Skills + CLAUDE.md | ✅ Built |
| Project about + brief | Centralized config for agent context | ✅ Built |
| Tools-first architecture (MCP, codebase tools) | Tool Use pattern | ✅ Built |
| Todo tracking with status | Planning pattern | ✅ Built |
| Handoff documents between sessions | Intentional compaction | ✅ Built |
| Write-time quality gates via user rules | Reflection pattern | ✅ Built |
| Closed-loop discover → persist | Learning from experience | ✅ Built |
| Cross-project knowledge graph | Semantic memory across domains | ✅ Built |
| Session journal + state tracking | Observability | ✅ Built |

---

## 8. Where Pane Can Push Boundaries

### 8.1 Multi-Agent Orchestration (Highest Leverage)

**Current state**: Single agent per session.
**Target**: Supervisor + specialist sub-agents.

**Sub-Agent 1: Planning Agent**
- Decomposes user requests into explicit plans before execution
- Fixes the "agent drifts during long tasks" problem
- Separate Plan phase → Execute phase
- Plan becomes a compact artifact the execution agent can load

**Sub-Agent 2: Reflection Agent**
- Reviews outputs before presenting to the user
- Validates against project rules, catches errors, suggests corrections
- The single highest-leverage structural change per Anthropic

**Sub-Agent 3: Supervisor Agent**
- Decides which sub-agent to dispatch for which task
- Routes to right model + right tools
- Enables model selection by task complexity

### 8.2 Intentional Compaction (Fixing Long Sessions)

**Current state**: Session degrades as context fills up.
**Target**: Research → Plan → Implement cycles with explicit compaction checkpoints.

When context hits ~60%:
1. Write a session-artifact summarizing: goal, approach, completed steps, current state, next steps
2. Save to project memory
3. Start a fresh session loading only the compacted artifact
4. Continue

### 8.3 Tool Consolidation & Namespacing

**Current state**: Flat tool surface.
**Target**: Namespaced, consolidated, deferred-loaded tools.

- Namespace tools by domain (codebase_*, memory_*, project_*)
- Consolidate frequently chained tool calls into composite tools
- Add deferred loading for expensive tools
- Audit for overlapping or redundant tools

### 8.4 Skill-Based Architecture

**Current state**: Monolithic agent context.
**Target**: Composable skill modules loaded on demand.

- A "code review" skill with relevant tools and prompts
- A "project management" skill with todo + memory tools
- A "research" skill with web search + code exploration tools
- Skills loaded on demand, base prompt stays lean and cacheable

### 8.5 Explicit Resource Budgets

**Current state**: No resource constraints.
**Target**: Token/step/cost budgets as first-class parameters.

- Users set token budgets, step limits, cost limits per task
- Agent plans within constraints — selects cheaper models for subtasks, limits exploration depth
- When running out of budget: compact and escalate rather than fail

### 8.6 Observable Chain-of-Thought

**Current state**: Agent reasoning is implicit in outputs.
**Target**: Full reasoning trace visible to users.

- Surface Thought → Action → Observation → Next Thought
- Let users see WHY the agent chose a particular tool or approach
- Make the inner loop visible without requiring API log spelunking

---

## 9. Implementation Roadmap

### Phase 1 — Immediate (Weeks)

1. **Planning Phase**: Before executing, agent writes an explicit plan. User can review and approve. Fixes the "wandering agent" problem immediately.
2. **Tool namespacing + consolidation**: Clean up the tool surface. Fewer, better tools.
3. **Compaction checkpoints**: Auto-compact at 60% context utilization. Continue fresh.

### Phase 2 — Near-Term (Months)

1. **Reflection agent**: After each major output, a review pass validates against project rules, catches errors, suggests corrections before presenting to user.
2. **Skill system**: Decompose the monolithic context into loadable skill modules.
3. **Resource budgets**: Token/step/cost budgets as first-class parameters.

### Phase 3 — Long-Term

1. **Multi-agent supervisor**: Route tasks to specialized sub-agents. Different models for different work.
2. **Sub-agent architecture**: Planning agent, execution agent, reflection agent, memory curator.
3. **Full CLAUSE-style optimization**: Lagrangian-constrained resource allocation across sub-agents.

---

## 10. Key Decisions Locked

1. **Pane's founding thesis is correct**: The architecture around the model matters more than the model itself. The gap is in orchestration, not infrastructure.
2. **Start simple, scale intelligently**: Single-agent → planning phase → reflection pass → multi-agent supervisor. Not all at once.
3. **Tool quality > tool quantity**: Consolidate, namespace, and design tools for agent ergonomics.
4. **Compaction is the key to long sessions**: Keep context utilization at 40-60%. Compact proactively.
5. **Model-router architecture**: Route simple tasks to fast/cheap models, complex reasoning to frontier models. Not all tasks need the same model.
6. **Observe everything**: Build observability into the agent's inner loop. The reasoning trace is the debugging interface.
