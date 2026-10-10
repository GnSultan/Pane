---
name: database
description: Database design, schema migrations, query optimization, indexing, and transactions. Reality has no undo — databases are where mistakes become permanent.
version: 1.0.0
tags: [database, sql, schema, migrations, indexing, transactions]
extends: []
conflicts: []
requires: []
provides: [database, sql, schema-design, migrations]
priority: 5
---

# Database

## When to use this skill
Activate when:
- Designing or modifying a database schema
- Writing migrations
- Debugging slow queries
- Choosing indexes
- Reasoning about transactions and isolation levels
- Modeling relationships (1:1, 1:N, M:N)
- Choosing between SQL and NoSQL for a use case
- Planning data migrations or backfills
- Designing audit trails or soft deletes
- Handling concurrent writes

## First principle: reality has no undo

Code can be redeployed, reverted, restarted. A bad migration that drops a column, corrupts data, or locks a table for hours — that's permanent. The database is the only part of the system where a mistake at 3 AM cannot be fixed by `git revert` and a deploy. Everything in this skill flows from that reality.

Every migration can be reversed. Every destructive operation is a multi-step process with verification windows. Every query on a production table has been EXPLAINed. This is not process for its own sake — it's because the database is the one place where "move fast and break things" doesn't apply.

## Schema design

