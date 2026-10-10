---
name: auth-protocols
description: OAuth 2.0, OIDC, JWT, sessions, WebAuthn/passkeys, RBAC/ABAC, API keys, and auth architecture. Authentication is hard; authorization is harder.
version: 1.0.0
tags: [auth, oauth, oidc, jwt, sessions, webauthn, rbac, authorization]
extends: []
conflicts: []
requires: []
provides: [auth-protocols, authentication, authorization, oauth, jwt, sessions, webauthn]
priority: 5
---

# Auth Protocols

## When to use this skill
Activate when:
- Implementing authentication (login, registration, password reset)
- Implementing OAuth 2.0 or OpenID Connect
- Designing JWT-based auth
- Setting up session management
- Implementing RBAC or ABAC authorization
- Adding WebAuthn / passkeys
- Designing API key authentication for B2B APIs
- Choosing between auth providers (Auth0, Clerk, WorkOS, Firebase Auth)
- Reviewing auth code for security vulnerabilities
- Designing multi-tenant authorization

## First principle: auth is the hardest part of any application

Authentication (who you are) and authorization (what you can do) are where most security vulnerabilities live. They're also the first thing every developer implements from scratch because "it's just a login form" — and that's where the problems start.

Auth is not "just a login form." Auth is: password hashing, brute force protection, session management, CSRF, XSS, token rotation, refresh tokens, revocation, multi-tenancy, role hierarchies, permission granularity, audit logging, multi-factor, recovery flows, and doing all of this correctly across web, mobile, and API contexts simultaneously.

**Default recommendation: use a battle-tested auth provider** (Auth0, Clerk, WorkOS, Firebase Auth) unless you have a specific reason not to. They've solved the hard problems. You will not do better in a sprint.

## Authentication fundamentals

### Password storage
- **Never store plaintext passwords.** This is not a guideline. It is a crime in some jurisdictions.
- **bcrypt, argon2, or scrypt.** These are purpose-built for password hashing. They are intentionally slow to resist brute force.
- **Not SHA-256. Not MD5.** These are fast hashes. Fast is the enemy of password storage.
- **Salting**: Every password gets a unique random salt. Prevents rainbow table attacks. bcrypt/argon2 handle this automatically.
- **Peppering** (optional): An additional secret stored outside the database (HSM, env var). If the database is compromised, the attacker still can't crack passwords without the pepper. Adds operational complexity — losing the pepper means all passwords are invalid.

```javascript
// Correct
const hash = await bcrypt.hash(password, 12); // 12 rounds
const isValid = await bcrypt.compare(password, hash);

// Incorrect — never do this
const hash = crypto.createHash('sha256').update(password).digest('hex');
```

### Brute force protection
- **Rate limiting per account**: 5 failed attempts → lock for 15 minutes. 20 failed attempts → lock for 1 hour. Notify the user.
- **Rate limiting per IP**: Prevents distributed attacks. But don't lock legitimate users who share an IP.
- **Progressive delays**: After each failed attempt, add a delay. 1s, 2s, 4s, 8s. This throttles automated attacks without locking legitimate users.
- **Never reveal whether the account exists**: "Invalid email or password" — not "No account found with that email" vs "Incorrect password." The former prevents account enumeration.

### Multi-factor authentication (MFA)
Three factors: something you know (password), something you have (phone, security key), something you are (biometric).

- **TOTP** (Time-based One-Time Password): Google Authenticator, Authy. 6-digit codes that change every 30 seconds. The most common second factor. Cheap. Works offline. Phishable (user can be tricked into entering the code on a fake site).
- **WebAuthn / FIDO2**: Hardware security keys (YubiKey) or platform authenticators (Touch ID, Windows Hello). **Phishing-resistant.** The browser verifies the origin — a fake site can't complete the ceremony. This is the gold standard.
- **SMS**: Better than nothing. Worse than everything else. SIM swapping is real. SMS is not encrypted. Use TOTP or WebAuthn instead.
- **Recovery codes**: One-time use backup codes. Generate on MFA setup. User stores them safely. When they lose their phone, they use a recovery code.

