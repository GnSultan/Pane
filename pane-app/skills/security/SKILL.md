---
name: security
description: Security mindset — threat modeling, auth patterns, input validation, secrets management, and OWASP. Security is not a feature. It's a property of every feature.
version: 1.0.0
tags: [security, auth, threat-modeling, owasp, secrets]
extends: []
conflicts: []
requires: []
provides: [security, threat-modeling, auth, secrets-management]
priority: 5
---

# Security

## When to use this skill
Activate when:
- Designing authentication or authorization
- Handling user input that touches a database, filesystem, or network
- Managing secrets, API keys, or credentials
- Reviewing code for security vulnerabilities
- Setting up CORS, CSP, or HTTP security headers
- Handling file uploads or user-generated content
- Integrating third-party services with access tokens
- Threat modeling a new or changed feature

## First principle: security is not a feature

You can't add security after the fact. "We'll secure it later" means "we'll never secure it." Security is a property of how every feature is built — how you handle input, how you store data, how you authenticate, how you authorize, how you log, how you fail. Every line of code either strengthens or weakens the security of the system.

## Threat modeling

### STRIDE: a lightweight framework
Before building anything that handles user data, walk through STRIDE:

- **Spoofing**: Can someone pretend to be someone else? Stolen tokens, missing auth, weak session management.
- **Tampering**: Can someone modify data in transit or at rest? Missing integrity checks, unprotected APIs, client-side validation only.
- **Repudiation**: Can someone deny an action? Missing audit logs, no non-repudiation for critical actions (payments, deletions).
- **Information Disclosure**: Can someone see data they shouldn't? Missing authorization checks, verbose error messages, exposed IDs.
- **Denial of Service**: Can someone make the system unavailable? Missing rate limiting, unbounded resource allocation, expensive unauthenticated endpoints.
- **Elevation of Privilege**: Can someone gain permissions they shouldn't have? Missing role checks, insecure direct object references, admin endpoints without auth.

