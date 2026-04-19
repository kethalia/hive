---
id: S01
parent: M010
milestone: M010
provides:
  - ["User/CoderToken/Session Prisma models", "AES-256-GCM encrypt/decrypt utilities", "CoderClient.validateInstance/login/createApiKey static methods", "createSession/getSession/deleteSession/setSessionCookie/clearSessionCookie", "performLogin orchestration (validate → login → createApiKey with fallback → upsert → session)", "loginAction/logoutAction/getSessionAction server actions", "authActionClient (authenticated safe-action client with user context injection)", "loginRateLimiter (5/min per IP sliding window)", "middleware.ts route protection (edge-safe cookie check)", "Login page UI at /login", "(dashboard) route group with sidebar"]
requires:
  []
affects:
  []
key_files:
  - ["prisma/schema.prisma", "src/lib/auth/encryption.ts", "src/lib/auth/session.ts", "src/lib/auth/login.ts", "src/lib/auth/rate-limit.ts", "src/lib/auth/actions.ts", "src/lib/safe-action.ts", "middleware.ts", "src/app/login/page.tsx", "src/app/(dashboard)/layout.tsx", "src/components/app-sidebar.tsx"]
key_decisions:
  - (none)
patterns_established:
  - ["authActionClient middleware chain: reads session cookie → validates via getSession → injects ctx.user/ctx.session into safe-action context. All authenticated server actions use this client.", "Edge-safe middleware: cookie existence check only (no Prisma, no crypto) for route protection. Full session validation deferred to authActionClient in server actions.", "Pure encryption functions: encrypt/decrypt take key as parameter, no env var coupling. Caller responsible for key retrieval and validation.", "CoderClient static auth methods: validateInstance/login/createApiKey are static (no instance needed) since they operate before a session exists.", "(dashboard) route group: sidebar renders only for authenticated routes. Login page has its own minimal layout."]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-18T20:01:38.591Z
blocker_discovered: false
---

# S01: Auth Foundation — Login, Schema, Sessions

**Full auth foundation delivered: Prisma schema (User/CoderToken/Session), AES-256-GCM encryption, CoderClient auth methods, session CRUD with cookie management, login flow orchestration with API key fallback, server actions via next-safe-action, edge-safe middleware route protection, sliding-window rate limiter, login page UI, and dashboard route group restructuring — 59 tests across 6 files, all passing.**

## What Happened

## T01: Schema, Encryption, CoderClient Auth Methods

Added three Prisma models: User (@@unique on coderUrl+coderUserId, UUID PK), CoderToken (encrypted ciphertext/iv/authTag as Bytes, version for optimistic locking), and Session (UUID sessionId, userId FK, expiresAt). All use @@map() for snake_case table names. Created pure AES-256-GCM encrypt/decrypt functions in `src/lib/auth/encryption.ts` — caller passes hex key, no env var coupling. Extended CoderClient with three static methods: validateInstance (GET /buildinfo, differentiates DNS/timeout/not-Coder), login (POST /users/login + GET /users/me), createApiKey (POST /users/{id}/keys, returns null on failure). Added auth response types to `src/lib/coder/types.ts`. 28 tests covering encryption round-trip, wrong-key detection, corrupted ciphertext, and all CoderClient auth paths.

## T02: Session CRUD and Login Flow Orchestration

Created `src/lib/auth/session.ts` with createSession (UUID + 30-day expiry), getSession (cookie read + Session+User join, auto-deletes expired), deleteSession, setSessionCookie (HttpOnly, Secure in prod, SameSite=Lax, 30-day maxAge), and clearSessionCookie (maxAge=0). Created `src/lib/auth/login.ts` with performLogin orchestrating: validateInstance → login → createApiKey (3 retries, fallback to session token per R101) → upsert User → upsert CoderToken (encrypted) → createSession. 16 tests covering all flows including retry/fallback paths.

## T03: Server Actions, Middleware, Rate Limiting

