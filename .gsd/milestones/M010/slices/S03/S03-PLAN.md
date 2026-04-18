# S03: Token Lifecycle & Resilience

**Goal:** Token nearing expiry auto-rotates. Worker refuses job with expired token (clear message). Encryption key change doesn't crash app. In-app expiry banner visible.
**Demo:** Token nearing expiry auto-rotates. Worker refuses job with expired token (clear message). Encryption key change doesn't crash app. In-app expiry banner visible.

## Must-Haves

- `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts` — all tests pass (tryDecrypt, token status, error classification)
- `pnpm vitest run src/__tests__/queue/token-rotation.test.ts` — all tests pass (rotation processor, optimistic locking, transactional failure modes)
- `pnpm vitest run src/__tests__/queue/task-queue-preflight.test.ts` — all tests pass (pre-flight refusal, network vs auth classification)
- `pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx` — all tests pass (banner renders for each status variant)
- `pnpm prisma generate` succeeds with new expiresAt field
- `grep -q 'expiresAt' prisma/schema.prisma` — field exists on CoderToken
- `grep -q 'TOKEN_ROTATION_QUEUE' src/lib/constants.ts` — rotation constants present
- `grep -q 'TokenExpiryBanner' src/app/(dashboard)/layout.tsx` — banner wired into dashboard

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: no (mocked Coder API, mocked DB for unit tests)
- Human/UAT required: yes (banner visual check)

## Integration Closure

- Upstream surfaces consumed: `src/lib/auth/encryption.ts` (encrypt/decrypt), `src/lib/auth/login.ts` (performLogin), `src/lib/coder/client.ts` (CoderClient static methods), `src/lib/coder/user-client.ts` (getCoderClientForUser), `src/lib/queue/task-queue.ts` (worker processor), `src/lib/queue/connection.ts` (getRedisConnection), `src/lib/constants.ts`, `prisma/schema.prisma` (CoderToken model)
- New wiring introduced in this slice: token-rotation BullMQ queue and worker started in instrumentation.ts, pre-flight check injected at top of task-queue worker, TokenExpiryBanner component in dashboard layout, token status server action
- What remains before the milestone is truly usable end-to-end: S04+ slices per roadmap (if any)

## Verification

- Runtime signals: console.log for rotation events (`[token-rotation] Rotated token for user X`, `[token-rotation] Skipped — version conflict`), pre-flight refusal (`[queue] Token expiry pre-flight failed for user X`), error classification (`[queue] Auth error — not retrying`, `[queue] Network error — will retry`)
- Inspection surfaces: CoderToken.expiresAt and CoderToken.version columns in DB, BullMQ token-rotation queue in Redis, token status server action response
- Failure visibility: tryDecrypt returns typed reason ('key_mismatch' | 'other'), rotation logs version conflicts, pre-flight logs remaining hours, worker logs error classification
- Redaction constraints: decrypted token values must never appear in logs; only token metadata (userId, expiresAt, version) may be logged

## Tasks

- [x] **T01: Add expiresAt to CoderToken, tryDecrypt with GCM classification, Coder API key management methods, and login lifetime** `est:1h`
  ## Description

Foundation task that extends the schema, encryption, Coder client, and login flow for all downstream token lifecycle work.

## Threat Surface

- **Abuse**: Token rotation API calls use the user's own credential — no privilege escalation. deleteApiKey requires valid session token + correct userId.
- **Data exposure**: Decrypted tokens exist only in memory during rotation. tryDecrypt returns typed errors, never leaks plaintext on failure.
- **Input trust**: lifetimeSeconds is a hardcoded constant, not user input. API key list/delete use userId from DB, not from request.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder API (listApiKeys) | Return empty array, log warning | AbortSignal.timeout(10s), return empty array | Type guard, return empty array |
| Coder API (deleteApiKey) | Log warning, continue (old key expires naturally) | AbortSignal.timeout(10s), log warning | Ignore — DELETE returns 204 no content |
| Prisma migration | Fail fast — schema must be consistent | N/A | N/A |

## Negative Tests

- **Malformed inputs**: tryDecrypt with corrupted ciphertext, truncated IV, empty authTag
- **Error paths**: tryDecrypt with wrong key returns `{ ok: false, reason: 'key_mismatch' }`, not throw
- **Boundary conditions**: listApiKeys returns empty array when user has no keys

## Steps

1. Add `expiresAt DateTime? @map("expires_at") @db.Timestamptz` to CoderToken in `prisma/schema.prisma`. Run `pnpm prisma migrate dev --name add-coder-token-expires-at` to create and apply the migration. The field is nullable because pre-existing tokens lack expiry data.