### Passwordless
- **Magic links**: Email a link. Click it. You're logged in. Simple. Depends on email security. Link must be single-use and expire quickly (< 15 min).
- **One-time codes**: Email or SMS a 6-digit code. Same as magic links but manual entry. More friction, same security profile.
- **WebAuthn / passkeys**: The future. A cryptographic key pair stored on the user's device. Unlocked with biometric or PIN. Phishing-resistant. Cross-device sync (Apple/Google password managers). This is what you should build toward.

## OAuth 2.0

OAuth 2.0 is a delegation protocol. "Application A wants to access Resource B on behalf of User C." It is NOT an authentication protocol. OpenID Connect (built on OAuth 2.0) is the authentication protocol.

### The grant types (and when to use each)

**Authorization Code (with PKCE)** — the only grant type you should use for web and mobile apps.
```
1. User clicks "Log in with Google"
2. App redirects to Google with client_id, redirect_uri, scope, code_challenge (PKCE)
3. User authenticates on Google
4. Google redirects back with ?code=abc123
5. App exchanges code + code_verifier for access_token + refresh_token
6. App uses access_token to call Google APIs
```
- The code is exchanged server-to-server, never exposed to the browser.
- PKCE (Proof Key for Code Exchange) prevents authorization code interception. Mandatory for mobile apps. Should be mandatory everywhere.
- **Never use the implicit grant.** It returns tokens directly in the URL fragment. It's deprecated. It's insecure.

**Client Credentials** — server-to-server.
```
1. Backend service calls /token with client_id + client_secret
2. Receives access_token
3. Uses access_token to call another service
```
No user involved. For machine-to-machine communication.

**Refresh Token** — keeps users logged in.
```
1. Access token expires (short-lived: 15-60 minutes)
2. App calls /token with refresh_token
3. Receives new access_token (+ optionally new refresh_token)
4. If refresh token is revoked or expired, user must re-authenticate
```
- Refresh tokens are long-lived (days/weeks). Store them securely (httpOnly cookie, never localStorage).
- **Refresh token rotation**: Each refresh returns a new refresh token. The old one is invalidated. If an old refresh token is used (stolen), invalidate the entire grant (user must re-authenticate). This detects token theft.

### OAuth scopes
Scopes limit what an access token can do. `read:user`, `write:orders`, `admin:users`. They're coarse-grained — scope creep is a real problem. Apps request more scopes than they need "just in case." Users approve without reading. Design your scopes to be granular but not so granular that users need 47 scopes to use a basic feature.

### Token storage (web)
- **Access token**: In memory (JS variable). Never in localStorage (accessible to any JS, including XSS).
- **Refresh token**: In an httpOnly, Secure, SameSite=Strict cookie. Not accessible to JavaScript. Sent only to the token endpoint.
- **Never in the URL.** Tokens in URLs appear in browser history, server logs, referrer headers, and analytics.

### Token storage (mobile)
- **Secure storage**: iOS Keychain, Android Keystore. Encrypted by the OS.
- **Never in SharedPreferences, UserDefaults, or AsyncStorage.** These are unencrypted.

## OpenID Connect (OIDC)

OIDC is a thin identity layer on top of OAuth 2.0. It adds an `id_token` (a JWT containing user identity) and a `/userinfo` endpoint.

### ID Token vs. Access Token
- **ID Token** (JWT): Proves the user authenticated. Contains `sub` (user ID), `iss` (issuer), `aud` (audience — must be your client ID), `exp` (expiration), `iat` (issued at). **For the client application.** Never sent to APIs.
- **Access Token** (typically a JWT, but opaque is fine): Proves the client is authorized. Contains `sub`, `scopes`, `exp`. **For the resource server (API).** Never consumed by the client application.

The client validates the ID token (to know who the user is). The API validates the access token (to know what the client can do). They are different tokens with different purposes.

