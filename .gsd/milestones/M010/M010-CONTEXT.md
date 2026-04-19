# M010: Multi-User Coder Authentication

**Gathered:** 2026-04-18
**Status:** Ready for planning

## Project Description

Replace the static `CODER_URL` and `CODER_SESSION_TOKEN` environment variables with a per-user, per-deployment authentication system. Each user provides their own Coder instance URL, authenticates with email/password via Coder's direct login API, and receives a long-lived API key stored encrypted in Postgres. All server actions, API routes, and background workers use the authenticated user's credentials instead of a shared env var.

## Why This Milestone

Hive currently operates as a single-operator tool with hardcoded Coder credentials. This blocks multi-user adoption and creates a security risk (shared credentials). M010 makes Hive a proper multi-user application where each user connects to their own Coder deployment with their own credentials.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open Hive, provide their Coder instance URL, log in with email/password, and land on a protected dashboard
- Submit tasks that run using their own Coder credentials — no env vars needed
- Install Hive as a PWA and receive push notifications when their Coder token is about to expire
- Log out without affecting in-flight background jobs

### Entry point / environment

- Entry point: Login page at app root (redirected when unauthenticated)
- Environment: Browser (PWA-capable)
- Live dependencies involved: Coder API (per-user deployment), Postgres, Redis (BullMQ)

## Completion Class

- Contract complete means: Unit and integration tests prove login flow, token storage/rotation, session management, and worker token lookup
- Integration complete means: Real login against a Coder instance, task submission using per-user token, worker executing with stored credentials
- Operational complete means: Token rotation job runs on schedule, push notifications fire on approaching expiry

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A user can log in to Hive with their Coder URL + credentials, submit a task, and the worker runs using their stored API key (not an env var)
- A second user on a different Coder deployment can do the same simultaneously without interference
- Token rotation creates a new key before the old one expires
- Push notification fires when token is 24h from expiry

## Scope

### In Scope

- Multi-user authentication via Coder's direct login API (`POST /api/v2/users/login`)
- Dynamic Coder URL — each user provides their own instance URL
- Per-user encrypted API key storage in Postgres (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY` env var)
- User identity unique per `(coderUrl, coderUserId)`, not per email
- Database-backed browser sessions with encrypted cookies
- Protected routes — middleware redirects unauthenticated users to login
- Login/logout UI — login page, session indicator, logout action
- Rewire CoderClient — all server actions, API routes, and workers use per-user tokens
- Task records linked to submitting user via `userId` FK
- Long-lived API key creation via `POST /api/v2/users/{id}/keys` (30-day default)
- Token rotation job at 75% lifetime (day ~22), transactional (create → update DB → delete old)
- Pre-flight token expiry check in workers (refuse jobs if token expires within 2h)
- Remove `CODER_SESSION_TOKEN` and `CODER_URL` from `.env` requirements
- PWA with web app manifest and service worker
- Push notifications for token expiry warnings (24h and 2h before)
- In-app expiry banner on next visit

### Out of Scope / Non-Goals

- Role-based access control / permissions within Hive
- Multi-tenant data isolation (users share the same Hive DB)
- User management admin UI (users self-serve via login)
- Team features (shared workspaces, shared task visibility)
- SSO/OIDC federation beyond Coder's own auth
- OAuth2 PKCE flow (rejected — requires experiment flag on Coder server)

## Architectural Decisions

### Auth Flow: Direct Login API

**Decision:** Use Coder's direct login API (`POST /api/v2/users/login`) instead of OAuth2 PKCE.

**Rationale:** OAuth2 PKCE requires the `oauth2` experiment flag on the Coder server, which many deployments won't have enabled. Direct login is available on all Coder instances. Hive handles raw credentials only in transit (HTTPS) and never stores passwords.

**Alternatives Considered:**
- OAuth2 PKCE with dynamic client registration — rejected because it requires experiment flag, adding deployment friction

### Session Storage: Database-Backed

**Decision:** Store sessions in Postgres with `User`, `CoderToken`, and `Session` tables. Session ID in encrypted cookie.

**Rationale:** Workers need persistent token access for background jobs. A user model enables task ownership tracking. Cookies have size limits and can't store the metadata needed for rotation.

**Alternatives Considered:**
- Encrypted cookie only (iron-session) — rejected because no user model, no persistent token for workers

### Token Lifecycle: Long-Lived API Keys with Rotation

**Decision:** After login, immediately create a 30-day API key via `POST /api/v2/users/{id}/keys`. Store encrypted. Rotate at 75% lifetime via BullMQ job.

**Rationale:** Coder session tokens expire in 24h by default. Workers processing tasks hours later would fail with expired tokens. API keys have configurable lifetime (30 days default) and provide stable credentials for background work.

**Alternatives Considered:**
- Use session tokens for workers — rejected due to short lifetime and no refresh mechanism
- Static service token for workers — rejected per user preference; users want per-user credential isolation

### Encryption: AES-256-GCM

**Decision:** Encrypt stored API keys with AES-256-GCM using Node.js crypto. Key from `TOKEN_ENCRYPTION_KEY` env var.

**Rationale:** GCM provides authenticated encryption (integrity + confidentiality). Single env var is the only required secret. Per-user graceful degradation if encryption key changes (detect GCM auth tag mismatch, invalidate token, redirect to login).

### User Identity: Composite Key

**Decision:** User uniqueness is `(coderUrl, coderUserId)`, not email.

**Rationale:** Same email can exist on multiple Coder deployments. Same Coder deployment can have multiple users. Email is not a stable identifier across deployments.

### Logout Behavior: Browser Session Only

**Decision:** Logout deletes the browser session only. API key and user record persist.

**Rationale:** In-flight worker jobs must not be disrupted by logout. The API key stays for background work and gets cleaned up by the rotation job. User re-login creates a new browser session without needing a new API key (verify existing key still works).

## Error Handling Strategy

### Login Failures
- Validate Coder URL via `GET /api/v2/buildinfo` before attempting login. Differentiate DNS failure, timeout, and not-a-Coder-instance.
- Rate limit login attempts (5/min per IP). Surface generic "invalid credentials" on 401.
- If API key creation fails after successful login, fall back to session token temporarily, retry key creation 3x, surface warning if all fail.

### Token Lifecycle Failures
- Rotation is transactional: create new key → update DB → delete old key. If DB update fails, delete new key from Coder and retry.
- Optimistic locking on CoderToken (version column) to prevent concurrent rotation races.
- If rotation fails repeatedly and key approaches expiry: push notification + in-app warning.
- Expired key: mark invalid in DB, fail queued jobs with `TOKEN_EXPIRED`, notify via push + show on next visit.

### Worker Token Failures
- Pre-flight expiry check: if token expires within 2h, attempt rotation first. If <1h and rotation fails, fail the job preemptively.
- Distinguish network errors (retry with backoff) from auth errors (fail immediately, don't retry).
- External key revocation treated same as expiry.

### Encryption Failures
- Missing `TOKEN_ENCRYPTION_KEY` = hard startup failure.
- Changed/rotated encryption key = per-user graceful degradation (detect GCM auth tag mismatch, mark token invalid, redirect to login). No app crash.

### Session Management
- Logout = delete browser session only. API key and user persist.
- Re-login with valid existing API key skips key creation (verify key still works first).
- CSRF protection on all mutations.

### Multi-Deployment Isolation
- Errors scoped to `(coderUrl, coderUserId)`. One deployment's failure doesn't affect another.
- Error messages always include which Coder instance failed.

### Notifications
- PWA push notifications for token expiry warnings (24h and 2h before).
- In-app banner on next visit if token is expired or near-expiry.

## Risks and Unknowns

- Coder's direct login API may behave differently across versions — need to test against actual deployment
- API key lifetime configuration varies per Coder deployment — rotation timing must adapt
- Push notification permission UX — users may deny, need graceful fallback
- Worker token lookup adds latency to job startup — should be negligible (single DB query)

## Existing Codebase / Prior Art

- `src/lib/coder/client.ts` — Current CoderClient using static `CODER_URL` and `CODER_SESSION_TOKEN` from env
- `src/lib/queue/connection.ts` — Redis/IORedis connection for BullMQ
- `src/lib/queue/worker.ts` — BullMQ worker that currently creates CoderClient from env
- `src/lib/safe-action.ts` — next-safe-action client (no auth context currently)
- `src/app/templates/actions.ts` — Server actions using CoderClient from env
- `src/lib/workspace/exec.ts` — Workspace execution using CoderClient
- `prisma/schema.prisma` — Current schema (no User model)
- `services/terminal-proxy/src/proxy.ts` — Terminal proxy using `CODER_SESSION_TOKEN` env var
- `src/components/app-sidebar.tsx` — Sidebar component (needs session indicator)

## Relevant Requirements

- R088-R109 — All M010 requirements (see REQUIREMENTS.md)
- R024 — Previously "no auth" out-of-scope, now superseded by M010

## Technical Constraints

- `TOKEN_ENCRYPTION_KEY` is the only required env var secret after M010
- Coder API keys cannot be refreshed — must create new and delete old
- Service worker requires HTTPS in production (localhost exempt for dev)
- Web Push API requires VAPID keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` env vars)