### The threat model document
For features handling sensitive data (PII, payments, credentials):
1. What are we protecting? (data, access, availability)
2. Who are the attackers? (anonymous users, authenticated users, insiders, automated scripts)
3. What are the attack vectors? (how does data enter the system, what surfaces are exposed)
4. What are the mitigations? (for each threat, the specific control)
5. What is the residual risk? (what's still exposed after mitigations)

## Authentication

### Password authentication
- **Hash, don't encrypt.** bcrypt, argon2, scrypt. Never SHA or MD5. Hashing is one-way. If you can "decrypt" it, it's not hashed.
- **Salt per password.** Every hash has a unique random salt. This prevents rainbow table attacks and makes identical passwords produce different hashes.
- **Work factor matters.** bcrypt cost factor of at least 12. The cost is one-time at login — users won't notice 200ms; attackers will notice it across millions of attempts.
- **Rate limit login attempts.** Per account AND per IP. After 5 failures, lock for 15 minutes. Don't tell the attacker which was wrong (username or password) — "Invalid credentials" not "User not found."
- **Password reset, not password retrieval.** Generate a time-limited, single-use token. Send it via email/SMS. Never send the old password — you can't, because you only store the hash.

### JWT (JSON Web Tokens)
- **Short-lived access tokens** (15-30 minutes). Refresh tokens for renewal (days to weeks).
- **Sign, don't just encode.** Always verify the signature. alg=none is a real attack vector — reject tokens without a signature.
- **Store secrets server-side.** Never embed signing keys in client code or commit them to version control.
- **Never store sensitive data in the payload.** The payload is base64-encoded, not encrypted. Anyone with the token can read it.
- **Invalidate on the server.** JWTs are stateless, which means you can't revoke them without a revocation list. If you need instant revocation, pair JWTs with a server-side session or token blacklist.
- **Set exp, iat, nbf.** Always. An expiring token limits the damage window if stolen.

### OAuth 2.0 / OIDC
- **Use the Authorization Code flow with PKCE.** Implicit flow is deprecated for a reason — it exposes tokens in the URL.
- **Validate the state parameter.** Prevents CSRF in the OAuth flow. Generate a random state, store it in the session, verify it on callback.
- **Validate the redirect URI.** Only allow pre-registered redirect URIs. Open redirectors in OAuth are a common attack vector.
- **Scope minimally.** Request only the scopes you need. "Read profile" not "Full account access."

### Session management
- **HttpOnly, Secure, SameSite cookies.** HttpOnly prevents JS access (XSS protection). Secure prevents transmission over HTTP. SameSite=Lax prevents CSRF for most cases.
- **Rotate session IDs on login.** Prevents session fixation attacks.
- **Set reasonable session timeouts.** Idle timeout (30 min) AND absolute timeout (8 hours). The user can re-authenticate.
- **Invalidate sessions on logout.** Server-side AND client-side (clear the cookie).

## Authorization

### Principle of least privilege
Every user, service, and process gets exactly the permissions it needs and nothing more. A background job that processes images doesn't need read access to user emails. A reporting dashboard doesn't need write access to the database.

### Authorization patterns

**Role-based (RBAC)** when roles are stable and permissions map cleanly: admin, editor, viewer. Simple to implement, hard to make fine-grained. Avoid role explosion — if you have 50 roles, rethink.

**Attribute-based (ABAC)** when permissions depend on attributes: "user can edit documents they own in their department." More flexible, more complex to evaluate and debug.

**Policy-based** when authorization logic is complex and needs to be externalized. OPA (Open Policy Agent), Cedar. Good for large systems with compliance requirements.

### Common authorization mistakes
- **Missing authorization check.** Every endpoint, every action, every data access must check authorization. "I forgot" is not a defense.
- **Client-side authorization only.** Hiding a button in the UI is not authorization. The API must enforce access independently.
- **Insecure Direct Object Reference (IDOR).** `GET /users/123/profile` — can user 456 call this with 123 and see someone else's profile? Authorization must check that the requesting user owns or is allowed to access the resource.
- **Privilege escalation via parameter injection.** `POST /users { role: 'admin' }` — if the client can set their own role, the system is broken. Never trust client-supplied authorization attributes.

## Input validation

### Never trust user input
Every piece of data that comes from outside the system (HTTP request, file upload, WebSocket message, environment variable, CLI argument) is hostile until validated. Validate at the boundary — the moment data enters the system. Once validated, internal code can trust it.

### Validation rules
1. **Validate type**: Is it a string, number, boolean? Not "string that looks like a number."
2. **Validate format**: Does it match the expected pattern? Email, URL, UUID, date.
3. **Validate range**: Is it within bounds? String length, number min/max, array size.
4. **Validate against a whitelist**: If only certain values are valid (enums, statuses), check against the allowed set. Whitelists are secure; blacklists always miss something.
5. **Validate business rules**: Is this combination of values valid? Start date before end date, quantity ≤ available stock.

### Injection prevention

**SQL injection**: Use parameterized queries. Always. Never concatenate user input into SQL strings. ORMs use parameterized queries by default — don't bypass them with raw queries unless you parameterize manually.

```typescript
// Never this
db.query(`SELECT * FROM users WHERE email = '${email}'`);

// Always this
db.query('SELECT * FROM users WHERE email = ?', [email]);
```

**XSS (Cross-Site Scripting)**: Escape output in the correct context. HTML escaping for HTML content, JS escaping for JavaScript strings, URL encoding for URLs. React's JSX escapes by default — don't bypass with `dangerouslySetInnerHTML` unless you've sanitized with DOMPurify.

**Command injection**: Never pass user input to shell commands, `exec`, `spawn`, or `eval`. If you must, use structured argument passing (not string concatenation) and validate against a strict whitelist.

**Path traversal**: Validate file paths. Reject `..`, absolute paths, and symlinks pointing outside the allowed directory. Resolve the canonical path and verify it's within the allowed root.

### File upload validation
- **Validate file type by content, not extension.** Check magic bytes, not the `.pdf` extension. Anyone can rename `virus.exe` to `report.pdf`.
- **Limit file size.** Set a hard limit before processing. Reject oversized files early — before they consume memory or disk.
- **Scan for malware if user-accessible.** Uploaded files that other users can download need malware scanning.
- **Store outside the web root.** Uploaded files should not be directly accessible via URL. Serve them through an authorized endpoint.
- **Rename uploaded files.** Don't use the user-supplied filename for storage. Generate a UUID. Store the original filename as metadata.

## Secrets management

### Secrets are not code
API keys, database passwords, signing keys, tokens, certificates — these are not code. They don't belong in source files, version control, or commit messages. A secret in git is a secret that was leaked.

### Where secrets live
1. **Environment variables** for deployment configuration. Injected at runtime, never committed.
2. **Secrets manager** (AWS Secrets Manager, HashiCorp Vault, Doppler) for production credentials. Access controlled, rotated, audited.
3. **.env files** for local development only. `.env` is in `.gitignore`. `.env.example` shows the structure without values.
4. **Never in**: source code, config files in the repo, Docker images, logs, error messages, client-side code.

### Secrets in client-side code
There is no such thing as a secret in client-side JavaScript. Anyone can open DevTools and read it. If a client-side API key has restricted permissions (domain-locked, read-only), it's not a secret. If it grants write access, it cannot live in client code. Proxy through a backend.

### Rotation
Every secret should have a rotation plan. How do you change it without downtime? Secrets that can't be rotated are secrets that can't be revoked. Support multiple active secrets during rotation windows.

## HTTP security headers

### The minimum set
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000; includeSubDomains
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Each header prevents a class of attacks:
- **CSP**: XSS mitigation — only execute scripts from trusted sources
- **X-Content-Type-Options**: Prevents MIME-type sniffing
- **X-Frame-Options**: Prevents clickjacking
- **HSTS**: Forces HTTPS, prevents SSL stripping
- **Referrer-Policy**: Controls referrer information leakage
- **Permissions-Policy**: Disables browser features you don't use

## Dependency security

### Supply chain attacks are real
Every dependency is code running with your application's privileges. A compromised dependency has access to your database, your filesystem, your users' data.

- **Audit regularly.** `npm audit`, `pip audit`, `cargo audit`. Fix critical and high vulnerabilities promptly.
- **Pin versions.** Use exact versions (`1.2.3`, not `^1.2.3`) and lockfiles committed to version control.
- **Minimize dependencies.** Every dependency is a trust decision and a maintenance burden. Does this package do enough to justify its attack surface? Left-pad was 11 lines.
- **Review what you add.** At minimum: is the package actively maintained, does it have a reasonable number of contributors, does it do what it claims?

## Logging and monitoring

### What to log
- Authentication events (login, logout, failed attempts, password changes)
- Authorization failures (access denied)
- Data mutations (create, update, delete — especially for sensitive data)
- Admin actions (all of them)
- Rate limit hits
- Input validation failures (may indicate probing)

### What NEVER to log
- Passwords (even hashed)
- Full tokens or session IDs (log a prefix for correlation)
- Credit card numbers, SSNs, PII
- API keys or secrets
- Full request bodies that may contain any of the above

### Log integrity
Logs should be append-only and immutable from the application. If an attacker compromises the app, they shouldn't be able to delete the evidence. Ship logs to a separate system.

## Security anti-patterns

### Rolling your own crypto
Never implement your own encryption, hashing, or random number generation. Use well-vetted libraries (libsodium, WebCrypto, bcrypt). Cryptography is hard in ways you cannot anticipate. Even experts make mistakes.

### Security by obscurity
Hiding the admin panel at `/admin-817263` is not security. Relying on attackers not finding your secrets is not security. Assume attackers know everything about your system except the keys.

### Trusting the client
Client-side validation is UX, not security. The API must validate independently. Client-side auth checks are convenience, not security. The server must enforce access independently.

### Overly permissive CORS
`Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` is never correct. If you need credentialed requests, specify exact origins. If you need public access, don't use credentials.

### Not failing closed
When an error occurs in a security check, the default should be DENY, not ALLOW. If the auth service is unreachable, the request should fail, not pass. "Fail open" is how attackers bypass security during outages.

### Hardcoded defaults
Default admin passwords (`admin/admin`), default API keys, default secrets. Every deployable system should force credential changes on first use. No defaults in production.

### Security as the last step
"We'll do a security review before launch." Security must be designed in, not reviewed in. A security review at the end finds problems that require architectural changes. Those changes don't happen because "we need to ship." The vulnerabilities ship instead.
