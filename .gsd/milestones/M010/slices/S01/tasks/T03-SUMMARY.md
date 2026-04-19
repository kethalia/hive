---
id: T03
parent: S01
milestone: M010
key_files:
  - src/lib/auth/rate-limit.ts
  - src/lib/auth/actions.ts
  - src/lib/safe-action.ts
  - middleware.ts
  - src/__tests__/auth/rate-limit.test.ts
  - src/__tests__/auth/actions.test.ts
key_decisions:
  - authActionClient uses next-safe-action middleware chaining with ctx injection rather than a wrapper function — keeps the safe-action error handling pipeline intact
  - Rate limiter uses module-level Map (singleton per process) — acceptable for single-instance deployment per D041
  - Middleware checks cookie existence only (no DB/crypto) to stay edge-runtime compatible — full session validation deferred to authActionClient
duration: 
verification_result: passed
completed_at: 2026-04-18T19:50:44.346Z
blocker_discovered: false
---

# T03: Wire auth server actions (login/logout/getSession), Next.js middleware route protection, and sliding-window rate limiter

**Wire auth server actions (login/logout/getSession), Next.js middleware route protection, and sliding-window rate limiter**

## What Happened

Created `src/lib/auth/rate-limit.ts` with a sliding-window rate limiter using an in-memory Map<string, number[]> of timestamps. The `checkRateLimit` function prunes expired entries on each call and returns `{allowed, remaining, resetMs}`. A pre-configured `loginRateLimiter` instance enforces 5 attempts per minute per IP.

Extended `src/lib/safe-action.ts` with `authActionClient` that chains middleware to read the session cookie via `cookies()`, call `getSession()`, and inject `ctx.user` and `ctx.session` into the action context. Throws "Not authenticated" if no valid session exists, which safe-action catches and returns as `serverError`.

Created `src/lib/auth/actions.ts` with three server actions: `loginAction` (public, validates input with Zod, reads IP from x-forwarded-for/x-real-ip headers, checks rate limit, calls `performLogin`, sets session cookie on success), `logoutAction` (authenticated, deletes session and clears cookie), and `getSessionAction` (authenticated, returns user info from session context).

Created `middleware.ts` at project root for route protection. Passes through `/_next/*`, static assets, `/login`, and `/api/auth/*`. All other routes check for the `hive-session` cookie — if missing, redirects to `/login`. No Prisma or Node.js crypto imports, making it edge-runtime safe.

Created comprehensive test suites: 7 rate-limit tests (under limit, at limit, over limit, window expiry, sliding window partial expiry, key isolation, loginRateLimiter integration) and 8 actions tests (login success, login failure, rate limited, invalid input validation, IP header parsing, logout session deletion, getSession user info return, authActionClient rejection on missing session).

## Verification

Ran `pnpm vitest run src/__tests__/auth/rate-limit.test.ts src/__tests__/auth/actions.test.ts` — all 15 tests passed across 2 test files in 258ms. Verified `grep -q 'hive-session' middleware.ts` passes. Verified no Prisma or crypto imports in middleware (edge runtime safe).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/auth/rate-limit.test.ts src/__tests__/auth/actions.test.ts` | 0 | ✅ pass (15/15 tests) | 258ms |
| 2 | `grep -q 'hive-session' middleware.ts` | 0 | ✅ pass | 5ms |
| 3 | `grep -E 'prisma|crypto' middleware.ts` | 1 | ✅ pass (no edge-unsafe imports) | 5ms |

## Deviations

None. Implementation matched the task plan.

## Known Issues

None.

## Files Created/Modified

- `src/lib/auth/rate-limit.ts`
- `src/lib/auth/actions.ts`
- `src/lib/safe-action.ts`
- `middleware.ts`
- `src/__tests__/auth/rate-limit.test.ts`
- `src/__tests__/auth/actions.test.ts`
