---
name: distributed-systems
description: Distributed systems — consistency, consensus, failure modes, message queues, and event-driven architecture. Everything fails all the time. Design for it.
version: 1.0.0
tags: [distributed-systems, consistency, consensus, messaging, event-sourcing, failure]
extends: []
conflicts: []
requires: []
provides: [distributed-systems, messaging, event-sourcing, consensus]
priority: 5
---

# Distributed Systems

## When to use this skill
Activate when:
- Designing a system with multiple services or replicas
- Choosing between consistency models
- Implementing message queues, event buses, or pub-sub
- Designing for failure modes (network partitions, crash recovery)
- Implementing leader election or distributed coordination
- Reasoning about exactly-once vs at-least-once vs at-most-once delivery
- Designing idempotency and deduplication
- Implementing event sourcing or CQRS
- Choosing between orchestration and choreography
- Handling distributed transactions

## First principle: everything fails all the time

In a single process, failure is exceptional. In a distributed system, failure is normal. At any given moment, some percentage of your nodes are down, some percentage of your network links are slow, some percentage of your messages are being retried. The system doesn't work despite failures — it works in the constant presence of failures.

This is not pessimism. It's the physics of distributed computing. A system with 100 nodes, each with 99.9% uptime, experiences a failure somewhere every 8.6 hours on average. The system must function correctly even when parts of it are not functioning at all.

## The fallacies of distributed computing

Everyone designing a distributed system should know these. They are all false:

1. **The network is reliable.** It is not. Packets drop, routes flap, cables are unplugged.
2. **Latency is zero.** It is not. A round trip across the datacenter is ~0.5ms. Across the continent, ~50ms. Across the ocean, ~150ms. And those are the good numbers.
3. **Bandwidth is infinite.** It is not. Saturate a link and everything sharing it suffers.
4. **The network is secure.** It is not. Encrypt everything. Assume every network is hostile.
5. **Topology doesn't change.** It does. Servers come and go. IPs change. DNS changes.
6. **There is one administrator.** There isn't. Different teams manage different parts.
7. **Transport cost is zero.** Serialization, deserialization, and protocol overhead are real.
8. **The network is homogeneous.** It isn't. Different hardware, OSes, protocols, versions.

## Consistency models

### The CAP theorem (and why it's misleading)
CAP says: in the presence of a network partition, choose between Consistency and Availability. This is true but trivial — you can't have both during a partition because the partition prevents them. The useful question is: "when there ISN'T a partition, what does my system do? And when there IS, which tradeoff do I make?"

Most systems are "CP" or "AP" only during a partition. During normal operation, they're both. The real choice is: do you sacrifice latency for consistency (CP) or consistency for latency (AP)?

### Linearizability (strong consistency)
Every read sees the most recent write. Once a write completes, all subsequent reads see it. The system behaves as if there's only one copy of the data. This is the gold standard and the most expensive. Implementations: consensus algorithms (Raft, Paxos), single-leader replication with synchronous replication.

Use when: correctness depends on ordering (banking, auctions, inventory where overselling is catastrophic).

### Sequential consistency
Operations appear to execute in some total order consistent with each node's program order. Less strict than linearizability — allows stale reads from followers. Most replicated SQL databases with async replication provide this.

### Eventual consistency
If no new writes are made, eventually all replicas will converge to the same value. "Eventually" could be milliseconds or hours. The system makes no promise about when.

Use when: availability and partition tolerance matter more than perfect consistency (social media feeds, DNS, CDN cache).

### Causal consistency
Operations that are causally related are seen in order by everyone. Operations that are not causally related can be seen in any order. "I posted a comment, then I see it; but I might see my friend's post before or after someone else's, as long as they're unrelated."

Stronger than eventual, weaker than sequential. Good fit for collaborative editing, chat.

### Read-your-writes
After you write, you will see your own write. Other users might not see it yet. Minimum bar for a usable system — if users can't see what they just did, they think the system is broken.

## Consensus

