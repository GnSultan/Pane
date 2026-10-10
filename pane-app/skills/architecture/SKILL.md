---
name: architecture
description: Architecture decisions — ADRs, deployment patterns, scaling strategies, and system structure. Architecture is what you can't grep for.
version: 1.0.0
tags: [architecture, adr, deployment, scalability, patterns]
extends: []
conflicts: []
requires: []
provides: [architecture, adr, deployment, scalability]
priority: 5
---

# Architecture

## When to use this skill
Activate when:
- Making a decision that will be hard to change later
- Writing an Architecture Decision Record (ADR)
- Choosing between monolith, modular monolith, or microservices
- Designing deployment strategy or infrastructure
- Evaluating scaling approaches
- Reviewing system topology or service boundaries
- Planning database strategy (SQL, NoSQL, polyglot)

## First principle: architecture is what you can't grep for

You can grep for function calls, import paths, variable names. You cannot grep for: "what happens when this service is down," "which data must be consistent," "what is the blast radius of this change." Architecture is the invisible structure — the constraints, the failure modes, the coupling that isn't in the code. Document it or it doesn't exist.

## Architecture Decision Records (ADRs)

Every significant architectural decision gets an ADR. An ADR is a short document (one page) that captures: what we decided, why, and what the alternatives were. ADRs are immutable — you don't edit an ADR, you supersede it with a new one.

### ADR template

```markdown
# ADR-001: [Title — a noun phrase, not a sentence]

**Status**: Proposed | Accepted | Deprecated | Superseded by ADR-XXX
**Date**: YYYY-MM-DD
**Deciders**: [names]

## Context
What is the problem we're solving? What constraints are we operating under?
Include enough background that someone joining two years from now understands WHY.

## Decision
What did we decide to do? Be specific. "We will use X for Y with Z constraints."

## Alternatives considered
For each: what was the alternative, why was it rejected?
This proves the decision was intentional, not the default.

## Consequences
### Positive
What becomes easier? What risks are mitigated? What capabilities do we gain?

### Negative
What becomes harder? What new risks do we introduce? What is the maintenance cost?
Be honest — acknowledging tradeoffs is the point of an ADR.

## Mitigations
For each negative consequence, how are we mitigating it?
```

### When to write an ADR
- Choosing between two or more viable approaches
- Introducing a new technology or dependency
- Changing the data model in a way that affects multiple services
- Setting a convention that the whole team must follow
- Deciding on deployment or infrastructure strategy

### When NOT to write an ADR
- The decision is obvious and uncontroversial
- The decision is easily reversible
- It's a code-level implementation detail, not an architectural concern

## Monolith, modular monolith, or microservices?

### Monolith
**When**: Small team (1-5), early stage, simple domain, tight coupling between features.
**Gains**: Simple deployment, easy debugging, transactional consistency, fast local development.
**Costs**: Scaling is all-or-nothing, coupling accumulates, deployment coordination, technology lock-in.

### Modular monolith
**When**: Growing team (5-20), maturing domain, want service boundaries without operational cost.
**Gains**: Clear boundaries enforced by the compiler (not the network), easy refactoring across modules, single deployment, transactional consistency across modules.
**Costs**: Requires discipline to maintain boundaries, can't independently scale modules, technology lock-in.

The modular monolith is the most underrated architecture. You can extract a module to a service later when you have data that PROVES it needs independent scaling. You cannot un-extract a service back into the monolith.

### Microservices
**When**: Large team (20+), independent feature teams, clear domain boundaries, different scaling needs per component, different technology needs per component.
**Gains**: Independent deployment, independent scaling, technology freedom, team autonomy, fault isolation.
**Costs**: Network latency, eventual consistency, distributed debugging, deployment complexity, operational overhead, data duplication, integration testing is hard.

### The extraction pattern
Don't start with microservices. Start with a modular monolith. When a module consistently:
1. Changes for different reasons than the rest of the system
2. Has different scaling requirements
3. Is owned by a different team
...then extract it. The extraction is surgical: one module at a time, with measurable justification.

## Communication patterns

### Request-response (synchronous)
**When**: The caller needs an answer to proceed. CRUD operations, auth checks, validation.
**Tools**: HTTP/REST, gRPC, GraphQL.
**Risks**: Cascading failures (timeout in service A causes timeout in service B causes timeout in service C). Mitigate with: timeouts, circuit breakers, retries with backoff, and never chaining more than 2 synchronous calls deep.

### Event-driven (asynchronous)
**When**: The caller doesn't need an immediate answer. Notifications, audit logs, cache invalidation, eventual consistency.
**Tools**: Message queues (RabbitMQ, SQS), event streams (Kafka, Kinesis), pub/sub (Redis, NATS).
**Risks**: Eventual consistency bugs, duplicate events, out-of-order delivery, debugging across async boundaries. Mitigate with: idempotency keys, event ordering where needed, correlation IDs on every message, dead-letter queues.

### When to use each

| Synchronous | Asynchronous |
|---|---|
| User is waiting for the answer | User doesn't need the answer now |
| Consistency is required (banking) | Eventual consistency is acceptable (caching) |
| Simple flow, few services | Complex flow, many services |
| Must know if it succeeded before continuing | Can retry later if it fails |

### The hybrid reality
Most systems use both. Synchronous for the critical path, asynchronous for the side effects. The key: know which is which and document the boundaries. "Order creation is synchronous. Email confirmation is asynchronous and can be delayed."

## Deployment

### Deployment strategies

