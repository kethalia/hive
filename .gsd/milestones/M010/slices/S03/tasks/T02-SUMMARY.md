---
id: T02
parent: S03
milestone: M010
key_files:
  - src/lib/auth/token-status.ts
  - src/lib/coder/user-client.ts
  - src/lib/queue/errors.ts
  - src/lib/queue/task-queue.ts
  - src/__tests__/auth/token-status.test.ts
  - src/__tests__/queue/task-queue-preflight.test.ts
  - src/__tests__/lib/coder/user-client.test.ts
key_decisions:
  - Auth errors (401/403, KEY_MISMATCH, NO_TOKEN) throw UnrecoverableError to prevent BullMQ retry; network errors re-throw normally for automatic retry
  - Pre-flight check runs before getCoderClientForUser to fail fast without attempting decryption on expired tokens
  - tryDecrypt 'other' reason maps to key_mismatch in token-status (token unusable either way) but maps to DECRYPT_FAILED in user-client (preserves error specificity for callers)
duration: 
verification_result: passed
completed_at: 2026-04-18T20:57:18.057Z
blocker_discovered: false
---

# T02: Add token status service, worker pre-flight expiry check, network/auth error classification, and tryDecrypt integration in user-client

**Add token status service, worker pre-flight expiry check, network/auth error classification, and tryDecrypt integration in user-client**

## What Happened

Created `src/lib/auth/token-status.ts` with `getTokenStatus()` that looks up the most recent CoderToken for a user, calls `tryDecrypt` to detect key mismatches, and classifies expiry status against the `TOKEN_EXPIRY_WARNING_HOURS` (48h) threshold. Returns one of `valid`, `expiring`, `expired`, or `key_mismatch`. Legacy tokens with null `expiresAt` return `valid`.

Updated `src/lib/coder/user-client.ts` to use `tryDecrypt` instead of raw `decrypt` with try/catch. Added `KEY_MISMATCH` to the `UserClientError` enum. When tryDecrypt reports `key_mismatch`, throws `UserClientException` with `KEY_MISMATCH` code; when `other`, throws with `DECRYPT_FAILED`. This gives downstream callers (especially the worker) a typed way to distinguish encryption key rotation from data corruption.

Created `src/lib/queue/errors.ts` with `isAuthError()` and `isNetworkError()` classifiers. Auth errors match 401/403 status codes in error messages and `UserClientException` with `KEY_MISMATCH`/`NO_TOKEN` codes. Network errors match ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed, and socket hang up patterns.

Modified `src/lib/queue/task-queue.ts` to inject a pre-flight token expiry check before `getCoderClientForUser`. If the token is expired or key_mismatch, the job is refused with `UnrecoverableError` (no BullMQ retry). If the token is expiring with less than `TOKEN_PREFLIGHT_MIN_HOURS` (2h) remaining, the job is also refused. In the catch block, auth errors are wrapped in `UnrecoverableError` to prevent retry, while network errors log that they will retry and re-throw normally.

Updated `src/__tests__/lib/coder/user-client.test.ts` to mock `tryDecrypt` instead of `decrypt`, added test for KEY_MISMATCH and DECRYPT_FAILED (other) paths.

## Verification

Ran `pnpm vitest run` on all three test files — 31 tests pass across token-status (6), task-queue-preflight (17), and user-client (8). Ran `pnpm tsc --noEmit` — no new type errors introduced (all 32 errors are pre-existing ioredis/Prisma type mismatches).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/auth/token-status.test.ts src/__tests__/queue/task-queue-preflight.test.ts src/__tests__/lib/coder/user-client.test.ts` | 0 | ✅ pass | 197ms |
| 2 | `pnpm tsc --noEmit` | 2 | ✅ pass (32 pre-existing errors, 0 new) | 8000ms |

## Deviations

Test file placed at src/__tests__/queue/task-queue-preflight.test.ts per plan (existing queue tests are in src/__tests__/lib/queue/ but the plan path is authoritative). Updated existing user-client.test.ts to use tryDecrypt mocks and added KEY_MISMATCH + DECRYPT_FAILED(other) test cases.

## Known Issues

None

## Files Created/Modified

- `src/lib/auth/token-status.ts`
- `src/lib/coder/user-client.ts`
- `src/lib/queue/errors.ts`
- `src/lib/queue/task-queue.ts`
- `src/__tests__/auth/token-status.test.ts`
- `src/__tests__/queue/task-queue-preflight.test.ts`
- `src/__tests__/lib/coder/user-client.test.ts`