Consensus is getting a set of nodes to agree on a value. It's the hardest problem in distributed systems. You cannot solve it with unbounded time in an asynchronous system with failures (FLP impossibility). You can solve it with timeouts (which is what we do in practice).

### When you need consensus
- **Leader election**: Only one node should be the leader. Consensus ensures agreement on who.
- **Atomic broadcast**: Messages are delivered to all nodes in the same order.
- **Distributed locking**: Ensuring only one node holds a lock.
- **Replicated state machines**: Every node applies the same operations in the same order.

### Raft (the pragmatic choice)
Raft is designed to be understandable. Key concepts:
- **Leader**: One node accepts client requests and replicates to followers.
- **Term**: Monotonically increasing. Each term has at most one leader.
- **Log**: Ordered sequence of entries. Leader appends, followers replicate.
- **Commit**: Entry is committed when replicated to a majority. Committed entries survive leader changes.
- **Election**: If followers don't hear from leader (timeout), they become candidates and request votes. Majority wins.

### When NOT to use consensus
- If a single database provides the consistency you need (let PostgreSQL handle it)
- If eventual consistency is good enough (use a message queue)
- If you're coordinating state that can be partitioned (use consistent hashing)

Don't build consensus yourself. Use etcd, ZooKeeper, or embed Raft via a library.

## Message queues and event streams

### Message queue vs. event stream
- **Message queue** (RabbitMQ, SQS): Messages are consumed once, then deleted. For commands and tasks: "send email," "resize image."
- **Event stream** (Kafka, Pulsar): Messages are persisted in order. Multiple consumers can read. For events: "order placed," "payment received."

### Delivery guarantees
- **At most once**: Message is delivered zero or one times. No retry. Fastest. Use when losing a message is acceptable (metrics, non-critical telemetry).
- **At least once**: Message is delivered one or more times. Retry on failure. Use when losing a message is unacceptable but duplicates can be handled (with idempotency).
- **Exactly once**: Message is delivered exactly once. Hardest. Requires idempotent consumers AND transactional producers. Use when duplicates cannot be tolerated (financial transactions, inventory decrement).

### Idempotency
The key to at-least-once systems. An operation is idempotent if applying it multiple times has the same effect as applying it once.
- `SET balance = 100` is idempotent
- `SET balance = balance + 100` is NOT idempotent (if retried, balance goes up again)
- `INSERT INTO payments (id, amount) VALUES ('pay_123', 100) ON CONFLICT (id) DO NOTHING` IS idempotent

Design for idempotency: use unique keys, conditional updates, deduplication.

### Ordering
- **Partition-level ordering**: Within a Kafka partition, messages are in order. Across partitions, no ordering. Use partition keys to group related events.
- **Global ordering**: Single partition, or consensus-based total order. Expensive. Do you really need it?
- **Causal ordering**: Use vector clocks or explicit dependencies. "Message B depends on message A — don't process B until A is done."

### Dead letter queues
Messages that fail repeatedly go to a DLQ. Don't lose them. Don't retry forever. After N attempts (3-5), move to DLQ. Monitor DLQ. Alert on growth. Have a process for inspecting and replaying.

### Backpressure
When the consumer is slower than the producer:
- **Drop**: Discard new messages. Acceptable for telemetry, not for orders.
- **Block**: Producer waits. Can cascade upstream.
- **Buffer**: Queue grows. Eventually runs out of memory/disk.
- **Throttle**: Slow the producer. Flow control, rate limiting.

The consumer should control the pace. Pull-based consumers (Kafka) handle this naturally. Push-based (RabbitMQ) needs prefetch limits.

## Event-driven architecture

### Events vs. commands
- **Event**: Something happened. Past tense. "OrderPlaced", "PaymentReceived". Immutable fact.
- **Command**: Request to do something. Imperative. "PlaceOrder", "ProcessPayment". Can be rejected.

Events are facts that cannot be disputed. Commands are requests that can be denied. Build systems around events, use commands for the entry point.

### Event sourcing
Store events, not current state. Current state is derived by replaying events: `Account` = `account_created` + `deposited($100)` + `withdrew($30)` + `deposited($50)` → balance = $120.