### ID Token validation (non-negotiable)
Every ID token must be validated:
1. **Signature**: Verify the JWT signature using the provider's public key (JWKS endpoint).
2. **Issuer** (`iss`): Must match the expected provider URL. `https://accounts.google.com`, not `https://accounts.goog1e.com` (notice the 1).
3. **Audience** (`aud`): Must include your client ID. The token was issued to you, not to someone else.
4. **Expiration** (`exp`): Token must not be expired. Allow a small clock skew (< 5 minutes).
5. **Not Before** (`nbf`): If present, token must not be used before this time.
6. **Nonce** (if sent in auth request): Must match. Prevents replay attacks.

Skipping any of these validations is a critical security vulnerability.

## JWT (JSON Web Tokens)

### When to use JWT
- **Stateless API authentication**: The API validates the JWT without calling the auth server. Good for microservices, serverless.
- **Delegated access**: Service A issues a JWT that Service B validates.
- **One-time tokens**: Password reset, email verification, invite links. Short-lived, single-use.

### When NOT to use JWT
- **As a session token stored in localStorage**: XSS reads localStorage. Use httpOnly cookies.
- **For long-lived sessions**: JWTs can't be revoked easily (that's the point — they're stateless). If you need to revoke sessions immediately (kick user out, change permissions now), JWTs are the wrong tool.
- **As a database**: Putting user profile, preferences, and last 10 orders in a JWT creates a massive token sent on every request. The JWT should have enough to identify and authorize, not replace your database.

### JWT best practices
- **Short-lived**: 15-60 minutes. Use refresh tokens for renewal.
- **Small**: The JWT is sent on every request. Keep it under a few kilobytes.
- **Asymmetric signing (RS256, ES256)**: The auth server signs with a private key. APIs verify with a public key. Services don't need the private key. Never use `none` algorithm (yes, some libraries allowed `alg: "none"` — it means unsigned, and it's an instant critical CVE).
- **Always validate**: Signature, issuer, audience, expiration. Every time. No exceptions.
- **No sensitive data**: The JWT body is base64-encoded, not encrypted. Anyone can read it (just not modify it). If you need encrypted payloads, use JWE (JSON Web Encryption), but you probably don't need JWTs at all if that's the case.