## Integration Points

- Coder API — login (`POST /api/v2/users/login`), API key management (`/api/v2/users/{id}/keys`), URL validation (`GET /api/v2/buildinfo`)
- Postgres — new User, CoderToken, Session tables via Prisma migration
- BullMQ — token rotation job queue, existing task/council queues need per-user token lookup
- Service Worker — PWA install, push notification subscription
- Web Push API — VAPID-based push notifications for token expiry

## Testing Requirements

- Unit tests: encryption/decryption, token rotation logic, login flow error handling, session management
- Integration tests: full login → key creation → session storage flow (mocked Coder API responses)
- E2E smoke: real login against a Coder instance if available, otherwise mocked
- Worker tests: per-user token lookup, expiry pre-flight checks, TOKEN_EXPIRED failure path

## Acceptance Criteria

### S01 — Auth Foundation
- User provides Coder URL, logs in with email/password, lands on protected dashboard
- Second user on different Coder deployment logs in simultaneously
- Invalid URLs and bad credentials show distinct, clear errors
- Login flow completes in under 3 seconds on healthy Coder instance

### S02 — Per-User Token Rewiring
- Submit a task — it runs end-to-end using submitting user's stored API key
- No `CODER_URL` or `CODER_SESSION_TOKEN` in `.env`
- Template push uses per-user token
- Terminal proxy uses per-user token

### S03 — Token Lifecycle & Resilience
- Token nearing expiry auto-rotates
- Worker refuses job with expired token (clear message, not generic 500)
- Encryption key change doesn't crash the app
- In-app expiry banner visible when token near-expiry

### S04 — PWA & Push Notifications
- App installs as PWA
- Push notification fires when token is 24h from expiry
- Notification is actionable (opens Hive login page)
- Login UI feels like an extension of Coder — minimal friction, familiar patterns

## Open Questions

- VAPID key generation: auto-generate on first startup or require in env? Lean toward auto-generate and persist to DB.
- Session duration: 8h default for browser sessions? Configurable?
- Terminal proxy auth: proxy currently uses env var directly — needs per-connection token lookup from the WebSocket handshake headers