2. Add token lifecycle constants to `src/lib/constants.ts`:
   - `TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60` (2,592,000 — 30 days)
   - `TOKEN_ROTATION_THRESHOLD = 0.75` (rotate at 75% lifetime)
   - `TOKEN_EXPIRY_WARNING_HOURS = 48` (banner threshold)
   - `TOKEN_PREFLIGHT_MIN_HOURS = 2` (worker refusal threshold)
   - `TOKEN_ROTATION_QUEUE = "token-rotation"`

3. Add `tryDecrypt()` to `src/lib/auth/encryption.ts`:
   ```typescript
   export type DecryptResult = 
     | { ok: true; plaintext: string }
     | { ok: false; reason: 'key_mismatch' | 'other'; error: Error };
   
   export function tryDecrypt(data: EncryptedData, keyHex: string): DecryptResult
   ```
   Catch the error from `decrypt()`. Check for 'unable to authenticate' or 'Unsupported state' in the error message to classify as `key_mismatch`. All other errors are `other`.

4. Add types to `src/lib/coder/types.ts`:
   - `ApiKeyInfo` interface: `{ id: string; expires_at: string; last_used: string }`
   - `ListApiKeysResponse` as `ApiKeyInfo[]`

5. Add two static methods to `src/lib/coder/client.ts`:
   - `static async listApiKeys(baseUrl, sessionToken, userId): Promise<ApiKeyInfo[]>` — GET `/api/v2/users/{userId}/keys`, returns array or empty on error
   - `static async deleteApiKey(baseUrl, sessionToken, userId, keyId): Promise<boolean>` — DELETE `/api/v2/users/{userId}/keys/{keyId}`, returns true on 204/success, false on error

6. Update `performLogin()` in `src/lib/auth/login.ts`:
   - Import `TOKEN_LIFETIME_SECONDS` from constants
   - Pass `TOKEN_LIFETIME_SECONDS` as `lifetimeSeconds` to `CoderClient.createApiKey()`
   - After successful API key creation, calculate `expiresAt = new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000)`
   - Add `expiresAt` to the CoderToken upsert (both create and update)
   - When falling back to session token, set `expiresAt` to `new Date(Date.now() + 24 * 60 * 60 * 1000)` (24h session token default)

7. Write tests in `src/__tests__/auth/token-lifecycle.test.ts`:
   - tryDecrypt with valid key returns `{ ok: true, plaintext }`
   - tryDecrypt with wrong key returns `{ ok: false, reason: 'key_mismatch' }`
   - tryDecrypt with corrupted data returns `{ ok: false, reason: 'other' }`
   - CoderClient.listApiKeys returns array (mock fetch)
   - CoderClient.listApiKeys returns empty on error (mock fetch)
   - CoderClient.deleteApiKey returns true on success (mock fetch)
   - CoderClient.deleteApiKey returns false on error (mock fetch)

8. Run `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts` and `pnpm prisma generate` to verify.

## Observability Impact

- Signals added: tryDecrypt returns structured reason code instead of opaque exception
- How a future agent inspects this: query CoderToken.expiresAt to see token lifetime, check tryDecrypt result.reason for key mismatch diagnosis
- Failure state exposed: 'key_mismatch' reason distinguishes encryption key rotation from data corruption
  - Files: `prisma/schema.prisma`, `src/lib/constants.ts`, `src/lib/auth/encryption.ts`, `src/lib/coder/types.ts`, `src/lib/coder/client.ts`, `src/lib/auth/login.ts`, `src/__tests__/auth/token-lifecycle.test.ts`
  - Verify: pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts && pnpm prisma generate

- [x] **T02: Build token status service, add pre-flight expiry check to worker, and classify network vs auth errors** `est:1h`
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
  - Files: `src/lib/auth/token-status.ts`, `src/lib/coder/user-client.ts`, `src/lib/queue/errors.ts`, `src/lib/queue/task-queue.ts`, `src/__tests__/auth/token-status.test.ts`, `src/__tests__/queue/task-queue-preflight.test.ts`
  - Verify: pnpm vitest run src/__tests__/auth/token-status.test.ts src/__tests__/queue/task-queue-preflight.test.ts

- [ ] **T03: Implement BullMQ token rotation job with transactional create-encrypt-update-delete flow** `est:1h30m`
  ## Description

Creates the token rotation BullMQ queue and worker (R097). The processor finds tokens at >=75% lifetime, creates a new Coder API key, encrypts it, updates the DB row with optimistic locking, and deletes the old key from Coder. Registered in the worker index and instrumentation hook.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder API (createApiKey) | Log and skip this token — retry on next schedule | AbortSignal.timeout(10s) | Return null — skip rotation |
| Coder API (deleteApiKey) | Log warning — old key expires naturally, not critical | AbortSignal.timeout(10s) | Ignore — best-effort cleanup |
| Prisma (optimistic lock update) | If 0 rows affected, another process won — skip gracefully | Prisma default timeout | N/A |
| tryDecrypt (current token) | If key_mismatch, skip — user must re-login | N/A | N/A |

