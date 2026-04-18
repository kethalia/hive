---
estimated_steps: 65
estimated_files: 6
skills_used: []
---

# T02: Build token status service, add pre-flight expiry check to worker, and classify network vs auth errors

## Description

Creates the token status service (R102, R105 foundation), injects pre-flight token expiry checks into the task-queue worker (R098), and adds network vs auth error classification (R108). Also updates user-client.ts to use tryDecrypt for GCM mismatch detection.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| DB (token lookup) | Throw — pre-flight cannot proceed without token data | Prisma default timeout | N/A |
| tryDecrypt | Return 'key_mismatch' status — user must re-login | N/A | N/A |

## Negative Tests

- **Error paths**: Pre-flight with token expiring in 1h → job refused. Pre-flight with NULL expiresAt → job proceeds (legacy token). Auth error (401) → no retry. Network error (ECONNREFUSED) → retry.
- **Boundary conditions**: Token expiring in exactly 2h → job proceeds (boundary inclusive). Token expiring in 1h59m → job refused.

## Steps

1. Create `src/lib/auth/token-status.ts`:
   - `type TokenStatus = 'valid' | 'expiring' | 'expired' | 'key_mismatch'`
   - `async function getTokenStatus(userId: string): Promise<{ status: TokenStatus; expiresAt: Date | null }>` that:
     a. Looks up CoderToken by userId (most recent)
     b. If no token found, returns 'expired'
     c. Calls tryDecrypt — if key_mismatch, returns 'key_mismatch'
     d. Checks expiresAt: if null, returns 'valid' (legacy token); if past, returns 'expired'; if within TOKEN_EXPIRY_WARNING_HOURS, returns 'expiring'; else 'valid'
   - Import constants from `src/lib/constants.ts`, tryDecrypt from encryption.ts

2. Update `src/lib/coder/user-client.ts`:
   - Import `tryDecrypt` from encryption.ts
   - Replace the try/catch decrypt block with `tryDecrypt()` call
   - When result is `{ ok: false, reason: 'key_mismatch' }`, throw `UserClientException` with a new `KEY_MISMATCH` code (add to enum)
   - When result is `{ ok: false, reason: 'other' }`, throw with existing `DECRYPT_FAILED` code
   - This gives callers (especially the worker) a way to distinguish key rotation from corruption

3. Create `src/lib/queue/errors.ts`:
   - `function isAuthError(error: unknown): boolean` — checks for 401/403 status codes in error message, or `UserClientException` with `KEY_MISMATCH`/`NO_TOKEN` codes
   - `function isNetworkError(error: unknown): boolean` — checks for ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed, socket hang up patterns
   - Export both functions

4. Modify `src/lib/queue/task-queue.ts`:
   - Import `getTokenStatus` from token-status.ts, error classifiers from errors.ts, `TOKEN_PREFLIGHT_MIN_HOURS` from constants
   - Add pre-flight check after the userId validation block (before status update to 'running'):
     ```
     const tokenCheck = await getTokenStatus(userId);
     if (tokenCheck.status === 'expired' || tokenCheck.status === 'key_mismatch') {
       throw new Error(`[queue] Token ${tokenCheck.status} for user ${userId} — job cannot proceed`);
     }
     if (tokenCheck.status === 'expiring' && tokenCheck.expiresAt) {
       const hoursLeft = (tokenCheck.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
       if (hoursLeft < TOKEN_PREFLIGHT_MIN_HOURS) {
         throw new Error(`[queue] Token expires in ${hoursLeft.toFixed(1)}h for user ${userId} — below ${TOKEN_PREFLIGHT_MIN_HOURS}h minimum`);
       }
     }
     ```
   - In the catch block, before re-throwing: check `isAuthError(error)` — if true, log `[queue] Auth error — not retrying` and set job.discard() or throw UnrecoverableError from bullmq. If `isNetworkError(error)`, log `[queue] Network error — will retry`.
   - Import `UnrecoverableError` from 'bullmq' for auth errors to prevent retry.

5. Write tests in `src/__tests__/auth/token-status.test.ts`:
   - getTokenStatus with valid non-expiring token → 'valid'
   - getTokenStatus with token expiring in 24h → 'expiring'
   - getTokenStatus with expired token → 'expired'
   - getTokenStatus with no token → 'expired'
   - getTokenStatus with key mismatch → 'key_mismatch'
   - getTokenStatus with null expiresAt → 'valid' (legacy)

6. Write tests in `src/__tests__/queue/task-queue-preflight.test.ts`:
   - isAuthError matches 401/403 patterns
   - isNetworkError matches ECONNREFUSED/ETIMEDOUT patterns
   - Neither classifier matches generic errors
   - Pre-flight refuses job when token expired
   - Pre-flight refuses job when token <2h remaining
   - Pre-flight allows job when token >2h remaining

7. Run all tests: `pnpm vitest run src/__tests__/auth/token-status.test.ts src/__tests__/queue/task-queue-preflight.test.ts`

## Observability Impact

- Signals added: `[queue] Token expiry pre-flight failed for user X`, `[queue] Auth error — not retrying`, `[queue] Network error — will retry`
- How a future agent inspects: check worker logs for pre-flight refusal messages, check BullMQ job failure reason for auth vs network classification
- Failure state exposed: token status reason in pre-flight error message, error classification in catch block logs

## Inputs

- ``src/lib/auth/encryption.ts` — tryDecrypt function from T01`
- ``src/lib/constants.ts` — TOKEN_PREFLIGHT_MIN_HOURS, TOKEN_EXPIRY_WARNING_HOURS from T01`
- ``src/lib/coder/user-client.ts` — existing getCoderClientForUser to update with tryDecrypt`
- ``src/lib/queue/task-queue.ts` — existing worker processor to inject pre-flight check`
- ``prisma/schema.prisma` — CoderToken.expiresAt field from T01`

## Expected Output

- ``src/lib/auth/token-status.ts` — getTokenStatus function and TokenStatus type`
- ``src/lib/coder/user-client.ts` — updated to use tryDecrypt, new KEY_MISMATCH error code`
- ``src/lib/queue/errors.ts` — isAuthError and isNetworkError classifiers`
- ``src/lib/queue/task-queue.ts` — pre-flight check and error classification in worker`
- ``src/__tests__/auth/token-status.test.ts` — token status tests`
- ``src/__tests__/queue/task-queue-preflight.test.ts` — pre-flight and error classifier tests`

## Verification

pnpm vitest run src/__tests__/auth/token-status.test.ts src/__tests__/queue/task-queue-preflight.test.ts