### JWT revocation
The fundamental problem with JWTs: they're valid until they expire. If you need to revoke a JWT before expiry:
- **Token blacklist**: Maintain a list of revoked token IDs (jti). Check on every request. This makes your API stateful and defeats the purpose of JWT.
- **Short expiry + refresh**: The JWT expires in 15 minutes. Revocation happens at the refresh step (don't issue a new access token if the session is revoked). The user is logged out within 15 minutes max.
- **If immediate revocation is required, don't use JWT.** Use opaque tokens with an introspection endpoint, or sessions.

## Session management

### Cookie-based sessions (the traditional web)
```
1. User logs in. Server creates session. Stores session data in Redis/DB.
2. Server sets cookie: Set-Cookie: session_id=<random128bit>; HttpOnly; Secure; SameSite=Lax; Path=/
3. Browser sends cookie on every request.
4. Server looks up session_id → user. Authenticates request.
```

**Cookie attributes:**
- `HttpOnly`: Not accessible to JavaScript. Prevents XSS from stealing the session.
- `Secure`: Only sent over HTTPS. Never over HTTP.
- `SameSite=Lax`: Sent on same-site requests + top-level navigation GET requests. Prevents CSRF in most cases. `SameSite=Strict` is more secure but breaks cross-site link clicks (clicking a link to your app from email won't be authenticated).
- `Path=/`: Cookie sent for all paths. Can restrict to `/api` if appropriate.
- `Domain`: Omit to restrict to the exact origin. Setting it allows subdomains.

### Session fixation prevention
**Regenerate the session ID on login.** If the session ID doesn't change, an attacker can fixate a session, trick the user into logging in, and now the attacker's session is authenticated as the user.

```javascript
// Before login: session_id = old_id (unauthenticated)
// After login: session_id = new_id (authenticated)
// Now old_id maps to nothing. Fixation defeated.
```

### Session timeout
- **Absolute timeout**: Session expires N hours after creation regardless of activity. 8-12 hours for consumer apps. 1-4 hours for sensitive apps (banking, healthcare).
- **Idle timeout**: Session expires after N minutes of inactivity. 15-30 minutes for sensitive apps.
- **Extend on activity**: Renew the expiry on each request (with a minimum interval — not every request refreshes, or you can't implement idle timeout).

### Logout
- **Client side**: Delete the cookie. Clear in-memory token.
- **Server side**: Delete the session from the store. If using JWT, add the jti to a blacklist (until the token would have expired).
- **Global logout**: If the user changes their password, invalidate ALL sessions for that user. This is why you track all active sessions.

## Authorization (what you can do)

### RBAC (Role-Based Access Control)
Users have roles. Roles have permissions. `alice → editor → [create_post, edit_post, delete_own_post]`.

Roles are coarse-grained. They work until they don't. "Editors can delete posts" → "Except Bob. Bob is a special editor who can't delete posts." Now you need an exception, and your clean role system has a `can_delete_posts: false` override. RBAC is simple but brittle.

### ABAC (Attribute-Based Access Control)
Access is determined by attributes: user attributes (role, department, clearance), resource attributes (classification, owner, created_date), environment attributes (time of day, IP address, device trust).

"Document can be read if: user.clearance >= document.classification AND user.department == document.department."

ABAC is more flexible than RBAC and much more complex. Implement it when you need fine-grained, context-aware access control. Otherwise, RBAC is sufficient.

### ReBAC (Relationship-Based Access Control)
Access based on relationships in a graph. "Alice is an editor of document X." "Document X is in folder Y." "Bob is a viewer of folder Y → Bob can view document X."

Used by Google's Zanzibar (powers Google Drive, YouTube, etc.). Modeled as: `(object, relation, user)`. "Does Alice have `viewer` on document X?" The system walks the graph: Alice → editor of doc X → editor implies viewer → yes.

ReBAC is the most powerful model for applications with deeply nested resources and inherited permissions.

### Implementing authorization
```javascript
// Anti-pattern: inline checks
if (user.role === 'admin') {
  deletePost(postId);
}

// Pattern: centralized policy
const decision = authorize(user, 'delete', post);
if (decision.allowed) {
  deletePost(postId);
} else {
  throw new ForbiddenError(decision.reason);
}
```

Authorization must be centralized. Not scattered across controllers, middlewares, and if-statements. One place to answer "can this user do this action on this resource?" One place to audit, test, and change.

### Multi-tenancy authorization
In a multi-tenant app, every request must be scoped to a tenant. The user belongs to a tenant. The resource belongs to a tenant. Authorization includes the tenant check:

```javascript
if (user.tenant_id !== resource.tenant_id) {
  throw new ForbiddenError('Cross-tenant access denied');
}
```

This check must happen on EVERY request. A missing tenant check is a data leak across organizations. This is the most common multi-tenant vulnerability.

The database should enforce this too. Row-level security (RLS) in PostgreSQL:
```sql
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

Never rely on application-level checks alone. Defense in depth.

## API keys and machine-to-machine auth

### API key design
For B2B APIs where other companies call your service:
- **Generate cryptographically random keys**: 128+ bits of entropy. `sk_live_abc123def456...` (32+ characters).
- **Prefix for identification**: `sk_live_` (Stripe's pattern) makes it obvious what the key is for and differentiates test vs. production.
- **Store hashed**: Hash API keys in the database like passwords. If your database is compromised, the keys are not exposed.
- **Show once**: Display the key once on creation. Never show it again. The user can generate a new one.
- **Scoped to resources**: An API key should have access to specific projects, not everything. `this_key → [project_123, project_456] read:orders, write:orders`.
- **Rate limit per key**: Don't let one customer overwhelm your API. Rate limit per API key.
- **Revocable**: The customer can revoke a key. You can revoke a key. Instant. No propagation delay.

### JWT for service-to-service
Instead of API keys, services authenticate each other with JWTs signed by an internal CA.

```
Service A:
1. Signs a JWT with its private key: { sub: 'service-a', aud: 'service-b', exp: now+5min }
2. Sends JWT to Service B

Service B:
1. Validates JWT signature using Service A's public key
2. Checks iss, aud, exp
3. Trusts the claims
```

This is zero-trust service communication. The JWT is the identity. No shared secrets between services.

## Passwords: reset, change, and policies

### Password reset flow (forgot password)
```
1. User enters email
2. Generate a cryptographically random token
3. Store token hash in DB with expiry (15-60 minutes)
4. Email a link: /reset-password?token=<random>
5. User clicks link. Validate token (hash and compare). Check expiry.
6. User enters new password. Hash it. Store it.
7. Invalidate token. Invalidate all sessions for this user (force re-login everywhere).
```

**Important:**
- Always return "If an account exists, we've sent a reset link." Don't reveal whether the email is registered.
- Reset tokens are single-use.
- Rate limit password reset attempts per IP and per email.

### Password change flow (user is logged in)
```
1. User enters current password + new password
2. Verify current password
3. Validate new password meets policy
4. Store new password hash
5. Optionally: invalidate all other sessions (force re-login on other devices)
```

### Password policies (the modern view)
NIST SP 800-63B (2024) recommendations:
- **Minimum length: 8 characters.** Longer is better (15+).
- **Maximum length: At least 64 characters.** No reason to limit below this.
- **No complexity requirements.** "Must include uppercase, lowercase, number, special character" is counterproductive. Users add `1!` to the end of their password and it doesn't help.
- **No mandatory rotation.** Forcing password changes every 90 days means users choose weaker passwords and increment a number.
- **Check against known breaches.** Use Have I Been Pwned API (k-anonymity model — you only send the first 5 characters of the SHA-1 hash, not the password).
- **MFA solves what complexity requirements can't.** If a password is compromised, MFA still prevents access. Invest in MFA, not arcane password rules.

## WebAuthn and passkeys

WebAuthn is the W3C standard for passwordless authentication. Passkeys are the consumer-friendly implementation (synced via Apple/Google/Microsoft password managers).

### Registration ceremony
```
1. Server generates a challenge (random bytes)
2. Client calls navigator.credentials.create({ challenge, user, rp, ... })
3. User verifies with biometric/PIN
4. Device generates a new key pair. Private key stays on device. Public key sent to server.
5. Server stores: credential ID, public key (COSE format), sign count
```

### Authentication ceremony
```
1. Server generates a new challenge
2. Client calls navigator.credentials.get({ challenge, allowCredentials })
3. User verifies with biometric/PIN
4. Device signs the challenge with the private key
5. Server verifies signature using stored public key. Verifies challenge matches. Updates sign count.
```

### Why WebAuthn is phishing-resistant
The browser includes the origin (`rpId`) in the signature. The private key will only sign for the registered origin. A fake website with a different origin can't complete the ceremony. The user can't be tricked into authenticating to the wrong site — their device won't allow it.

### Passkeys
Passkeys are WebAuthn credentials that sync across devices via platform providers (iCloud Keychain, Google Password Manager). The user registers once on their phone. They can authenticate on their laptop without re-registering because the passkey synced. The UX is: "Sign in with passkey" → biometric → authenticated.

This is the destination you should be building toward. Usernames and passwords are a legacy pattern we're growing out of.

## Auth architecture patterns

### The token-based SPA pattern
```
Frontend (SPA) ↔ Auth Provider (Auth0/Clerk) ↔ Backend API

1. User logs in via Auth0 (redirect)
2. Auth0 returns tokens to the frontend
3. Frontend sends access_token to backend API as Bearer token
4. Backend validates access_token (JWT validation or introspection)
5. Backend extracts user identity from token. Authorizes request.
```

The backend never sees the user's password. It never handles login forms. It only validates tokens. This is the pattern Auth0/Clerk/WorkOS enable.

### The BFF (Backend For Frontend) pattern
```
Browser ↔ BFF (same origin) ↔ Auth Provider ↔ API

1. User logs in. BFF handles OAuth flow.
2. BFF stores tokens server-side (in session).
3. BFF sends session cookie to browser (httpOnly, Secure, SameSite).
4. Browser calls BFF. BFF injects access_token and forwards to API.
5. API validates access_token.

Benefits:
- Tokens never reach the browser (XSS can't steal them)
- BFF can refresh tokens transparently
- BFF can add additional authorization logic
- Simpler frontend (just use cookies, like traditional web apps)
```

This is the most secure pattern for SPAs. The tokens never reach the browser. The tradeoff is you need a BFF (a thin backend serving your frontend).

## Auth anti-patterns

### Building your own auth
"We just need a login form. It'll take a day." Months later: you've implemented password reset, email verification, MFA, session management, brute force protection, and OAuth integration. And there are still bugs. Use an auth provider unless auth IS your product.

### Storing tokens in localStorage
localStorage is accessible to any JavaScript running on the page. This includes third-party scripts (analytics, error tracking, chatbot widgets) and XSS-injected scripts. If a token is in localStorage, assume it can be stolen. Use httpOnly cookies or in-memory storage.

### Long-lived tokens without revocation
JWTs that last 30 days. If a token is compromised, the attacker has 30 days of access. You can't revoke it. Short-lived access tokens with refresh token rotation are the correct pattern.

### Using JWT as a session database
```json
{
  "sub": "usr_123",
  "email": "...",
  "name": "...",
  "plan": "enterprise",
  "permissions": ["...", "...", "..."],
  "preferences": { "...": "..." }
}
```
This token is now 2KB. Sent on every request. When the user upgrades their plan, the token is stale until it expires. Permissions are cached in the token. The JWT should be: `{ sub, iss, aud, exp, tenant_id }`. Everything else goes in the database.

### Ignoring CSRF
"SameSite=Strict cookies prevent CSRF." Mostly, but not on all browsers, and not for all request types. If you're using cookies for authentication, implement CSRF protection: double-submit cookie pattern, or custom header requirement (`X-CSRF-Token`). It's one middleware. It's not optional.

### Not validating JWT locally
"I use Auth0's library. It validates for me." The library only validates if you configure it to. A library accepting `algorithms: ['RS256', 'HS256']` will accept a token signed with a symmetric key if you provide the public key as the secret. This allows anyone to forge tokens. Validate properly or don't use JWT.

### Rolling your own crypto
"I'll encrypt session data with AES-CBC." No. Use established libraries and protocols. Cryptography is not a domain where "how hard can it be?" leads anywhere good.

## Auth provider comparison

| Provider | Best for | Notes |
|---|---|---|
| **Auth0** | Enterprises, complex needs | Powerful, complex, expensive at scale |
| **Clerk** | Modern SaaS, React apps | Beautiful drop-in UI. Developer experience first. |
| **WorkOS** | Enterprise SSO (SAML/OIDC) | AuthKit for consumer + enterprise. |
| **Firebase Auth** | Mobile-first, Google ecosystem | Free tier is generous. Mobile SDKs excellent. |
| **Supabase Auth** | Supabase users, Postgres-native | Integrated with RLS. GoTrue under the hood. |
| **NextAuth / Auth.js** | Next.js apps, OSS | Self-hosted. Flexible. You own the data. |
| **Lucia** | OSS, framework-agnostic | Library, not a service. Build your own with good primitives. |

**Recommendation for new projects:** Clerk for SaaS (best DX, modern). Supabase Auth if already using Supabase. Auth0 for enterprises with complex SSO requirements. Auth.js for self-hosted / open source projects.
