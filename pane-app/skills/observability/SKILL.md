---
name: observability
description: Metrics, logging, tracing, SLOs, alerting, dashboards, and incident response. You cannot fix what you cannot see.
version: 1.0.0
tags: [observability, monitoring, logging, tracing, metrics, alerts, incident-response]
extends: []
conflicts: []
requires: []
provides: [observability, monitoring, logging, tracing, alerting, incident-response]
priority: 5
---

# Observability

## When to use this skill
Activate when:
- Setting up monitoring for a new service
- Designing logging strategy
- Implementing distributed tracing
- Defining SLOs and error budgets
- Configuring alerts and on-call rotations
- Setting up dashboards
- Debugging production issues
- Designing an incident response process
- Choosing observability tools (OpenTelemetry, Datadog, Grafana, etc.)
- Instrumenting code with metrics

## First principle: you cannot fix what you cannot see

Observability is not monitoring. Monitoring tells you that something is wrong. Observability tells you WHY it's wrong. A monitored system has dashboards showing CPU is at 90%. An observable system lets you trace that CPU spike to a specific customer running a query with a missing index at 3:14 PM.

The difference is the ability to ask new questions without deploying new code. If you have to add a log line, redeploy, and wait for the issue to recur, you don't have observability — you have guesswork with a redeployment step.

## The three pillars

### Metrics
Numbers measured over time. Counters, gauges, histograms.

**What to measure:**
- **RED** (for every service): Rate (requests/sec), Errors (failed/sec), Duration (latency percentiles)
- **USE** (for every resource): Utilization (% of capacity), Saturation (queue depth), Errors (hardware/software failures)
- **The Four Golden Signals** (Google SRE): Latency, Traffic, Errors, Saturation

**What NOT to measure:**
- Metrics you don't have an alert for. If nobody looks at it and nothing triggers on it, it's noise.
- Cardinally unbounded metrics (user_id as a label — you just created a time series per user, which is millions of series)
- Everything. "Measure all the things" → "Ignore all the things because there are too many."

**Histograms vs. summaries:**
- **Histogram**: Pre-defined buckets. `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`. You can aggregate across instances. p50, p95, p99 are estimates within bucket boundaries.
- **Summary**: Client-side percentile calculation. You get exact p50, p95, p99. You CANNOT aggregate across instances (averages of percentiles are meaningless).
- **Rule**: Use histograms by default. The aggregability matters more than exact percentiles. Use summaries only when the client-side calculation is critical and you don't need cross-instance aggregation.

**Percentiles matter more than averages:**
Average latency of 50ms with p99 of 500ms means: most users are fine, but 1% of users (your biggest customers, hitting the most expensive queries) are having a terrible experience. Average hides the tail. Always track p50, p95, p99. p99.9 for the worst-case.

### Logging
Immutable, timestamped records of discrete events.

**Structured logging:**
```json
{
  "timestamp": "2025-01-15T03:14:00.000Z",
  "level": "error",
  "message": "Failed to charge card",
  "service": "payment-service",
  "trace_id": "abc123def456",
  "span_id": "abc123",
  "user_id": "usr_789",
  "order_id": "ord_456",
  "error": "card_declined",
  "duration_ms": 1200,
  "http": {
    "method": "POST",
    "path": "/v1/charges",
    "status_code": 402,
    "remote_addr": "10.0.1.5"
  }
}
```

No regex parsing in production. No "split on space and hope." Every field is a key in a structured object. This is non-negotiable in 2025.

**Log levels — and when to use each:**
- **ERROR**: Something failed. A human should look at this. The charge didn't go through. The database is unreachable. An invariant was violated.
- **WARN**: Something is concerning but not failing. Retry attempt 2 of 3. Approaching rate limit. Deprecated API version used.
- **INFO**: Significant business events. Order placed. User registered. Payment received. Deployment completed. These are the events that tell the story of what your system did today.
- **DEBUG**: Details useful for debugging. Function entry/exit, parameter values, intermediate calculations. Not enabled in production by default. Toggle on for specific components.
- **TRACE**: Extremely detailed. Every iteration of a loop. Every cache lookup. Only for local development or short-lived debugging sessions.

**What to log:**
- Every incoming request (method, path, status, duration, caller)
- Every outgoing request to external services (same)
- Every significant state change (order placed → confirmed → shipped)
- Every authentication/authorization decision (user logged in, access denied)
- Every error with full context (stack trace is not context — include the request, the user, the data involved)

**What NOT to log:**
- Passwords, tokens, secrets (redact them at the logging framework level)
- PII without a retention policy and access control (GDPR means logs containing PII are data)
- Giant blobs (full request bodies, database query results with thousands of rows) — truncate
- Logs that aren't actionable (if nobody will ever look at it, don't log it)