Advantages:
- **Complete audit trail**: Every change is an event. No mystery about how state got this way.
- **Temporal queries**: What was the account balance on March 3rd?
- **Projections**: Build multiple read models from the same events (current balance, monthly summary, fraud analysis).
- **Debugging**: Replay events to reproduce bugs.

Challenges:
- **Event schema evolution**: Events are forever. You can add fields, but can't remove or rename. Have a strategy.
- **Snapshots**: Replaying 10 years of events is slow. Periodically snapshot state, replay from snapshot.
- **Deletion**: Events can't be deleted (they're facts). GDPR "right to erasure" requires cryptographic shredding or forgetting the encryption key.

### CQRS (Command Query Responsibility Segregation)
Separate read and write models.
- **Write model**: Validates commands, produces events. Optimized for consistency and correctness.
- **Read model**: Consumes events, builds denormalized views. Optimized for query performance.

Use when read and write patterns are fundamentally different. Don't use for CRUD — it adds complexity without benefit.

### Orchestration vs. choreography
- **Orchestration**: A central coordinator tells each service what to do. "Order Service: create order → Payment Service: charge card → Inventory Service: reserve items → Shipping Service: ship." Easy to understand the flow. Single point of failure. Sagas implement distributed transactions this way.
- **Choreography**: Each service reacts to events independently. "Payment Service sees OrderPlaced → charges card → emits PaymentReceived. Inventory Service sees PaymentReceived → reserves items → emits ItemsReserved." Decentralized. Hard to understand the end-to-end flow.

Use orchestration for business processes you need to understand and modify as a whole. Use choreography for loosely coupled services that evolve independently.

## Distributed transactions

### Why 2PC is usually wrong
Two-phase commit: coordinator asks all participants "can you commit?", all say yes, coordinator says "commit." Participants are locked the entire time. If the coordinator crashes, locks are held indefinitely. This is why most distributed systems don't use 2PC for application-level transactions.

