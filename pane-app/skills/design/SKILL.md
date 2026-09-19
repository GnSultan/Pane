---
name: design
description: Design before code — API design, data modeling, component boundaries, and tradeoff analysis. Good design is the cheapest way to prevent bad code.
version: 1.0.0
tags: [design, api-design, data-modeling, patterns, tradeoffs]
extends: []
conflicts: []
requires: []
provides: [design, api-design, data-modeling, system-design]
priority: 5
---

# Design

## When to use this skill
Activate when:
- Designing a new API, module, or subsystem
- Making a data model decision
- Choosing between design patterns
- Evaluating architectural tradeoffs
- Writing a design document or RFC
- Reviewing a design for flaws or over-engineering
- Deciding where a boundary should live

## First principle: design is compression

Good design compresses the problem space. A well-designed module has a small surface area and a large capability. The API tells you what you need to know and nothing more. Bad design decompresses — every use requires knowing internal details, every change ripples across the system.

Before designing, ask: "What does the caller need to know, and only that?"

## The design document

For any change that affects multiple modules or introduces a new abstraction, write a one-page design doc. The format:

### 1. Problem
What problem are we solving? State it in two sentences. If you can't, you don't understand it yet. Include: who is affected, what the current experience is, and why it matters.

### 2. Constraints
What can't change? Performance budgets, API compatibility, database technology, deployment model, team size, timeline. Constraints aren't limitations — they're the shape of the solution.

### 3. Proposed solution
One paragraph and a diagram (ASCII is fine). What changes? What's new? What goes away? Include the key abstraction and the data flow.

### 4. Alternatives considered
For each alternative: what it is, why it wasn't chosen. This is the most important section. It proves you didn't pick the first idea. It documents the tradeoffs for future readers.

### 5. Risks and unknowns
What could go wrong? What don't you know? What assumptions are you making? Be honest — undiscovered risks become incidents.

### 6. Migration path
If this changes existing behavior: how do existing users move to the new design? Can they migrate incrementally? Is there a deprecation period?

## API design

### REST, RPC, or GraphQL?

**REST** when:
- Resources map cleanly to CRUD operations
- You need HTTP caching (CDNs, proxies)
- Multiple clients with different needs consume the same endpoints
- The domain is document/resource-oriented (users, posts, orders)

**RPC** when:
- The domain is action-oriented (sendEmail, processPayment, runBackup)
- You need precise control over what's sent and received
- You're designing internal service-to-service communication
- The operations don't map cleanly to resources

**GraphQL** when:
- Clients have wildly different data needs for the same resources
- You have many UI surfaces that need different projections
- Network bandwidth is constrained (mobile, slow connections)
- You're willing to pay the complexity cost (caching, query optimization, N+1)

### API design principles

**Return exactly what's needed.** Don't return the full user object when the caller only needs the name. Don't add fields "just in case." Every field you return is a contract you must maintain.

**Make the simple thing easy, the complex thing possible.** The default path should require minimal arguments and produce the expected behavior. Advanced use cases should be opt-in, not required reading.

**Errors are part of the API.** Design error responses as carefully as success responses. Include: error code (machine-readable), message (human-readable), and context (what was happening when it failed). Never return "Something went wrong."

**Version with intention.** Don't version prematurely. When you must: prefer header-based versioning over URL-based. URL versions (`/v2/users`) proliferate across every route. A header (`Accept-Version: 2`) is a single point of change.

**Name for the caller, not the implementation.** `getUserPosts` not `selectFromPostsWhereUserId`. The API is a contract with the outside world, not a mirror of your database schema.

### API anti-patterns

- **Boolean trap.** `fetchUsers(true, false, true)` — nobody knows what these mean. Use options objects: `fetchUsers({ includeDeleted: true, sortBy: 'name' })`.
- **Stringly-typed.** Using strings where enums or constants belong. `setStatus('active')` → `setStatus(Status.Active)`. Typos in strings are runtime errors; typos in enums are compile errors.
- **Returning different shapes.** A function that returns `User` on success and `{ error: string }` on failure. Use a Result type or throw. Union return types force every caller to discriminate.
- **Combinatorial explosion.** `fetchUsers({ name?, email?, phone?, address?, city?, state? })` — 64 possible call signatures. Group related filters into objects: `fetchUsers({ byName: ..., byContact: ... })`.

## Data modeling

### Normalize for integrity, denormalize for performance — and know which you're doing

Start normalized. Every fact stored once. No duplication. This is the source of truth. Denormalize only when you have a measured performance problem, and document every denormalization: what data is duplicated, where the source of truth lives, and how consistency is maintained.

### Schema design checklist

- **Every entity has a clear primary key.** UUID for distributed systems, auto-increment for single-DB, ULID if you need time-ordering.
- **Foreign keys are explicit.** If table A references table B, the database knows about it. Application-level "foreign keys" are bugs waiting to happen.
- **Timestamps are UTC.** Always. Store with timezone awareness. Convert to local time only at the presentation layer.
- **Soft deletes have a strategy.** If you use `deleted_at`, every query must filter it. If you forget once, deleted data resurfaces. Consider: is soft-delete actually needed, or are you just afraid of DELETE?
- **Migrations are reversible.** Every `up` has a `down`. If you can't reverse it, document why in the migration comment.
- **Enums are enums.** Don't use strings for states that have a fixed set of values. Use CHECK constraints or enum types. The database should reject invalid states, not just the application.