## Load Profile

- **Shared resources**: DB connection pool (shared with task worker), Redis (BullMQ queue)
- **Per-operation cost**: 1 DB read + 1 decrypt + 1 Coder API create + 1 DB write + 1 Coder API delete per token
- **10x breakpoint**: With 1000 users, rotation processes serially within one job — bounded by Coder API latency. No pool exhaustion risk since each token is processed sequentially.

## Negative Tests

- **Error paths**: createApiKey fails → token unchanged, no corruption. DB update version conflict → skip gracefully. tryDecrypt key_mismatch → skip token.
- **Boundary conditions**: Token with null expiresAt → calculate from createdAt + 30 days. Token at exactly 75% → should rotate. Token at 74.9% → should not rotate.

## Steps

1. Create `src/lib/queue/token-rotation.ts`:
   - Import Queue, Worker, Job from bullmq; getRedisConnection; getDb; encrypt, tryDecrypt from encryption; CoderClient from client; constants
   - Define `TokenRotationJobData = { triggeredAt: string }` (minimal — rotation is global, not per-user)
   - Create lazy queue singleton: `getTokenRotationQueue()` using `TOKEN_ROTATION_QUEUE` constant
   - Create processor function `processTokenRotation(job: Job<TokenRotationJobData>)`:
     a. Query all CoderTokens with their User relation (need coderUrl, coderUserId)
     b. For each token, determine effective expiresAt: if null, use `createdAt + TOKEN_LIFETIME_SECONDS * 1000`
     c. Calculate threshold: `effectiveExpiresAt - (TOKEN_LIFETIME_SECONDS * 1000 * (1 - TOKEN_ROTATION_THRESHOLD))`
     d. If `now < threshold`, skip (not yet due)
     e. If token is already expired, skip (user must re-login)
     f. Call tryDecrypt — if key_mismatch or other error, log and skip
     g. Use the decrypted token as sessionToken to call `CoderClient.createApiKey(user.coderUrl, decryptedToken, user.coderUserId, TOKEN_LIFETIME_SECONDS)`
     h. If createApiKey returns null, log and skip
     i. Encrypt the new key, calculate new expiresAt
     j. Optimistic lock update: `prisma.$executeRaw` with `UPDATE coder_tokens SET ciphertext = $1, iv = $2, auth_tag = $3, expires_at = $4, version = version + 1, updated_at = NOW() WHERE id = $5 AND version = $6` — check result count
     k. If 0 rows updated (version conflict), log `[token-rotation] Skipped — version conflict for user ${userId}` and attempt to delete the newly created key (best-effort cleanup)
     l. If update succeeded, attempt `CoderClient.deleteApiKey` for old key: list keys via `listApiKeys`, find keys that aren't the new one, delete them. Log warnings on failure but don't throw.
     m. Log `[token-rotation] Rotated token for user ${userId}, version ${oldVersion} → ${oldVersion + 1}`
   - Create worker factory `createTokenRotationWorker()`: instantiate Worker with processor, connection, concurrency: 1

2. Add a `scheduleTokenRotation()` function that adds a repeatable job to the queue:
   - `queue.upsertJobScheduler('token-rotation-scheduler', { every: 60 * 60 * 1000 }, { data: { triggeredAt: new Date().toISOString() } })` — runs every hour

3. Update `src/lib/queue/index.ts`:
   - Export `createTokenRotationWorker`, `getTokenRotationQueue`, `scheduleTokenRotation` from token-rotation

4. Update `src/instrumentation.ts`:
   - Import `createTokenRotationWorker` and `scheduleTokenRotation` from queue index
   - Call both in the register function alongside the existing template push worker

5. Write tests in `src/__tests__/queue/token-rotation.test.ts`:
   - Rotation skips token not yet at threshold
   - Rotation processes token at threshold, creates new key, updates DB
   - Rotation handles createApiKey failure gracefully (token unchanged)
   - Rotation handles version conflict gracefully (skips, attempts cleanup)
   - Rotation skips token with key_mismatch (user must re-login)
   - Rotation handles expired token (skips)
   - Rotation handles null expiresAt (calculates from createdAt)
   - Rotation attempts to delete old key after successful update
   - Rotation logs warning but doesn't throw when deleteApiKey fails

6. Run `pnpm vitest run src/__tests__/queue/token-rotation.test.ts`

## Observability Impact

