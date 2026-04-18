---
estimated_steps: 58
estimated_files: 4
skills_used: []
---

# T03: Implement BullMQ token rotation job with transactional create-encrypt-update-delete flow

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

## Inputs

- ``src/lib/auth/encryption.ts` — tryDecrypt and encrypt from T01`
- ``src/lib/coder/client.ts` — CoderClient.createApiKey, listApiKeys, deleteApiKey from T01`
- ``src/lib/constants.ts` — TOKEN_LIFETIME_SECONDS, TOKEN_ROTATION_THRESHOLD, TOKEN_ROTATION_QUEUE from T01`
- ``src/lib/queue/connection.ts` — getRedisConnection`
- ``src/lib/queue/index.ts` — existing worker registry to extend`
- ``src/instrumentation.ts` — existing instrumentation hook to extend`
- ``prisma/schema.prisma` — CoderToken with expiresAt and version from T01`

## Expected Output

- ``src/lib/queue/token-rotation.ts` — queue, processor, worker factory, scheduleTokenRotation`
- ``src/lib/queue/index.ts` — exports for token rotation worker and queue`
- ``src/instrumentation.ts` — token rotation worker started alongside template push worker`
- ``src/__tests__/queue/token-rotation.test.ts` — rotation processor tests`

## Verification

pnpm vitest run src/__tests__/queue/token-rotation.test.ts