Created sliding-window rate limiter in `src/lib/auth/rate-limit.ts` — in-memory Map of timestamps, 5 attempts/min per IP (R100). Extended safe-action.ts with authActionClient that reads session cookie, validates via getSession, and injects ctx.user/ctx.session. Created three server actions: loginAction (Zod validation, rate limit check, performLogin, cookie set), logoutAction (delete session + clear cookie per R106), getSessionAction (return user info). Created edge-safe middleware.ts — cookie existence check only, no Prisma/crypto imports. 15 tests.

## T04: Login Page UI and Route Restructuring

Built login page at `src/app/login/page.tsx` with Coder URL/email/password inputs (shadcn Input), loading state, error display via shadcn Alert, useAction hook integration. Minimal centered login layout with Hive branding. Restructured routes into (dashboard) group — sidebar only renders for authenticated routes. Simplified root layout to HTML/fonts/TooltipProvider only. Updated AppSidebar to fetch session via getSessionAction (no more coderUrl prop), display user email and Coder URL in footer, logout button calling logoutAction. Fixed 3 test files for import path changes after route group restructure.

## Verification

## Automated Verification

All 59 tests pass across 6 test files (342ms total):
- `src/__tests__/auth/encryption.test.ts` — 14 tests (round-trip, wrong key, corrupted data, key validation)
- `src/__tests__/auth/coder-auth.test.ts` — 14 tests (validateInstance, login, createApiKey paths)
- `src/__tests__/auth/session.test.ts` — 9 tests (CRUD, cookie flags, expiry cleanup)
- `src/__tests__/auth/login.test.ts` — 7 tests (full flow, retry/fallback, error paths)
- `src/__tests__/auth/rate-limit.test.ts` — 7 tests (sliding window, key isolation, expiry)
- `src/__tests__/auth/actions.test.ts` — 8 tests (login/logout/getSession actions, auth rejection)

## Structural Checks (all pass)

- `pnpm prisma generate` — succeeds
- `test -f src/app/login/page.tsx` — login page exists
- `test -f src/app/(dashboard)/layout.tsx` — dashboard layout exists
- `! grep -q 'AppSidebar' src/app/layout.tsx` — sidebar removed from root layout
- `grep -q 'AppSidebar' src/app/(dashboard)/layout.tsx` — sidebar in dashboard layout
- `grep -q 'logoutAction' src/components/app-sidebar.tsx` — logout wired in sidebar
- `grep -q 'hive-session' middleware.ts` — middleware checks correct cookie name

## Requirements Advanced

- R088 — loginAction → performLogin → CoderClient.login orchestrates full Coder URL + email + password authentication flow
- R089 — CoderToken model stores AES-256-GCM encrypted ciphertext/iv/authTag in Postgres; performLogin encrypts API key before upsert
- R090 — User model has @@unique([coderUrl, coderUserId]) constraint; upsert keyed on this composite
- R091 — Session model in Postgres with UUID sessionId; hive-session HttpOnly cookie; authActionClient validates on every authenticated request
- R099 — performLogin calls CoderClient.validateInstance (GET /buildinfo) before attempting login; differentiates DNS/timeout/not-Coder errors
- R100 — loginRateLimiter enforces 5 attempts/min per IP via sliding window; loginAction checks before calling performLogin
- R101 — performLogin retries createApiKey 3 times; on total failure falls back to session token as stored credential
- R106 — logoutAction deletes Session row and clears cookie only; User and CoderToken rows persist in database

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Three test files (council-result-card, agent-stream-panel, task-detail-results) required import path fixes after the (dashboard) route group restructure in T04 — not in the original plan but necessary to maintain test integrity. No functional deviations from the slice plan.

## Known Limitations

Rate limiter is in-memory (module-level Map) — resets on process restart and doesn't share state across instances. Acceptable for single-instance deployment per D041; Redis upgrade path noted if horizontal scaling needed. Middleware checks cookie existence only — a tampered or expired cookie passes middleware but fails at authActionClient validation (defense in depth, not a security gap).

## Follow-ups

S02 (Per-User Token Rewiring): Replace all CODER_URL and CODER_SESSION_TOKEN env var usage with per-user credentials from the CoderToken table. Server actions and workers must resolve the authenticated user's decrypted API key for all Coder API calls. S03 (Token Lifecycle): Auto-rotation of API keys nearing expiry, worker rejection of expired tokens, encryption key change resilience.

## Files Created/Modified

None.
