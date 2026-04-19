# S01 — Auth Foundation: Login, Schema, Sessions — Research

**Date:** 2026-04-18
**Depth:** Deep research (new auth system, multiple new tables, middleware, session management — no prior auth code exists)

## Summary

Hive has zero authentication infrastructure. There is no User model, no middleware, no session handling, and no login UI. Every server action and API route uses a shared `CoderClient` constructed from `CODER_URL` and `CODER_SESSION_TOKEN` env vars. The app layout renders a sidebar for all visitors unconditionally.

S01 must introduce: (1) Prisma schema additions (User, CoderToken, Session tables), (2) a login page with Coder URL validation and email/password auth, (3) encrypted cookie-based database sessions, (4) Next.js middleware for route protection, (5) an authenticated safe-action client, and (6) a session indicator in the sidebar with logout. This is greenfield auth — no existing code to refactor, only integration points to wire into.

The approach is straightforward Next.js patterns (middleware, cookies, server actions) with Node.js `crypto` for AES-256-GCM encryption. No third-party auth library is needed — Coder's direct login API (`POST /api/v2/users/login`) and key creation API (`POST /api/v2/users/{id}/keys`) are simple REST endpoints that `CoderClient` can call directly.

## Recommendation

Build bottom-up: schema first, then encryption utilities, then session management, then login flow, then middleware, then UI. Each layer is independently testable.

Use Node.js `crypto` directly for AES-256-GCM (no library needed). Use Next.js `cookies()` API for session cookie management. Add `middleware.ts` at project root for route protection. Extend `next-safe-action` client with an auth middleware procedure that reads the session cookie and injects the user context.

Do NOT use iron-session, next-auth, or lucia — they add complexity without value since Coder's login API is the only auth provider and sessions are database-backed by design (D039).

## Implementation Landscape

### Key Files

- `prisma/schema.prisma` — Add User, CoderToken, Session models. User unique on `(coderUrl, coderUserId)`. CoderToken stores encrypted API key with IV, auth tag, version for optimistic locking. Session stores sessionId, userId, expiresAt.
- `src/lib/auth/encryption.ts` — **New.** AES-256-GCM encrypt/decrypt for API keys. Uses `TOKEN_ENCRYPTION_KEY` env var. Functions: `encrypt(plaintext): {ciphertext, iv, authTag}`, `decrypt({ciphertext, iv, authTag}): plaintext`. Detects auth tag mismatch for key rotation graceful degradation.
- `src/lib/auth/session.ts` — **New.** Session management: `createSession(userId)`, `getSession(cookieStore)`, `deleteSession(sessionId)`. Reads/writes encrypted session cookie. Cookie name: `hive-session`. HttpOnly, Secure (prod), SameSite=Lax.
- `src/lib/auth/login.ts` — **New.** Login flow orchestration: validate Coder URL via `GET /buildinfo`, authenticate via `POST /api/v2/users/login`, create API key via `POST /api/v2/users/{id}/keys`, upsert User + CoderToken, create Session.
- `src/lib/auth/actions.ts` — **New.** Server actions: `loginAction` (validates input, calls login flow, sets cookie), `logoutAction` (deletes session, clears cookie), `getSessionAction` (returns current user for client components).
- `src/lib/safe-action.ts` — Extend with `authActionClient` that reads session cookie, validates session, injects `ctx.user` and `ctx.coderToken`. Keep existing `actionClient` for the login action itself.
- `middleware.ts` — **New** (project root, not `src/`). Protect all routes except `/login`, `/api/auth/*`, `/_next/*`, `/favicon.ico`. Redirect unauthenticated requests to `/login`.
- `src/app/login/page.tsx` — **New.** Login page with Coder URL input, email, password fields. Client component with form state, loading, error display. Calls `loginAction`.
- `src/app/layout.tsx` — Conditionally render sidebar only for authenticated routes (or move sidebar into a `(dashboard)` route group layout).
- `src/components/app-sidebar.tsx` — Add session indicator (user email, Coder URL) and logout button.
- `src/lib/coder/client.ts` — Add methods: `validateInstance()` (GET /buildinfo), `login(email, password)`, `createApiKey(userId, lifetime)`. These are thin wrappers on the existing `request()` helper.

### Build Order

1. **Prisma schema + migration** — Everything depends on the data model. Add User, CoderToken, Session models. Run `prisma db push` to apply. This unblocks all downstream work.

2. **Encryption utilities** (`src/lib/auth/encryption.ts`) — Pure functions, independently unit-testable. No DB dependency. Unblocks token storage.

3. **CoderClient auth methods** — Add `validateInstance()`, `login()`, `createApiKey()` to existing client. Unit-testable with mocked fetch. Unblocks login flow.

4. **Session management** (`src/lib/auth/session.ts`) — Cookie read/write + DB session lookup. Depends on schema. Unblocks middleware and auth actions.

5. **Login flow orchestration** (`src/lib/auth/login.ts`) — Ties together CoderClient auth methods, encryption, User/CoderToken upsert, session creation. Integration-testable with mocked Coder API.

6. **Auth server actions** (`src/lib/auth/actions.ts`) + authenticated safe-action client — Wire login/logout into next-safe-action. Depends on login flow + session management.

7. **Middleware** (`middleware.ts`) — Route protection. Depends on session cookie format being defined.

8. **Login UI** (`src/app/login/page.tsx`) — Form that calls loginAction. Depends on auth actions.

9. **Layout + sidebar updates** — Session indicator, conditional sidebar, logout button. Depends on getSessionAction.

### Verification Approach