### Sagas
A saga is a sequence of local transactions, each with a compensating transaction for rollback:
1. Create order (compensation: cancel order)
2. Reserve inventory (compensation: release inventory)
3. Charge payment (compensation: refund payment)
4. Ship items (compensation: return label — can't undo a shipment)

Each step is a local transaction. Each step publishes an event. If a step fails, compensations run in reverse order. Sagas are eventually consistent — between step 3 and step 4, the payment is charged but items aren't shipped. That's fine; the system will converge.

### Outbox pattern
The problem: you need to update the database AND publish an event atomically. If the database update succeeds but the event publish fails, the system is inconsistent. If the event publish succeeds but the database update fails, downstream services act on stale data.

The solution: write the event to an `outbox` table in the same transaction as the business data. A separate process reads the outbox and publishes events. At-least-once delivery to the message broker.

```
BEGIN;
  UPDATE orders SET status = 'placed' WHERE id = 123;
  INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
    VALUES ('evt_456', 'order', 123, 'OrderPlaced', '{"order_id": 123}');
COMMIT;
-- Outbox publisher picks up evt_456 and sends to Kafka/RabbitMQ
```

## Failure patterns

### Timeout
The most basic failure: a response never arrives. Always set timeouts. "No timeout" means "wait forever" which means "the thread/goroutine/connection is lost until restart."

### Retry storm
A downstream is slow. Clients timeout and retry. Now there are 2x requests. Both timeout, retry again. 4x. The downstream, which was just slow, is now crushed under the retry load. Solution: exponential backoff with jitter, circuit breaker.

### Split brain
Two nodes both think they're the leader. Both accept writes. Data diverges. Eventually they reconnect and there's a conflict. Solutions: fencing tokens (each leader gets a monotonically increasing number; the storage layer rejects writes with an old token), or consensus (only a node with a majority vote is leader).

### Cascading failure
Service A calls Service B calls Service C. Service C is slow → Service B's thread pool fills → Service B is slow → Service A's thread pool fills → everything is down. Solutions: circuit breakers, bulkheads, timeouts at every level, graceful degradation.

### Thundering herd
A cache expires. 10,000 requests simultaneously hit the database for the same key. One would have been fine. 10,000 crushes it. Solutions: stale-while-revalidate (serve stale data while refreshing), request coalescing (only one request fetches, others wait), jitter on cache expiry.

### Poison message
A message in the queue that can never be processed successfully. The consumer tries, fails, retries, fails, forever. Blocks the queue for all other messages. Solution: dead letter queue after N attempts. Don't retry indefinitely.

### Garbage collection pause
A GC pause stalls the process for seconds. To the rest of the system, the node has disappeared. Leaders lose their lease, connections timeout, heartbeats are missed. Solutions: tune GC, use languages with predictable latency (Go, Rust), set timeouts generously enough to ride out pauses but not so generously that real failures go undetected.

## Time in distributed systems

### Clocks are not reliable
- System clocks drift. A few seconds per day is normal.
- Clocks can jump (NTP correction, manual adjustment).
- Different machines have different times.
- A clock reading from machine A and machine B 1 second apart tells you nothing about which event happened first.

### Lamport clocks
Logical clocks, not wall clocks. Each node has a counter. Increment on every event. When sending a message, include the counter. When receiving, set counter to max(local, received) + 1. Gives a partial order: if A happened-before B, A's timestamp < B's timestamp. The converse is not true.

### Vector clocks
Extension of Lamport clocks. Each node maintains a vector: `[A: 3, B: 5, C: 1]` meaning "I've seen 3 events from A, 5 from B, 1 from C." Enables detection of concurrent events (neither happened-before the other). Used in Dynamo-style databases for conflict resolution.

## When NOT to distribute

Distributed systems are harder than single-node systems. Before distributing:
1. Can a single, well-provisioned machine handle the load? (Yes, for most applications.)
2. Can you scale vertically first? (Bigger machine > distributed complexity.)
3. Is the operational cost of running multiple services justified?

A monolith that fits on one server is not a failure. It's the correct design for most systems. Distribute when you must, not because it's fashionable.

## Design checklist
When designing a distributed interaction:
- [ ] What is the consistency requirement? What happens if it's violated?
- [ ] How is this operation made idempotent?
- [ ] What is the retry strategy? Backoff? Max attempts?
- [ ] What happens when a message is lost? Duplicated? Delayed? Reordered?
- [ ] What happens during a network partition? Which side continues?
- [ ] What happens when a node crashes and recovers?
- [ ] Are timeouts set at every hop? Are they coordinated (timeout of A > timeout of B it calls)?
- [ ] Is there a circuit breaker or rate limiter?
- [ ] How is the system monitored? What metrics tell you it's healthy?
- [ ] What is the recovery procedure? Can a human intervene?

## Anti-patterns

### Assuming the happy path
"The network will be up, the database will respond in 5ms, and messages will arrive in order." No. Design for the unhappy path first. The happy path is easy.

### Distributed locking as a band-aid
"I'll just use a distributed lock to prevent concurrent access to this shared resource." Distributed locks are hard to get right (split brain, expiry, fencing). Can you design the resource so it doesn't need locking? Idempotent writes, conflict-free replicated data types (CRDTs), partitioning.

### Manual failover
"If the primary goes down, I'll manually fail over." By the time you wake up at 3 AM, the system has been down for hours. Automate failover. Test it regularly. The failover system should be exercised more often than the failure it protects against.

### Exactly-once without idempotency
"We use Kafka transactions so delivery is exactly-once." Kafka transactions provide exactly-once from Kafka's perspective. Your consumer still needs to be idempotent — if the transaction commits but your consumer crashes before acknowledging, the message is redelivered. The consumer must handle this.

### Ignoring backpressure
"The queue will buffer everything." The queue has finite storage. When it fills, messages are lost or producers are blocked. Backpressure must be handled end-to-end.

### Using the database as a queue
`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED` — this works until it doesn't. At scale, the polling overhead, lack of push notifications, and contention on the jobs table become bottlenecks. Use a message queue for messages, a database for data.