**Rolling**: Replace instances one at a time. Zero downtime if you have multiple instances. Simple. Default choice.

**Blue-green**: Deploy the new version alongside the old, switch traffic all at once. Instant rollback (switch back). Costs double infrastructure during deploy. Good for high-risk deployments.

**Canary**: Route a small percentage of traffic to the new version, increase gradually. Catch problems before they affect everyone. Requires traffic routing infrastructure and good observability.

**Feature flags**: Deploy code behind a flag, enable per-user or per-percentage. Decouples deploy from release. Adds complexity — every flagged path must be testable in both states. Clean up flags aggressively.

### Environment parity
Dev, staging, and production should be as identical as possible. Differences in database versions, OS, memory limits, or network topology will produce bugs that only appear in production. Containerize everything. Use the same image in every environment. Only configuration changes.

### Configuration over environment variables
Environment variables are the boundary between code and deployment. Every value that differs between environments (URLs, keys, feature flags, limits) lives in environment variables. Never hardcode an environment-specific value. Never commit a .env file with secrets.

## Database strategy

### SQL (relational)
**When**: Data is structured, relationships matter, consistency is critical, you need ad-hoc queries.
**Examples**: PostgreSQL, MySQL, SQLite (for embedded).
**Sweet spot**: Most applications. Start here.

### NoSQL (document)
**When**: Schema varies per document, you read/write entire documents, relationships are minimal.
**Examples**: MongoDB, CouchDB, DynamoDB.
**Sweet spot**: Content management, user profiles, configuration stores.

### NoSQL (key-value)
**When**: Simple key-based access, high throughput, low latency.
**Examples**: Redis, DynamoDB, RocksDB.
**Sweet spot**: Caching, session stores, rate limiting, feature flags.

### NoSQL (columnar)
**When**: Write-heavy, time-series, append-only, analytics on large datasets.
**Examples**: Cassandra, ClickHouse, TimescaleDB.
**Sweet spot**: Metrics, logs, event stores, time-series data.

### When to go polyglot
"Use the right tool for the job" sounds wise. In practice, every additional database technology is:
- Another thing to operate, monitor, back up, and restore
- Another set of failure modes
- Another skill requirement for the team
- Another integration point for testing

One database technology is cheaper than two. Two is cheaper than three. Only add a new database when the current one provably cannot meet a measured requirement.

## Scaling

### Vertical first, horizontal when necessary
A bigger server is simpler than distributed systems. If your database fits in memory on the largest available instance, you're done. The complexity of sharding, replication, and distributed consensus is only worth it when you've exhausted vertical scaling.

### Caching layers (in order of impact)
1. **Client-side cache**: Browser cache, CDN, app-level cache. Cheapest, highest impact. Cache headers on static assets, CDN for API responses.
2. **Application cache**: In-memory cache (Redis/Memcached) for computed results, database query results, session data.
3. **Database cache**: Connection pooling, query caching, materialized views. The database already caches — measure before adding your own layer.
4. **Denormalization**: Pre-compute and store results. Accept staleness for speed. Document the staleness window.

### When to cache
Cache when: data is read often and changes rarely, computing it is expensive, and staleness is acceptable.
Don't cache when: data changes constantly, staleness is unacceptable, the cache miss rate is high, or you haven't measured the bottleneck.

### Cache invalidation
The two hard problems: naming things and cache invalidation. Strategies:
- **TTL**: Simple, predictable staleness. Good for data that changes on a schedule.
- **Write-through**: Update cache on write. Cache is always fresh. Cost: every write hits both DB and cache.
- **Write-behind**: Update cache on write, persist to DB asynchronously. Fast writes, risk of data loss.
- **Event-driven invalidation**: Cache subscribes to change events. Cache is fresh, but requires event infrastructure.

Default: TTL with reasonable staleness window. Add complexity only when measured and necessary.

### Database scaling
- **Read replicas**: Offload reads. Accept replication lag. Good for read-heavy workloads.
- **Sharding**: Split data across databases by a partition key. Every query must include the partition key. Cross-shard queries are expensive or impossible. Choose the shard key carefully — changing it requires reshuffling all data.
- **Connection pooling**: Don't open a new connection per request. Use a pool. Set max connections based on database limits.

## Anti-patterns

### Resume-driven architecture
Choosing Kafka because you want Kafka on your resume. Choosing microservices because "everyone's doing it." Every architectural decision should be justified by the problem, not by your career goals.

### Architecture astronauts
Designing for scale that won't materialize. "What if we have 100 million users?" Build for the scale you have, with a plan for the scale you might have. The plan costs a document. The premature implementation costs months.

### Big Design Up Front (BDUF)
Designing the entire system before writing any code. Requirements will change, assumptions will be wrong, and the design won't survive contact with reality. Design enough to start, then iterate.

### No design at all
"No time for design, we need to ship." Produces a system where everything depends on everything, the data model is a series of accidents, and every change is a minefield. The minimum viable design is: boundaries, contracts, data model. Without these, you're not moving faster — you're borrowing time at predatory interest rates.

### Single point of failure
One database, one server, one queue, one cache. Every component is a single point of failure until proven otherwise. For each component, ask: "What happens if this goes down?" If the answer is "the entire system is down," you have work to do.

### Technology lock-in without an escape plan
Using cloud-specific services (DynamoDB, SQS, Lambda) is fine — they solve real problems. But document what it would take to migrate away. If the migration cost is infinite, the decision is irreversible. Irreversible decisions need more scrutiny than reversible ones.