- **Unit tests:** encryption round-trip, session cookie generation/validation, CoderClient auth methods (mocked fetch), login flow error paths
- **Integration tests:** full login → session creation → session retrieval → logout cycle using mocked Coder API responses and real Prisma DB
- **Manual verification:** start dev server, navigate to any route → redirected to `/login`. Enter Coder URL → validated via /buildinfo. Enter credentials → land on dashboard with session indicator. Logout → back to login. Second browser/incognito → independent session.
- **Commands:** `pnpm test` (vitest), `pnpm dev` + manual browser testing, `prisma db push` for schema

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Encryption | Node.js `crypto` (built-in) | AES-256-GCM is a single function call. No npm package needed. |
| Session cookies | Next.js `cookies()` API | Built into the framework, works in server components, actions, and middleware. |
| Form validation | Zod (already in deps) + next-safe-action (already in deps) | Established pattern in the codebase — all server actions use this. |
| Rate limiting | In-memory Map with sliding window | S01 scope is rate limiting login attempts. A simple Map-based counter is sufficient for single-instance. If horizontal scaling needed later, move to Redis (already available via ioredis). |

## Constraints

- **Next.js 16 middleware** runs in Edge Runtime by default — cannot use Node.js `crypto` in middleware. Middleware should only check for session cookie existence (cheap), not decrypt tokens. Full session validation happens in server actions/API routes.
- **Prisma schema uses `@@map`** for snake_case table names — new models must follow this convention (e.g., `@@map("users")`, `@@map("coder_tokens")`, `@@map("sessions")`).
- **`TOKEN_ENCRYPTION_KEY`** must be exactly 32 bytes (256 bits) for AES-256. Validate at startup — hard fail if missing or wrong length.
- **Cookie size limit ~4KB** — only store session ID in cookie, not user data. All session data lives in DB.
- **`process.env.CODER_URL` is still read by `AppSidebar`** in the root layout (line 36) — this needs to switch to reading from the user's session or be removed.
- **No `middleware.ts` exists** — creating it at project root is the standard Next.js location.

## Common Pitfalls

- **Edge Runtime in middleware** — Don't try to use Prisma or Node.js crypto in middleware. Middleware should only read the cookie and redirect. Full validation in server-side code.
- **Cookie not available in `layout.tsx` on first render** — After setting the cookie in a server action, the current response already has the cookie but the layout may not re-render. Use `redirect()` from next/navigation after login to force a fresh server render.
- **Composite unique constraint syntax** — Prisma uses `@@unique([coderUrl, coderUserId])`, not a compound `@id`. The `id` should still be a UUID primary key for FK references.
- **Session cookie `Secure` flag** — Must be false in development (localhost is HTTP). Use `process.env.NODE_ENV === 'production'` to toggle.
- **GCM auth tag handling** — Node.js `crypto` returns the auth tag separately via `cipher.getAuthTag()`. Must store it alongside the ciphertext for decryption. Forgetting the auth tag means decryption silently fails.

## Open Risks

- **Next.js 16 middleware behavior** — Next.js 16 is very new (post-15). Middleware API should be stable but verify the `NextResponse.redirect` pattern and cookie access work as expected. The `cookies()` function from `next/headers` may have subtle differences from v15.
- **Rate limiting in serverless** — In-memory rate limiting resets on cold starts. Acceptable for S01 (single instance), but flagging for awareness. Redis-based rate limiting is natural for S02+ since ioredis is already a dependency.
- **Coder API version variance** — `POST /api/v2/users/login` response shape and `POST /api/v2/users/{id}/keys` request format may differ across Coder versions. The `GET /api/v2/buildinfo` validation step helps, but response schema differences could surface at runtime.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| next-safe-action | next-safe-action/skills@safe-action-advanced (179 installs) | available — `npx skills add next-safe-action/skills@safe-action-advanced` |
| next-safe-action | next-safe-action/skills@safe-action-client (174 installs) | available — `npx skills add next-safe-action/skills@safe-action-client` |
| Prisma | prisma/skills@prisma-client-api (5.8K installs) | available — `npx skills add prisma/skills@prisma-client-api` |
| Prisma | prisma/skills@prisma-database-setup (6.3K installs) | available — `npx skills add prisma/skills@prisma-database-setup` |

## Requirements Mapping

| Requirement | S01 Coverage | Research Notes |
|-------------|-------------|----------------|
| R088 — User authenticates via direct login API | Primary deliverable | Login flow: validate URL → POST /users/login → create API key → store encrypted |
| R089 — Per-user encrypted API key storage (AES-256-GCM) | Primary deliverable | `src/lib/auth/encryption.ts` — Node.js crypto, per-row IV + auth tag |
| R090 — User identity unique per (coderUrl, coderUserId) | Schema constraint | `@@unique([coderUrl, coderUserId])` on User model |
| R091 — Database-backed sessions with encrypted cookies | Primary deliverable | Session table + cookie with session ID. Cookie: HttpOnly, Secure(prod), SameSite=Lax |
| R099 — Coder URL validated via /buildinfo | Login pre-check | `CoderClient.validateInstance()` — GET /buildinfo, differentiate DNS/timeout/not-Coder |
| R100 — Login rate limiting (5/min per IP) | In-memory sliding window | Map-based counter, keyed by IP. Sufficient for single-instance. |
| R101 — Failed API key creation falls back to session token | Login fallback path | If POST /users/{id}/keys fails after login succeeds, store session token as temporary credential. Retry key creation 3x. |
| R106 — Logout deletes browser session only | Logout action | Delete Session row + clear cookie. User and CoderToken persist. |
