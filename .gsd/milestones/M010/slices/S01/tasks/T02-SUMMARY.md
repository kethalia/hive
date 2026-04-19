---
id: T02
parent: S01
milestone: M010
key_files:
  - src/lib/auth/session.ts
  - src/lib/auth/login.ts
  - src/__tests__/auth/session.test.ts
  - src/__tests__/auth/login.test.ts
key_decisions:
  - CoderToken upsert uses user.id as the lookup key for simplicity — one active token per user
  - deleteSession uses deleteMany instead of delete to avoid throwing on non-existent sessions
  - clearSessionCookie sets maxAge=0 and empty value rather than using a delete method for broader cookie store compatibility
duration: 
verification_result: passed
completed_at: 2026-04-18T19:47:58.370Z
blocker_discovered: false
---

# T02: Implement session CRUD with cookie management and login flow orchestration with API key fallback

**Implement session CRUD with cookie management and login flow orchestration with API key fallback**

## What Happened

Created `src/lib/auth/session.ts` with five functions: `createSession` generates a UUID sessionId and inserts a Session row with 30-day expiry; `getSession` reads the `hive-session` cookie, looks up the Session+User join, returns null for expired/missing sessions and deletes expired rows; `deleteSession` removes a session by sessionId; `setSessionCookie` sets an HttpOnly, Secure (prod only), SameSite=Lax, Path=/, 30-day maxAge cookie; `clearSessionCookie` expires the cookie with maxAge=0.

Created `src/lib/auth/login.ts` with `performLogin(coderUrl, email, password)` that orchestrates the full login flow: validates the Coder instance via `CoderClient.validateInstance`, authenticates via `CoderClient.login`, attempts `CoderClient.createApiKey` up to 3 times with fallback to session token as credential (R101), upserts User on the `(coderUrl, coderUserId)` unique constraint, upserts CoderToken with the encrypted credential via `encrypt()` using `TOKEN_ENCRYPTION_KEY` from env, creates a Session via `createSession`, and returns `{sessionId, user}`. A `getTokenEncryptionKey()` helper validates the key exists and is the correct length.

Created comprehensive test suites: 9 session tests (createSession UUID generation and 30-day expiry, getSession with no cookie/non-existent/expired/valid sessions, deleteSession, setSessionCookie with correct flags, Secure flag in production, clearSessionCookie with maxAge=0) and 7 login tests (successful login with API key, 3-retry fallback to session token, invalid Coder URL rejection, invalid credentials rejection, missing TOKEN_ENCRYPTION_KEY, success on second retry, trailing slash normalization).

## Verification

Ran `pnpm vitest run src/__tests__/auth/session.test.ts src/__tests__/auth/login.test.ts` — all 16 tests passed across 2 test files in 192ms.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/auth/session.test.ts src/__tests__/auth/login.test.ts` | 0 | ✅ pass (16/16 tests) | 192ms |

## Deviations

None. Implementation matched the task plan.

## Known Issues

None.

## Files Created/Modified

- `src/lib/auth/session.ts`
- `src/lib/auth/login.ts`
- `src/__tests__/auth/session.test.ts`
- `src/__tests__/auth/login.test.ts`