### Modeling relationships

- **One-to-many**: Foreign key on the "many" side. Standard. No surprises.
- **Many-to-many**: Join table. Always. Don't use arrays or JSON columns for relationships you'll query.
- **One-to-one**: Foreign key with UNIQUE constraint. Consider: is this really one-to-one, or should these be columns on the same table?
- **Polymorphic**: Avoid. If you must: use separate join tables per type, not a single `parent_type` + `parent_id` column. The latter prevents foreign keys and referential integrity.

### When to use JSON columns

Use JSON columns when:
- The data is a document, not a set of queryable fields
- The schema varies per row and you can't normalize
- You always read and write the entire blob
- You never need to filter, sort, or aggregate by fields inside the JSON

Don't use JSON columns when:
- You'll query `WHERE metadata->>'status' = 'active'` — that's a column
- The data has relationships to other tables — those are foreign keys
- You need indexes on the contents — JSON indexes are a last resort

## Component and module design

### The boundary principle
A module boundary is a contract. Everything inside the boundary can change freely. Everything outside depends only on the contract. If changing implementation details breaks callers, the boundary is wrong.

### Cohesion: things that change together, live together
If changing feature A always requires changing files B, C, and D, those files belong in the same module. If files E and F never change when A changes, they don't belong there. Cohesion is about change frequency, not conceptual similarity.

### Coupling: depend on what's stable
Depend on interfaces, not implementations. Depend on things that change less often than you. The database schema is more stable than a UI component. A protocol is more stable than a library. The standard library is more stable than a framework. Depend in the direction of stability.

### The new module test
Before creating a new module, directory, or package, answer:
1. Does it have a clear, one-sentence purpose that's different from existing modules?
2. Will it be used by at least two other modules?
3. Is its interface smaller than its implementation?
4. Can you name it without "utils," "common," "shared," or "misc"?

If you answered no to any, put the code in an existing module.

### Naming modules
Good: `auth`, `billing`, `search`, `notifications` — you know exactly what's inside.
Bad: `utils`, `helpers`, `common`, `shared`, `misc` — these are attractors for unrelated code. Every project starts with one `utils.ts`. Five years later it's 4000 lines of everything.

## Design patterns

### Use patterns to communicate, not to impress
Patterns are a shared vocabulary. "This is an Observer" communicates more in two words than three paragraphs of explanation. Use the name when the pattern fits. Don't force a pattern where the code is clearer without it.

### When to reach for common patterns

**Strategy**: When you have multiple algorithms for the same task and need to swap them at runtime. Payment processors, compression algorithms, auth providers.

**Factory**: When object creation is complex enough to distract from the caller's intent. DI containers, polymorphic creation, conditional instantiation.

**Observer/Event**: When multiple things need to react to the same event and the event source shouldn't know about them. Logging, metrics, cache invalidation.

**Decorator**: When you need to add behavior without modifying the original or when the addition is orthogonal. Logging, timing, retry, auth — cross-cutting concerns.

**Repository**: When you want to abstract data access behind a collection-like interface. Useful for testing (swap real DB for in-memory) but adds indirection — don't use if you're never swapping implementations.

### When NOT to use patterns
- When the code is clearer without the pattern
- When you're using the pattern to feel "proper" rather than to solve a problem
- When the pattern adds more code than it removes
- When only one person on the team understands the pattern
- When the language already provides the capability (Java's Observer is unnecessary in JS with EventEmitter)

## Tradeoffs

### Every design decision is a tradeoff. Name yours.

| You gain | You lose |
|---|---|
| Abstraction | Indirection — harder to follow the code |
| Flexibility | Complexity — more things to configure |
| Performance | Simplicity — caching, denormalization, clever code |
| Durability | Latency — fsync, replication, consensus |
| Consistency | Availability — CAP theorem isn't negotiable |
| Type safety | Velocity — more code to write and change |
| Microservices | Operational complexity — network, debugging, deployment |
| Monolith | Independent scaling — everything scales together |

The right answer isn't "always X." It's "X because Y, and we accept Z as the cost."

### The rule of three
Don't abstract on the first use. Don't abstract on the second. Abstract on the third. Two cases might be coincidence. Three is a pattern. Abstracting too early locks you into the wrong abstraction. Abstracting too late duplicates code. Three is the sweet spot.

## Anti-patterns

### Over-engineering
Building for hypothetical future requirements. "We might need to support multiple databases" → abstract data access layer before you have a second database. "We might scale to millions of users" → microservices for a prototype. Solve today's problems with today's code. Tomorrow's problems will be different from what you imagine.

### Under-designing
No boundaries, no contracts, everything imports everything. "We'll clean it up later." Later never comes. The minimum viable design is: clear module boundaries, explicit contracts between them, and a data model that won't need a migration apocalypse to fix.

### Analysis paralysis
Spending more time deciding than implementing. For reversible decisions (library choice, file structure, naming), decide fast and move on. For irreversible decisions (database technology, API contract, data format), invest the time.

### Gold-plating
Continuing to refine a design after it's good enough. The last 10% of polish costs 50% of the time. Ship when the design solves the problem. Perfection is infinite — completion ships.

### Resume-driven design
Choosing technologies and patterns because they look good on a resume, not because they solve the problem. Kafka for 100 messages/day. Kubernetes for a single server. Machine learning for a rules engine. Use the simplest thing that works.
