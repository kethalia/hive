---
estimated_steps: 38
estimated_files: 6
skills_used: []
---

# T03: Wire auth server actions, middleware route protection, and rate limiting

## Description

Integration layer: login/logout/getSession server actions via next-safe-action, Next.js middleware for route protection (cookie-only check, no Prisma in edge runtime), in-memory rate limiter for login attempts (5/min per IP), and an authenticated safe-action client that injects user context.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| performLogin (from T02) | Return structured error to client via safe-action | N/A (server-side) | N/A |
| getSession (from T02) | Redirect to /login (middleware) or return null (action) | N/A | N/A |

## Load Profile

- **Shared resources**: in-memory Map for rate limiting (keyed by IP)
- **Per-operation cost**: 1 DB read (session lookup) per authenticated request via authActionClient
- **10x breakpoint**: in-memory rate limiter resets on cold start — acceptable for single-instance (D041 notes Redis upgrade path)

## Negative Tests

- **Rate limiting**: 5 requests pass, 6th is rejected, window slides after 60s
- **Middleware**: requests to /login pass through, requests to /_next pass through, requests to / without cookie redirect to /login
- **Auth action client**: action with expired session returns error, action with valid session injects user context

## Steps

1. Create `src/lib/auth/rate-limit.ts` — sliding window rate limiter. `checkRateLimit(key: string, limit: number, windowMs: number): {allowed: boolean, remaining: number, resetMs: number}`. Uses a Map<string, number[]> storing timestamps. Prunes expired entries on each check. Export a `loginRateLimiter` instance configured for 5/min.
2. Create `src/lib/auth/actions.ts` with three server actions using `actionClient` (public, for login) and a new `authActionClient` (authenticated):
   - `loginAction` — Zod schema validates coderUrl (URL), email (email), password (min 1 char). Reads IP from headers (x-forwarded-for or x-real-ip). Checks rate limit. Calls `performLogin()`. On success, sets session cookie via `setSessionCookie()` and returns `{success: true}`. On failure, returns structured error.
   - `logoutAction` — uses `authActionClient`. Reads session cookie, calls `deleteSession()`, calls `clearSessionCookie()`, returns `{success: true}`.
   - `getSessionAction` — uses `authActionClient`. Returns `{user: {id, email, coderUrl}}` from context.
3. Extend `src/lib/safe-action.ts` — add `authActionClient` that chains a middleware: reads session cookie via `cookies()`, calls `getSession()`, if null throws (safe-action catches and returns error), if valid injects `ctx.user` and `ctx.session`. Keep existing `actionClient` unchanged.
4. Create `middleware.ts` at project root. Protect all routes except: `/login`, `/api/auth/*`, `/_next/*`, `/favicon.ico`, and static assets. Check for `hive-session` cookie existence only (no Prisma, no crypto — edge runtime constraint). If cookie missing, redirect to `/login`. If cookie present, allow through (full validation happens in server actions via authActionClient).
5. Create test file `src/__tests__/auth/rate-limit.test.ts` — test sliding window: 5 allowed, 6th rejected, window expiry resets count.
6. Create test file `src/__tests__/auth/actions.test.ts` — test loginAction with mocked performLogin (success, failure, rate limited), test that authActionClient rejects when no session.

## Must-Haves

- [ ] loginAction validates input with Zod, checks rate limit, calls performLogin, sets cookie
- [ ] logoutAction deletes session and clears cookie (R106)
- [ ] getSessionAction returns current user info
- [ ] authActionClient reads session cookie and injects user context, rejects if no valid session
- [ ] Rate limiter enforces 5 attempts/min per IP with sliding window (R100)
- [ ] Middleware redirects unauthenticated requests to /login, passes through public routes
- [ ] Middleware does NOT use Prisma or Node.js crypto (edge runtime safe)
- [ ] All tests pass

## Verification

- `pnpm vitest run src/__tests__/auth/rate-limit.test.ts` — all tests pass
- `pnpm vitest run src/__tests__/auth/actions.test.ts` — all tests pass
- `grep -q 'hive-session' middleware.ts` — middleware checks correct cookie name

## Inputs

- ``src/lib/auth/session.ts` — createSession, getSession, deleteSession, setSessionCookie, clearSessionCookie from T02`
- ``src/lib/auth/login.ts` — performLogin from T02`
- ``src/lib/safe-action.ts` — existing actionClient to extend`

## Expected Output

- ``src/lib/auth/rate-limit.ts` — sliding window rate limiter`
- ``src/lib/auth/actions.ts` — loginAction, logoutAction, getSessionAction server actions`
- ``src/lib/safe-action.ts` — extended with authActionClient`
- ``middleware.ts` — Next.js route protection middleware`
- ``src/__tests__/auth/rate-limit.test.ts` — rate limiter tests`
- ``src/__tests__/auth/actions.test.ts` — server action tests`

## Verification

pnpm vitest run src/__tests__/auth/rate-limit.test.ts src/__tests__/auth/actions.test.ts && grep -q 'hive-session' middleware.ts
