---
name: networking
description: HTTP semantics, REST and GraphQL API design, WebSockets, TLS, DNS, and protocol-level thinking. The network is not reliable — design for that.
version: 1.0.0
tags: [networking, http, api, rest, graphql, websockets, tls]
extends: []
conflicts: []
requires: []
provides: [networking, http, api-design, protocols]
priority: 5
---

# Networking

## When to use this skill
Activate when:
- Designing or reviewing an API (REST, GraphQL, gRPC)
- Implementing WebSocket connections
- Setting up TLS/HTTPS
- Debugging network issues (timeouts, DNS, CORS)
- Choosing between communication patterns (request-response, pub-sub, streaming)
- Handling uploads/downloads over HTTP
- Implementing retry logic, backoff, or idempotency
- Designing service-to-service communication
- Configuring load balancers, reverse proxies, or CDNs

## First principle: the network is not reliable

It will fail. It will be slow. Packets will be dropped, reordered, duplicated. The other end will crash mid-response. The DNS will time out. TLS handshakes will be rejected. A TCP connection that was alive a millisecond ago is now dead and you won't know until you try to use it.

Every piece of networking code must handle failure gracefully. The question is not "will it fail" but "what happens when it fails." Timeouts on everything. Retry with backoff for idempotent operations. Circuit breakers for cascading failures. Graceful degradation when a dependency is unavailable.

## HTTP

### Status codes — use them correctly
- **2xx**: It worked.
  - `200 OK` — Generic success. Prefer more specific codes when available.
  - `201 Created` — Resource created. Include a Location header.
  - `202 Accepted` — Request accepted, processing async. Include a status endpoint.
  - `204 No Content` — Success with no response body. Use for DELETE, successful updates.
- **3xx**: Look elsewhere.
  - `301 Moved Permanently` — This URL is dead, use the new one forever.
  - `302 Found` — Temporary redirect. Don't change your bookmarks.
  - `304 Not Modified` — Your cached copy is still valid. No body returned.
- **4xx**: You made a mistake.
  - `400 Bad Request` — Malformed syntax. Not "I don't like your data."
  - `401 Unauthorized` — You're not authenticated. "Who are you?"
  - `403 Forbidden` — You're authenticated but not allowed. "I know who you are, and no."
  - `404 Not Found` — Resource doesn't exist. Also used to hide existence (don't confirm user 123 exists by returning 403 vs 404).
  - `409 Conflict` — Your request conflicts with current state. Use for optimistic locking failures.
  - `422 Unprocessable Entity` — Valid syntax, semantically wrong. Missing required fields, invalid values.
  - `429 Too Many Requests` — Rate limited. Include Retry-After header.
- **5xx**: We made a mistake.
  - `500 Internal Server Error` — Something broke. Don't expose stack traces.
  - `502 Bad Gateway` — Upstream returned invalid response.
  - `503 Service Unavailable` — Temporarily down. Include Retry-After.
  - `504 Gateway Timeout` — Upstream didn't respond in time.

### Idempotency
- **GET, HEAD, OPTIONS**: Idempotent by definition. No side effects.
- **PUT**: Idempotent. `PUT /users/123` with the same body twice produces the same result.
- **DELETE**: Idempotent. Deleting something twice: first time it's gone, second time it's still gone (404).
- **POST**: NOT idempotent. Two POSTs create two resources. Use idempotency keys for payment/subscription endpoints. `Idempotency-Key: <uuid>` header.
- **PATCH**: May or may not be idempotent. `PATCH { status: 'active' }` is idempotent. `PATCH { $inc: { count: 1 } }` is not.

### Content negotiation
- Use `Accept` header to let clients choose format: `Accept: application/json`, `Accept: text/html`
- Use `Content-Type` to declare what you're sending: `Content-Type: application/json; charset=utf-8`
- Don't use URL extensions for format: `/users.json` is not RESTful. The resource is `/users/123`, the representation is negotiated.