### Naming conventions
- **Tables**: plural, snake_case. `users`, `order_items`, `subscription_events`.
- **Primary keys**: `id` (or `user_id` if it's a meaningful FK). UUIDs for distributed systems, bigint sequences for single-writer.
- **Foreign keys**: `{referenced_table_singular}_id`. `user_id` referencing `users.id`.
- **Timestamps**: `created_at`, `updated_at`, `deleted_at` (if soft-deleting). Always UTC.
- **Boolean columns**: `is_` prefix. `is_active`, `is_deleted`, `is_verified`.
- **JSON columns**: `_meta` or `_data` suffix. `preferences_meta`, `attributes_data`. Signals "this is structured but not relational."
- **Enum-like columns**: singular noun. `status`, `role`, `type`. NOT `statuses` or `roles`.

### Column types — choose deliberately
- **Integers**: `bigint` for PKs by default. `integer` is 2 billion — you'll hit it. `smallint` for enums that will never exceed 32K.
- **Text**: `text` not `varchar(n)`. There's no performance difference in modern PostgreSQL and `varchar(n)` creates a constraint you'll later regret. If you need length limits, enforce in application logic or with a CHECK constraint.
- **Timestamps**: `timestamptz` (not `timestamp`). Always store with timezone. You will have users in different timezones.
- **Money**: `numeric(19,4)` or integer cents. Never `float` or `double`. Floating-point arithmetic will silently lose pennies.
- **UUIDs**: `uuid` type in PostgreSQL. Store as native UUID, not text. Half the storage, indexable.
- **Booleans**: `boolean`. Not `tinyint(1)`, not `char(1)`. Use the type the database provides.

### Normalization vs. denormalization
Normalize by default. Third normal form is the starting point, not the goal. Denormalize when:
1. You've measured the problem (not guessed)
2. The JOIN is the bottleneck in production (not in your head)
3. The denormalized data has a clear source of truth and a clear refresh mechanism
4. Staleness is acceptable and documented

Most premature denormalization comes from fear of JOINs. Modern databases are very good at JOINs. Measure first.

### Modeling relationships

**One-to-many**: Foreign key on the "many" side. This is the only correct answer.

```sql
CREATE TABLE orders (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Many-to-many**: Junction table. Always. Don't use arrays, don't use JSON columns for relationships you'll query.

```sql
CREATE TABLE team_members (
  team_id bigint NOT NULL REFERENCES teams(id),
  user_id bigint NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
```

The junction table can carry its own data (role, joined_at). This is a feature, not a workaround.

**One-to-one**: Foreign key with UNIQUE constraint. If it's truly 1:1 (not "1:1 for now"), consider whether they should be the same table.

```sql
CREATE TABLE user_preferences (
  user_id bigint PRIMARY KEY REFERENCES users(id),
  theme text NOT NULL DEFAULT 'light'
);
```

### Polymorphic associations — avoid them
The `commentable_type` / `commentable_id` pattern has no referential integrity, no cascade, and confuses the query planner. Instead:
- **Separate tables**: `post_comments`, `photo_comments` — more tables, but each has proper FKs
- **Single table with nullable FKs**: `comments` with `post_id`, `photo_id` — at most one non-null, enforced by CHECK constraint
- **Supertable**: `commentables` base table, posts and photos reference it — clean but adds a table

### Soft deletes
Soft deletes (`deleted_at` timestamp) have real costs:
- Every query needs `WHERE deleted_at IS NULL`
- Every unique index needs to account for soft-deleted rows (`WHERE deleted_at IS NULL`)
- FK cascades don't work — soft-deleted parent, hard-deleted children
- Accumulated data that no one can see but everyone pays to store

Consider alternatives:
- **Archival**: Move deleted rows to an archive table. Production stays clean.
- **Event sourcing**: Deletion is an event. Current state doesn't include deleted. History is preserved in events.
- **Hard delete with backup**: The simplest answer. Backups exist for a reason.

If you must soft-delete: `deleted_at timestamptz`, indexes with `WHERE deleted_at IS NULL`, and a cleanup policy (e.g., hard-delete after 90 days).

## Migrations

### Migration is not schema sync
A migration is a story of how the schema changes. Schema sync (compare current state to desired state, generate diff) works for development but not for production. Migrations let you control the HOW: what order, what locks, what backfill, what rollback.

### Every migration is reversible
Before writing the `up`, write the `down`. If you can't reverse it, you don't understand it well enough. Destructive migrations (DROP COLUMN, DROP TABLE) are reversible if you kept the data. Rename instead of drop — `email_deprecated` then drop a week later after confirming nothing breaks.

### Migration rules for production
1. **Never rename a column in place.** Add new column → dual-write to both → backfill → switch reads to new → drop old. Each step is a separate migration.
2. **Never add a NOT NULL column without a DEFAULT.** The table is locked while the database checks every row. Add nullable → backfill → set NOT NULL.
3. **Never add a foreign key without checking existing data.** Orphaned rows will block the constraint. Validate first.
4. **Never create an index without CONCURRENTLY** (PostgreSQL). CREATE INDEX blocks writes. CREATE INDEX CONCURRENTLY doesn't. Can't run in a transaction — if it fails, it leaves an invalid index. Clean it up.
5. **Never change a column type in place.** The table is rewritten. Same approach as rename: new column → dual-write → backfill → switch → drop old.
6. **Never run a migration that modifies millions of rows in a single transaction.** Batch it. UPDATE in chunks of 1000 with pauses. Long transactions hold locks and block everything.

### Migration file structure
```
migrations/
  001_add_users.sql        # or 20240101000000_add_users.sql
  002_add_posts.sql
  003_add_comments.sql
```

Each migration has a clear up and down. The filename is the version. The order is the sequence. Never reorder, never modify an applied migration.

## Query optimization

### Read the query plan
`EXPLAIN ANALYZE` tells you exactly what the database did. Not what you think it did. Learn to read it:
- **Seq Scan**: Scanning the whole table. Fine for small tables, death for large ones.
- **Index Scan**: Using an index to find rows, then fetching from the table. Good.
- **Index Only Scan**: Getting everything from the index. Best.
- **Nested Loop**: For each row in A, look up rows in B. Good when A is small and B is indexed.
- **Hash Join**: Build a hash table from the smaller set, probe with the larger. Good for large sets.
- **Merge Join**: Sort both sets, then merge. Good when both are already sorted (index).

### Indexing strategy
1. **Index every foreign key.** Joins and cascades use them. This is the most reliable performance win.
2. **Index columns in WHERE clauses.** Especially equality conditions on large tables.
3. **Consider composite indexes.** `(user_id, created_at)` serves queries filtering by `user_id` AND sorting by `created_at`. Order matters: equality columns first, range/sort columns last.
4. **Partial indexes for filtered queries.** `CREATE INDEX ON orders (created_at) WHERE status = 'pending'` — tiny index, fast queries on pending orders.
5. **Don't index everything.** Every index slows writes. Indexes consume memory (they need to fit in the buffer cache to be effective). Index what you query, not what exists.
6. **Covering indexes.** `CREATE INDEX ON orders (user_id) INCLUDE (total, status)` — the index carries extra columns so the query never touches the table.

### N+1 queries
The most common performance bug in application code. For each row from query A, issue query B. 1000 rows → 1001 queries. Fix with:
- **JOIN**: One query, all data. But duplicates parent rows.
- **WHERE IN**: `SELECT * FROM comments WHERE post_id IN (1, 2, 3, ...)`. Two queries total. Re-associate in application code.
- **Lateral JOIN**: PostgreSQL. Correlated subquery in the FROM clause.
- **Batch loading**: Dataloader pattern. Collect IDs, load in one query, distribute results.

### Pagination
- **OFFSET/LIMIT** is fine for small datasets. It gets slow as offset grows (the database still scans the offset rows).
- **Keyset pagination** (cursor-based): `WHERE created_at > $last_cursor ORDER BY created_at LIMIT 20`. Requires an index on the cursor column. Consistent across inserts. No offset scanning.
- **Page-based pagination** is an anti-pattern for APIs: "page 3" means nothing when data is changing.

## Transactions

### ACID is not optional
- **Atomicity**: All or nothing. No partial updates.
- **Consistency**: The database moves from one valid state to another. Constraints enforce this.
- **Isolation**: Concurrent transactions don't interfere. Level matters.
- **Durability**: Committed data survives crashes.

### Isolation levels — know what you're choosing
- **Read Uncommitted**: Can read uncommitted data from other transactions. Dirty reads. Almost never what you want.
- **Read Committed** (PostgreSQL default): Each statement sees committed data as of its start. Non-repeatable reads possible. Good enough for most OLTP.
- **Repeatable Read**: The transaction sees the same data throughout. Phantom reads possible (new rows can appear).
- **Serializable**: Transactions execute as if sequentially. No anomalies. Performance cost. Use for financial operations.

### Transaction patterns
- **Keep transactions short.** Open transaction → do work → commit. Do NOT: open transaction → make HTTP request → wait for response → commit. The transaction holds locks the entire time.
- **Use savepoints for complex operations.** `SAVEPOINT step1` — partial rollback without aborting the whole transaction.
- **Retry on serialization failure.** Serializable transactions can fail with "could not serialize access." The correct response is retry, not error.

### Optimistic vs. pessimistic locking
- **Optimistic**: `UPDATE items SET quantity = quantity - 1 WHERE id = 123 AND quantity > 0`. Check the row count — if zero, someone else took it. Retry or error. No locks.
- **Pessimistic**: `SELECT ... FOR UPDATE`. Lock the row. No one else can modify it until you commit. Guarantees consistency but creates contention.

Optimistic for high-contention resources where conflicts are rare (shopping cart checkout). Pessimistic when conflicts are certain (allocating seat 14A on flight 847).

## Backups and recovery

### What to back up
- Full database dump (pg_dump, mysqldump) — logical backup
- WAL archiving (PostgreSQL) — point-in-time recovery
- File-system snapshots — fast, but need database cooperation (pg_start_backup)

### Recovery testing
A backup you haven't tested is not a backup. Restore to a temporary instance. Verify the data. Time how long it takes. Do this monthly.

### Deletion protection
- Production databases should require a manual step to delete (not just an API call)
- Backups should be immutable for a retention period (can't delete a backup younger than 7 days)
- Consider enabling `safeupdate` mode by default (requires WHERE clause for UPDATE/DELETE, prevents accidental `DELETE FROM users`)

## Connection management

### Connection pooling
Databases have a limited number of connections (PostgreSQL default: 100). Application servers can have thousands of requests. Use a connection pool:
- **pgbouncer**: Lightweight, battle-tested, transaction pooling mode
- **pgpool-II**: More features, more complexity
- **Application-level pooling**: Most ORMs have built-in pools. Good for single-process, not for serverless.

### Connection lifecycle
- Open connections at startup, reuse across requests
- Set `statement_timeout` and `idle_in_transaction_session_timeout`
- Close connections on application shutdown
- Don't open a connection per request in serverless — use a proxy (pgbouncer, RDS Proxy)

## SQL anti-patterns

### SELECT *
Never in production code. It breaks when columns are added, reordered, or removed. It fetches data you don't need (especially large TEXT/BLOB columns). Explicit columns are self-documenting.

### Implicit type coercion
`WHERE status = 1` when status is text. It might work today, it will break tomorrow. Use the correct type. PostgreSQL is strict — use it to your advantage.

### String concatenation for queries
`"SELECT * FROM users WHERE email = '" + email + "'"` — this is SQL injection. Never. Parameterized queries always.

### Missing WHERE on UPDATE/DELETE
`UPDATE users SET deleted_at = now()` deletes every user. Some databases allow you to require a WHERE clause. Enable it.

### Using COUNT(*) for existence checks
`SELECT COUNT(*) FROM users WHERE email = 'a@b.com'` scans the entire index to count every match. `SELECT EXISTS (SELECT 1 FROM users WHERE email = 'a@b.com')` stops at the first match.

### Sorting by ordinal position
`ORDER BY 1, 2` breaks when the SELECT list changes. Use column names. `ORDER BY created_at DESC, id DESC`.

### Application-level JOINs
Fetching all users, then fetching all posts for each user in a loop. The database can JOIN faster than your application can loop. Use the database for what it's good at.

## Database choice framework

### SQL (PostgreSQL, MySQL, SQLite)
Use when your data has structure, relationships, and you need consistency. PostgreSQL is the default answer. SQLite for embedded/edge (and it's surprisingly capable — don't dismiss it).

### Document (MongoDB, Couchbase)
Use when your data is genuinely unstructured and you don't need JOINs. "Flexible schema" becomes "no schema" in production. You will eventually need relationships — have a plan.

### Key-value (Redis, DynamoDB)
Use for caching, session storage, rate limiting. Not for primary data store unless your access patterns are purely key-value.

### Graph (Neo4j, Dgraph)
Use when relationships are the primary query pattern: social graphs, recommendation engines, network analysis.

### Column-family (Cassandra, HBase)
Use when you need massive write throughput and your query patterns are known in advance. Not for ad-hoc queries or frequent schema changes.

### Time-series (TimescaleDB, InfluxDB)
Use for metrics, events, IoT data. TimescaleDB is PostgreSQL with time-series optimizations — you get the ecosystem for free.

## Schema review checklist
Before finalizing any schema:
- [ ] All tables have a PRIMARY KEY
- [ ] All foreign keys are indexed
- [ ] All timestamps are `timestamptz` with DEFAULT
- [ ] No `varchar(n)` without a specific, documented reason
- [ ] No money stored as float
- [ ] Unique constraints exist on natural keys (email, slug, external_id)
- [ ] NOT NULL is the default; nullable is the exception
- [ ] Every migration has a down
- [ ] Destructive operations are multi-step with verification windows
- [ ] Partitioning or archiving strategy exists for large/growing tables
- [ ] Connection pooling is configured
- [ ] timeouts are set (statement_timeout, idle_in_transaction_session_timeout)