- Signals added: `[token-rotation] Rotated token for user X, version N → N+1`, `[token-rotation] Skipped — version conflict for user X`, `[token-rotation] Skipped — key_mismatch for user X`, `[token-rotation] createApiKey failed for user X`
- How a future agent inspects: query CoderToken.version to see rotation count, check BullMQ token-rotation queue for job history, grep logs for `[token-rotation]`
- Failure state exposed: version conflict count, key_mismatch users (need re-login), createApiKey failure count
  - Files: `src/lib/queue/token-rotation.ts`, `src/lib/queue/index.ts`, `src/instrumentation.ts`, `src/__tests__/queue/token-rotation.test.ts`
  - Verify: pnpm vitest run src/__tests__/queue/token-rotation.test.ts

- [ ] **T04: Add in-app token expiry banner to dashboard layout with server action** `est:45m`
  ## Description

Creates the TokenExpiryBanner component (R105) and wires it into the dashboard layout. Uses the token status service from T02 via a server action. Banner shows destructive Alert for expired/key_mismatch tokens and default Alert for near-expiry tokens. Server component approach — checks on each navigation per R105 ("on next visit").

## Steps

1. Create a server action in `src/lib/auth/actions.ts` (extend existing file):
   - Add `getTokenStatusAction` using `authActionClient`:
     ```typescript
     export const getTokenStatusAction = authActionClient
       .action(async ({ ctx }) => {
         const status = await getTokenStatus(ctx.user.id);
         return status;
       });
     ```
   - Import `getTokenStatus` from token-status.ts

2. Create `src/components/token-expiry-banner.tsx`:
   - This is a server component that receives the token status as a prop (fetched by the layout)
   - Uses shadcn `Alert`, `AlertTitle`, `AlertDescription` from `src/components/ui/alert.tsx`
   - For 'expired' status: destructive variant, title "Token Expired", description "Your Coder API token has expired. Please log out and log in again to continue."
   - For 'key_mismatch' status: destructive variant, title "Re-authentication Required", description "The encryption key has changed. Please log out and log in again."
   - For 'expiring' status: default variant, title "Token Expiring Soon", description showing hours remaining (passed as prop)
   - For 'valid' status: render nothing (return null)
   - Use `AlertCircle` icon from lucide-react for destructive, `Clock` for expiring

3. Modify `src/app/(dashboard)/layout.tsx`:
   - Import `TokenExpiryBanner` from components
   - Import `getTokenStatusAction` from auth actions
   - Make the layout an async server component
   - Call `getTokenStatusAction()` at the top
   - If the action returns data, render `<TokenExpiryBanner>` above `{children}` inside `<main>`
   - Wrap the banner call in a try/catch — if it fails (e.g., no session), don't render banner (fail silently)
   - The banner should be inside `<main>` but above `{children}`, with no padding changes

4. Write tests in `src/__tests__/components/token-expiry-banner.test.tsx`:
   - Renders nothing for 'valid' status
   - Renders destructive alert for 'expired' status with correct message
   - Renders destructive alert for 'key_mismatch' status with re-auth message
   - Renders default alert for 'expiring' status with hours remaining
   - Uses shadcn Alert component (verify import)

5. Run `pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx`

6. Run full slice verification: `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts src/__tests__/auth/token-status.test.ts src/__tests__/queue/token-rotation.test.ts src/__tests__/queue/task-queue-preflight.test.ts src/__tests__/components/token-expiry-banner.test.tsx`
  - Files: `src/lib/auth/actions.ts`, `src/components/token-expiry-banner.tsx`, `src/app/(dashboard)/layout.tsx`, `src/__tests__/components/token-expiry-banner.test.tsx`
  - Verify: pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx && grep -q 'TokenExpiryBanner' src/app/(dashboard)/layout.tsx

## Files Likely Touched

- prisma/schema.prisma
- src/lib/constants.ts
- src/lib/auth/encryption.ts
- src/lib/coder/types.ts
- src/lib/coder/client.ts
- src/lib/auth/login.ts
- src/__tests__/auth/token-lifecycle.test.ts
- src/lib/auth/token-status.ts
- src/lib/coder/user-client.ts
- src/lib/queue/errors.ts
- src/lib/queue/task-queue.ts
- src/__tests__/auth/token-status.test.ts
- src/__tests__/queue/task-queue-preflight.test.ts
- src/lib/queue/token-rotation.ts
- src/lib/queue/index.ts
- src/instrumentation.ts
- src/__tests__/queue/token-rotation.test.ts
- src/lib/auth/actions.ts
- src/components/token-expiry-banner.tsx
- src/app/(dashboard)/layout.tsx
- src/__tests__/components/token-expiry-banner.test.tsx