### Caching
- `Cache-Control: private, max-age=60` — Cache this for 60 seconds, but only for the requesting user (browser cache, not CDN).
- `Cache-Control: public, max-age=3600` — Cache for an hour, anyone can use it (CDN cache).
- `Cache-Control: no-store` — Don't cache at all. Use for sensitive data.
- `ETag` — Conditional requests. Client sends `If-None-Match`, server responds 304 if unchanged.
- `Last-Modified` — Same idea, timestamp-based. Less precise than ETag.

### Range requests
For large files and resumable downloads: `Range: bytes=0-1048575`. Server responds `206 Partial Content` with `Content-Range: bytes 0-1048575/5242880`. Enables pause/resume and parallel downloads.

## REST API design

### Resources, not RPC
- `/users` — collection of users
- `/users/123` — a specific user
- `/users/123/orders` — orders belonging to user 123
- `/orders/456` — a specific order (don't nest deeper than one level: `/users/123/orders/456` is an alias, `/orders/456` is canonical)

### Naming
- **Plural nouns**, not verbs. `GET /users` not `GET /getUsers`.
- **kebab-case** for multi-word resources: `/order-items` not `/orderItems` or `/order_items`.
- **No trailing slash**. `/users` not `/users/`.
- **No file extensions**. `/users/123` not `/users/123.json`.

### Actions that aren't CRUD
Sometimes you need to model an action: "send an email," "approve an order," "cancel a subscription."
- **RPC-style**: `POST /orders/123/approve` — clear, but not strictly REST.
- **State change**: `PATCH /orders/123 { status: 'approved' }` — more RESTful. But the transition might need validation.
- **Sub-resource**: `POST /orders/123/approvals` — the approval is a resource. You can GET it later, see who approved it, when.

Rule: if you can model the action as a state change on the resource, do. If the action has side effects that don't map to resource state (send email, trigger webhook), use a verb endpoint.

### Filtering, sorting, pagination
```
GET /users?status=active&role=admin&sort=-created_at&limit=20&cursor=eyJpZCI6MTIzfQ
```
- **Filtering**: Query params. `?status=active` or `?filter[status]=active` for nested.
- **Sorting**: `sort=-created_at,name` (minus prefix for descending).
- **Pagination**: `limit` + `cursor` (keyset). Include `next_cursor` in response. Also include `has_more: true/false`.

### Error responses
Consistent structure:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "User-facing message (can be shown to the user)",
    "details": [
      { "field": "email", "message": "Must be a valid email address" },
      { "field": "age", "message": "Must be at least 18" }
    ],
    "request_id": "req_abc123"
  }
}
```
- `code`: Machine-readable. Clients can branch on this.
- `message`: Human-readable. Safe to display.
- `details`: Optional. Field-level errors for forms.
- `request_id`: For support. "I got an error" → "What's the request ID?"

### Versioning
- URL versioning: `/v1/users` — explicit, easy to route, clutters URLs.
- Header versioning: `Accept: application/vnd.api+json; version=1` — clean URLs, harder to test in browser.
- Query param versioning: `/users?version=1` — worst of both worlds.

URL versioning is the pragmatic default. You can route v1 and v2 to different services. Deprecation headers: `Sunset: Sat, 31 Dec 2025 23:59:59 GMT` and `Deprecation: true`.

## GraphQL

### When GraphQL vs. REST
**GraphQL** when:
- Clients need flexible queries (mobile with limited bandwidth)
- Multiple consumers with different data needs
- The UI aggregates data from many sources
- You have a graph-shaped domain

**REST** when:
- Simple CRUD API
- Caching is critical (HTTP caching works out of the box)
- You need simplicity and tooling (curl, Postman, every HTTP client)
- File uploads/downloads are primary

### GraphQL anti-patterns
- **N+1 queries**: GraphQL resolvers run per-field. `users → posts → comments` without a dataloader is 1 + N_users + N_posts queries. Use DataLoader to batch.
- **Unbounded queries**: `users { posts { comments { replies { ... } } } }`. Depth limits (max depth 5). Complexity scoring (weight fields, reject over threshold).
- **Mutations that aren't mutations**: If it changes data, it's a mutation, not a query field.
- **Errors in data**: `{ data: { user: null }, errors: [...] }` — user wasn't found. Better: union type `User | NotFoundError`.
- **Versioning drift**: GraphQL's "only add fields, never remove" philosophy means you accumulate deprecated fields forever. Track usage. Remove unused fields.

## WebSockets

### When WebSockets
- Real-time updates (chat, live dashboards, game state)
- Bidirectional communication (collaborative editing, terminal sessions)
- Server-initiated messages (notifications, alerts)

### When NOT WebSockets
- Simple request-response (use HTTP)
- Server-to-client only (use SSE — Server-Sent Events)
- Infrequent updates (use polling — simpler, more reliable)
- CDN-friendly content (WebSockets don't cache)

### WebSocket patterns
- **Heartbeats**: Both ends should ping. If no pong in N seconds, the connection is dead. Reconnect.
- **Reconnection**: Exponential backoff with jitter. Max delay. Reset on successful connection.
- **Message ordering**: TCP guarantees order within a connection. On reconnect, you may miss messages. Use sequence numbers.
- **Backpressure**: If the client can't keep up, drop messages or buffer with a limit. Don't let a slow client block the server.
- **Authentication**: Auth on connect (send token in first message or query param). Validate on every message if sensitive. WebSocket connections are long-lived — tokens expire mid-connection.
- **Authorization**: Same as HTTP. Just because you opened the socket doesn't mean you can read every channel. Validate per-subscription.

### SSE as an alternative
Simpler than WebSockets: server → client only, auto-reconnect, works through most proxies. Use when you don't need client → server.

```
GET /events
Accept: text/event-stream