**Correlation:** Every log entry must include `trace_id` and `span_id` so you can jump from a log line to the entire distributed trace. Without this, debugging a request that spans 5 services requires correlating timestamps from 5 different log streams by hand.

### Tracing
Following a request as it flows through multiple services.

**The building blocks:**
- **Trace**: The entire journey of a request through the system. `trace_id = abc123`.
- **Span**: A single unit of work within a trace. `POST /orders`, `SELECT * FROM users`, `stripe.charges.create`. Has a start time, duration, parent span.
- **Span context**: The `trace_id` and `span_id` passed across service boundaries (usually via HTTP headers: `traceparent: 00-abc123-def456-01`).

**What to instrument:**
- Every incoming HTTP request (the entry span)
- Every outgoing HTTP/gRPC/database call
- Every message queue publish and consume
- Significant internal operations (template rendering, data transformation, report generation)
- Every error path

**Span attributes:**
```json
{
  "http.method": "POST",
  "http.url": "https://api.stripe.com/v1/charges",
  "http.status_code": 200,
  "db.system": "postgresql",
  "db.statement": "SELECT ...",
  "error": true,
  "error.message": "card_declined"
}
```

Rich attributes make traces debuggable. "Span 4 took 3 seconds" tells you nothing. "Span 4: `stripe.charges.create` for `order_id=456` took 3 seconds, returned `card_declined`" tells you everything.

**Sampling:**
- **Head sampling**: Decide at trace start whether to sample. Simple. But you might miss the slow traces.
- **Tail sampling**: Keep all traces in a buffer, decide after completion. Keep errors, keep slow traces, sample the fast ones. More infrastructure but much more useful.
- **Rule**: Sample 100% of errors. Sample 100% of traces > p95 latency. Sample 1-10% of everything else. You want to catch rare failures and understand the slowest requests.

## OpenTelemetry

OpenTelemetry (OTel) is the standard. It defines APIs, SDKs, and protocols for metrics, logs, and traces. It's vendor-neutral — instrument once, send to any backend.

**Architecture:**
```
Your code → OTel SDK (in-process) → OTel Collector (sidecar/daemon) → Backend (Datadog, Grafana, etc.)
```

The Collector is optional but recommended. It handles batching, retry, sampling, and routing to multiple backends. Your application doesn't need to know where the data ends up.

**Do NOT build your own instrumentation library.** In 2018, every company had a homegrown tracing library that was slightly wrong in its own way. Use OpenTelemetry. It's the standard web of observability — universal, well-tested, and understood by everyone.

## SLOs, SLIs, and error budgets

### Definitions
- **SLI** (Service Level Indicator): A measurement. "99.5% of requests complete in under 300ms over the last 30 days."
- **SLO** (Service Level Objective): A target. "99.9% of requests must complete in under 300ms over any 30-day window."
- **SLA** (Service Level Agreement): A contract. "If we fail the SLO, we refund 10% of your monthly bill."

### Setting SLOs
1. Start with what users care about. Latency? Availability? Freshness? Correctness?
2. Measure it for a few weeks. What's the current performance?
3. Set the SLO slightly tighter than current. Not aspirational (99.999% when you're at 99% today) — achievable.
4. Monitor compliance on a rolling window.
5. **Never set an SLO of 100%.** You will fail it. The system will be down at some point. Set 99.9% or 99.95% or 99.99% — something that acknowledges reality.

### Error budgets
Error budget = 100% - SLO. If your SLO is 99.9% availability, your error budget is 0.1% downtime = 43 minutes per month.

**How to use error budgets:**
- If you have budget remaining: deploy features, take risks, move fast.
- If you're over budget: stop all feature deploys. Only reliability work until the budget recovers.
- This aligns incentives. Product wants features. SRE wants stability. The error budget is the objective arbiter.

### SLOs for different things
- **Availability**: `count of successful requests / count of all requests`. 99.9% means 0.1% of requests can fail.
- **Latency**: `count of requests faster than threshold / count of all requests`. "p99 < 300ms" is an SLO, not "average < 300ms."
- **Freshness**: `count of data updated within threshold / count of all data`. "99% of search results reflect data no older than 5 minutes."
- **Durability**: `count of writes preserved / count of all writes`. "99.999999999% durability" (11 nines — typical for cloud storage).

## Alerting

### Alerts vs. pages
- **Alert**: Something a human should know about. Goes to a channel, a dashboard, an email. "p99 latency elevated." "Cert expires in 14 days."
- **Page**: Something a human must act on NOW. Wakes someone up. "Service is down." "Error rate > 10% for 5 minutes."

Pages should be rare, urgent, and actionable. Every page that doesn't require immediate human action erodes trust in the paging system. After the third false alarm, people start silencing their phones at night.

### What to page on
- **Symptoms, not causes:** "API error rate > 5%" is a symptom. "CPU > 90%" is a cause. Page on symptoms. The cause might be a runaway query, a deploy, or a DDoS — but the user doesn't care about CPU, they care about errors.
- **Rate of change:** "Error rate doubled in the last 5 minutes" catches problems before they reach threshold.
- **SLO burn rate:** How fast are you burning error budget? "Burned 2% of 30-day error budget in the last hour" → page. You have hours before the SLO is violated.

### What NOT to page on
- Anything that's someone else's problem (upstream dependency is down — they know)
- Anything that resolves itself in < 5 minutes (transient blips)
- Anything that happens during planned maintenance (suppress alerts during deploys)
- Low-urgency informational alerts (that's what dashboards and Slack channels are for)

### Alert design
Every alert must answer:
1. **What is broken?** (the symptom, not the cause)
2. **How broken is it?** (the magnitude — 5% error rate? 100%?)
3. **Where is it broken?** (which service, region, endpoint)
4. **Why might it be broken?** (link to relevant dashboard, runbook, recent deploys)
5. **What do I do?** (link to runbook. If there's no runbook, don't page — you're waking someone up to figure out what to do from scratch)

## Dashboards

### The hierarchy of dashboards
1. **Executive**: 1-3 numbers. "Is the business healthy?" SLO compliance, revenue, active users.
2. **Service overview**: 4-6 graphs. "Is this service healthy?" RED metrics, SLO burn, dependency health.
3. **Debugging**: Detailed graphs. Per-endpoint latency, per-dependency errors, database query performance.
4. **Infrastructure**: Resource usage. CPU, memory, disk, network per instance.

### Dashboard design principles
- **Top-left is most important.** Eyes go there first. Put the thing you most want someone to see.
- **Time ranges should match the metric.** p99 latency over 1 minute is noisy. Over 1 hour hides spikes. Use 5-minute or 15-minute windows.
- **Show the baseline.** A line graph of error rate without knowing that "this is what it normally looks like" is useless. Show the same time yesterday, or the 7-day average.
- **Every graph should have a horizontal line for the threshold.** If p99 should be < 300ms, draw a line at 300ms. You can see violations at a glance.
- **Don't put everything on one dashboard.** Information density has diminishing returns. 6-8 graphs per dashboard.

### The "splash of red" test
Open the dashboard. Is anything red? If everything is green, glance and close. If something is red, investigate. The dashboard should make this test take under 5 seconds.

## Incident response

### Before the incident
- **Runbooks**: Step-by-step for every alert. "Run this command. Check this dashboard. If X, escalate to team Y." Not "figure it out."
- **On-call rotation**: Sustainable. Not one person. Escalation path if primary doesn't respond.
- **Incident commander role**: One person coordinates. They do NOT fix the problem — they keep track of who's doing what, communicate status, decide when to escalate. The person fixing should not also be coordinating.

### During the incident
1. **Acknowledge**: Page received. "I'm on it."
2. **Assess**: What's the scope? Is the entire service down or just one endpoint? One region or all?
3. **Mitigate**: Stop the bleeding. Rollback. Failover. Scale up. Cut traffic to the broken component. Don't root-cause while users are impacted.
4. **Resolve**: The system is stable. Users are no longer impacted.
5. **Postmortem**: After the incident, not during. See below.

### Incident communication
- **First update within 5 minutes**: "We're investigating elevated error rates in payment-service. Impact: checkouts failing. Team: alice (IC), bob (comms)."
- **Updates every 30 minutes**: Even if the update is "still investigating." Silence is worse than "no news yet."
- **Status page**: External communication for customer-facing incidents. "Degraded performance" vs "Partial outage" vs "Full outage." Clear, honest, no corporate equivocation.

### Postmortems (blameless)
After every significant incident, a postmortem. The goal is to learn and prevent recurrence, not assign blame.

**Structure:**
1. **What happened?** Timeline of events, with timestamps.
2. **What was the impact?** Duration, affected users, affected revenue.
3. **How did we resolve it?** What action stopped the bleeding?
4. **What was the root cause?** Technical cause. Missing timeout. Race condition. Configuration error.
5. **What were the contributing factors?** Process failures. The PR was approved by someone unfamiliar with the service. The alert fired but was ignored because of alert fatigue.
6. **Action items**: Concrete, assigned, with due dates. "Add timeout to stripe client (Alice, Jan 22)." "Consolidate alert thresholds (Bob, Jan 29)."

**Rules:**
- No "human error" as root cause. Humans make errors. Systems should prevent or absorb them. "Alice made a typo" → "The config format allowed the typo without validation."
- Action items must be tracked to completion. A postmortem with no follow-through is worse than no postmortem — it's performative learning.
- Share broadly. The same mistake in Team A is a learning opportunity for Teams B through Z.

## Practical instrumentation

### RED metrics for every service
```javascript
// In middleware
const start = Date.now();
try {
  const response = await next(request);
  const duration = Date.now() - start;
  
  requestCounter.add(1, { method, path, status: response.status });
  requestDuration.record(duration, { method, path, status: response.status });
  
  return response;
} catch (error) {
  const duration = Date.now() - start;
  
  requestCounter.add(1, { method, path, status: 'error' });
  errorCounter.add(1, { method, path, error: error.name });
  requestDuration.record(duration, { method, path, status: 'error' });
  
  throw error;
}
```

This is table stakes. Every service. No exceptions. If a service doesn't have RED metrics, it's not deployed — it's abandoned in production.

### Database query metrics
Not "how long did the query take" (that's just duration). Track:
- Query count by operation type (SELECT, INSERT, UPDATE, DELETE)
- Query duration histogram
- Errors (connection failures, constraint violations, timeouts)
- Connection pool utilization (% used, wait time for a connection)

### Client-side metrics
The server says the API responds in 50ms. The user in Australia on 3G waits 3 seconds. You need both perspectives.
- Page load time (Core Web Vitals: LCP, INP, CLS)
- API call duration from the client's perspective
- Error rate from the client's perspective (the server might not log a network timeout)

Use Real User Monitoring (RUM) for this. A small percentage of sessions instrumented with client-side metrics tells you what your users actually experience.

## Observability anti-patterns

### Logging without structure
```
2025-01-15 03:14:00 ERROR Failed to charge card for user usr_789 on order ord_456: card_declined
```
This is a string. You can't query it. You can't aggregate by error type. You can't graph the rate of `card_declined` vs `insufficient_funds`. Use JSON. Always.

### Alerting on symptoms you can't act on
"Disk usage on db-primary reached 80%." This pages someone at 3 AM. They look at it, see it's been growing at 1% per day, and go back to sleep. This alert should be: a Slack message at 80%, an email at 85%, a page at 95% with a runbook to add disk space or clean up old data.

### Dashboard overload
A dashboard with 50 graphs. Nobody looks at it. Nobody can find what they need. It exists because someone once said "can we add a graph for X" and nobody ever removed anything. Curate dashboards. Remove graphs that aren't looked at.

### Tracing every request
100% sampling in production doubles your infrastructure cost and adds latency. You don't need every trace. You need every error trace, every slow trace, and a sample of the rest.

### Only observing in production
By the time a problem reaches production, it's already hurting users. Observability in staging catches problems earlier. Observability in load testing catches them even earlier. The earlier you see the problem, the cheaper the fix.

### Alert fatigue
The average on-call engineer receives dozens of alerts per shift. Most are false alarms or low-priority. After enough false alarms, they stop responding to all alerts. This is called alert fatigue, and it means your alerting system is a net negative — it's training people to ignore it.

Fix: audit alerts quarterly. Remove any that haven't fired in 3 months. Downgrade any that fired but didn't require action. Tune thresholds so alerts fire when they should and don't when they shouldn't.

### Monitoring the wrong thing
"Every request to the health check returns 200. The service is healthy!" Meanwhile, every real request is failing because the database is down, but the health check doesn't check the database. Health checks must verify the service can do its job, not just that the process is running.

### No retention policy
Logs and metrics grow forever. Costs grow forever. Have a retention policy: 7 days of raw logs, 30 days of aggregated metrics, 1 year of SLO compliance data. Delete aggressively. Storage is cheap, but infinite storage of infinite data is expensive.

## Tool landscape (when to use what)

| Need | Tool |
|---|---|
| Metrics + dashboards + alerting | Grafana (OSS, self-hosted), Datadog (managed), Grafana Cloud (managed) |
| Metrics storage | Prometheus (pull-based, self-hosted), Thanos/Cortex (horizontally scalable Prometheus), VictoriaMetrics (high-performance alternative) |
| Log aggregation | Loki (from Grafana, S3-backed), Elasticsearch (full-text search), Datadog (managed) |
| Tracing | Tempo (from Grafana, S3-backed), Jaeger (OG distributed tracing), Datadog APM |
| All-in-one instrumentation | OpenTelemetry (collector + SDKs — use this regardless of backend) |
| Error tracking | Sentry (exception aggregation, release tracking) |
| Status page | Atlassian Statuspage, incident.io, self-hosted with cache-busting |
| Incident management | incident.io, FireHydrant, PagerDuty, Opsgenie |
| On-call | PagerDuty, Opsgenie, Grafana OnCall |
| RUM (Real User Monitoring) | Grafana Faro, Datadog RUM, Sentry |

**Recommendation for new projects:** OpenTelemetry for instrumentation. Grafana stack (Prometheus + Loki + Tempo) for storage and visualization. PagerDuty for on-call. This stack is OSS, widely understood, and works at any scale.