data: {"type": "update", "payload": {...}}
id: 42

data: {"type": "heartbeat"}
```

The `id` field enables `Last-Event-ID` on reconnect so the server knows where the client left off.

## TLS

### Minimum configuration
- **TLS 1.3 preferred, TLS 1.2 minimum**. TLS 1.0 and 1.1 are broken. Disable them.
- **Certificate from a trusted CA**. Let's Encrypt is free and automated.
- **HSTS header**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- **Redirect HTTP to HTTPS**: 301 permanent redirect. Don't serve anything over HTTP except the redirect.
- **Modern ciphers**: Let your TLS library handle defaults. Don't hand-select ciphers unless you know what you're doing.

### Certificate management
- Auto-renewal is not optional. Manual renewal means expired certificates in production.
- Monitor expiry. Alert at 30 days, page at 7 days, wake someone up at 3 days.
- OCSP stapling: the server proves the certificate hasn't been revoked without the client contacting the CA. Enables faster connections.

### mTLS (mutual TLS)
When services authenticate each other with certificates. Both client and server present certificates. Use for service-to-service communication in zero-trust environments. The certificate IS the identity — no API keys needed.

## DNS

### Record types you'll actually use
- **A**: Domain → IPv4. `example.com A 93.184.216.34`
- **AAAA**: Domain → IPv6.
- **CNAME**: Alias one domain to another. `www.example.com CNAME example.com`. Can't CNAME a root domain (apex).
- **MX**: Mail server. With priority.
- **TXT**: Arbitrary text. SPF, DKIM, domain verification.
- **NS**: Delegates a subdomain to different nameservers.
- **SRV**: Service discovery. Host + port for a service.

### TTL strategy
- **Long TTL (1 hour to 1 day)** for stable records. Reduces DNS load, faster responses.
- **Short TTL (60-300 seconds)** for records that change frequently. Use when planning failovers.
- **Lower TTL BEFORE making changes.** If you're migrating a service, drop TTL to 60s a day before, make the change, raise it after.

### DNS as a reliability concern
DNS is a dependency. If your DNS provider is down, users can't find you. Mitigations:
- Multiple DNS providers (secondary DNS)
- Longer TTLs (clients cache your IP even if your DNS is down)
- Monitor DNS from multiple locations

## Timeouts, retries, and resilience

### Timeouts
Every network call needs a timeout. No timeout = hung thread forever.
- **Connect timeout**: How long to wait for TCP connection. 3-10 seconds.
- **Read timeout**: How long to wait for data after connection. Depends on the operation. 30s for API calls, longer for uploads.
- **Overall timeout**: Total time for the entire operation. Includes retries.

Timeouts should be set at every layer: application, HTTP client, TCP.

### Retry with backoff
Only retry idempotent operations. Retrying a POST that created a resource but whose response was lost creates duplicates.

```
attempt 1: wait 0ms
attempt 2: wait 100ms + random(0-100ms)
attempt 3: wait 200ms + random(0-200ms)
attempt 4: wait 400ms + random(0-400ms)
...
max attempts: 3 (for user-facing), 5 (for background jobs)
```

Exponential backoff with jitter. Random jitter prevents thundering herd (all retries firing simultaneously).

### Circuit breaker
After N consecutive failures, stop trying for M seconds. This gives the downstream service time to recover. Three states:
- **Closed**: Normal operation. Requests flow through.
- **Open**: Failures exceeded threshold. Fast-fail all requests (no connection attempts).
- **Half-open**: After timeout, allow one probe request. Success → close. Failure → open again.

### Graceful degradation
When a dependency is unavailable, what can you still do?
- **Cache**: Serve stale data with a warning. Better than an error page.
- **Default**: Return sensible defaults. "Comments unavailable" not "500 error."
- **Degrade**: Core functionality works, nice-to-haves are missing. Search works, related products don't load.

### Bulkheading
Isolate failures. One slow downstream shouldn't consume all your threads. Separate thread pools for different services. Rate limit per downstream. The slow payment processor shouldn't prevent users from viewing their profile.

## CORS (Cross-Origin Resource Sharing)

CORS is a browser security mechanism. The browser blocks cross-origin requests unless the server explicitly allows them. It's not a server-side security mechanism — the request still reaches the server. CORS protects users with cookies, not your API.

### Correct configuration
```
Access-Control-Allow-Origin: https://app.example.com  # Specific origin, not *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400  # Cache preflight for 24 hours
```

- **Never** `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`. Browsers will reject it.
- **Preflight** OPTIONS requests: the browser asks "can I make this request?" before making it. Return 204 with the right headers. Cache it.
- **Credentials**: Cookies, Authorization headers, TLS client certificates. If you need them, you need `Access-Control-Allow-Credentials: true` AND a specific origin.

## Uploads and downloads

### Large uploads
- **Stream to disk**, not memory. A 2GB upload shouldn't consume 2GB of RAM.
- **Validate progressively**. Check Content-Type, then first N bytes for magic number, then stream to storage.
- **Resumable uploads**: Tus protocol. Upload chunks. Server tracks progress. Client retries failed chunks.
- **Upload limits**: Set before processing. `Content-Length` header, or track bytes received. Reject early.

### Large downloads
- **Stream from storage** to response. Don't buffer the entire file in memory.
- **Range support** (HTTP 206). Enables pause/resume.
- **Content-Disposition**: `attachment; filename="report.pdf"` for downloads. `inline` for display in browser.
- **ETag** for conditional downloads. If the file hasn't changed, 304 Not Modified.

## Protocol anti-patterns

### Using POST for everything
"POST is the only method that works reliably." This is laziness. GET for reads, POST for creates, PUT for full updates, PATCH for partial updates, DELETE for deletes. Method semantics matter for caching, idempotency, and tooling.

### Returning 200 for errors
```json
{ "status": "error", "message": "Something went wrong" }
```
...with HTTP 200. The browser, proxy, CDN, and every HTTP client between you and the user thinks this request succeeded. Caching will cache the error. Monitoring will miss it. Use status codes.

### No timeout configured
Every HTTP client defaults to no timeout or an absurdly long one. `fetch()` default timeout is... none. Use `AbortSignal.timeout(30000)` or equivalent. Always.

### Ignoring connection pool limits
Opening a new connection per request, especially to the same host. TLS handshakes are expensive. Use keep-alive. Pool connections. The HTTP client should manage this — if it doesn't, switch clients.

### Trusting the Content-Type header
Clients can send `Content-Type: application/json` with a body that isn't JSON. Parse defensively. Catch parse errors. Return 400, not 500.

### Endless redirects
`GET /old → 302 /old` creates a redirect loop. Set a redirect limit (max 5-10). After that, return an error. Every redirect is a round trip the user is waiting for.
