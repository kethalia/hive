# S03 Research: Token Lifecycle & Resilience

## Summary of What Needs to Be Built

Five capabilities spanning backend job infrastructure, worker logic, encryption resilience, and frontend UI:

1. **R097 — Token rotation job**: A BullMQ repeatable job that runs on a schedule, finds CoderTokens at >=75% lifetime, creates a new Coder API key, encrypts it, updates the DB row transactionally, and deletes the old key from Coder.
2. **R098 — Pre-flight token expiry check**: Before a worker picks up a task job, it decrypts the user's token and checks if the underlying API key expires within 2 hours. If so, the job is refused/delayed.
3. **R102 — Encryption key change detection**: When `decrypt()` fails with a GCM auth tag mismatch (indicating TOKEN_ENCRYPTION_KEY changed), the system degrades gracefully per-user rather than crashing.
4. **R105 — In-app expiry banner**: A banner in the dashboard layout that warns users when their Coder token is expired or near-expiry.
5. **R108 — Network vs auth error classification**: Workers distinguish transient network errors (retry with exponential backoff) from auth errors (fail immediately, no retry).

## Key Files and What Each Needs

### Schema: `prisma/schema.prisma`
- **CoderToken model** currently lacks `expiresAt`. Must add `expiresAt DateTime @map("expires_at") @db.Timestamptz` to track API key expiry for rotation and pre-flight checks.
- Migration required for the new column.

### Encryption: `src/lib/auth/encryption.ts`
- `decrypt()` currently throws a raw Node.js crypto error on GCM auth tag mismatch (the `decipher.final()` call throws `Error: Unsupported state or unable to authenticate data`).
- Need a wrapper or error classification function: `isEncryptionKeyMismatch(error)` that catches this specific error pattern and returns a typed result instead of crashing.
- Consider a `tryDecrypt()` variant that returns `{ ok: true, plaintext } | { ok: false, reason: 'key_mismatch' | 'other' }`.

### Login flow: `src/lib/auth/login.ts`
- `performLogin()` calls `CoderClient.createApiKey()` without `lifetimeSeconds`. Must pass 30-day lifetime (`30 * 24 * 60 * 60 = 2_592_000`) per D040.
- Must store `expiresAt` on the CoderToken row (calculated as `now + lifetimeSeconds`).
- The `getTokenEncryptionKey()` helper here should be extracted to a shared location (used by rotation job too).

### Coder client: `src/lib/coder/client.ts`
- Missing a `deleteApiKey(baseUrl, sessionToken, userId, keyId)` static method. The Coder API endpoint is `DELETE /api/v2/users/{userId}/keys/{keyId}`. Required for transactional rotation (create new, persist, delete old).
- The `createApiKey` response from Coder returns `{ key: string }` but does NOT return the key ID. Need to also call `GET /api/v2/users/{userId}/keys` to list keys and find the old one to delete.

### Coder types: `src/lib/coder/types.ts`
- Add `ApiKeyInfo` interface for the list-keys response (id, expires_at, etc.).
- Add `DeleteApiKeyResponse` if needed.

### New file: `src/lib/queue/token-rotation.ts`
- New BullMQ queue (`token-rotation`) with a repeatable job (cron or every-N-hours pattern).
- Processor logic:
  1. Query all CoderTokens where `expiresAt <= now + 25% of 30 days` (i.e., 7.5 days remaining).
  2. For each token: decrypt current key, create new API key via Coder API, encrypt new key, update DB row with optimistic locking (`version` column — `UPDATE ... WHERE version = X`), delete old key from Coder.
  3. If optimistic lock fails (concurrent rotation), skip — another process already rotated.

### New file: `src/lib/queue/token-preflight.ts` (or inline in task-queue.ts)
- Before the worker processes a task job, check the token expiry for the user who owns the task.
- If token expires within 2 hours, throw a specific error or use BullMQ's `DelayedError` to requeue.
- This requires knowing which user owns a task — currently `TaskJobData` has no `userId`. Must either add it or look up via DB.

### Modified: `src/lib/queue/task-queue.ts`
- Add pre-flight check at the top of the worker processor.
- Add error classification in the catch block: inspect error messages to distinguish network errors (retry) from auth errors (fail immediately).
- For network errors: use BullMQ's built-in retry with backoff config.
- For auth errors (401/403 from Coder): mark job as permanently failed, do not retry.

### New file: `src/lib/auth/token-status.ts`
- Server-side function to check a user's token status: `getTokenStatus(userId) => 'valid' | 'expiring' | 'expired' | 'key_mismatch'`.
- Used by both the banner component and the pre-flight check.

### Modified: `src/app/(dashboard)/layout.tsx`
- Add an async server component or client component that calls a server action to get token status.
- Render an `Alert` (shadcn, already available at `src/components/ui/alert.tsx`) with destructive variant for expired, default variant for near-expiry.
- Banner placement: above `{children}` inside the `<main>` tag.

### New file: `src/components/token-expiry-banner.tsx`
- Client component that fetches token status and displays the appropriate alert.
- Uses existing `Alert`, `AlertTitle`, `AlertDescription` from `src/components/ui/alert.tsx`.

### Constants: `src/lib/constants.ts`
- Add: `TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60` (2,592,000)
- Add: `TOKEN_ROTATION_THRESHOLD = 0.75` (rotate at 75% lifetime = 22.5 days)
- Add: `TOKEN_EXPIRY_WARNING_HOURS = 48` (show banner when <=48h remaining)
- Add: `TOKEN_PREFLIGHT_MIN_HOURS = 2` (refuse jobs if <=2h remaining)
- Add: `TOKEN_ROTATION_QUEUE = "token-rotation"`

### Worker registration: `src/lib/queue/index.ts`
- Export the new rotation worker factory.

### Instrumentation: `src/instrumentation.ts`
- Start the token rotation worker alongside existing workers.

## Build Order

### Phase 1: Schema & Foundation
1. Add `expiresAt` to CoderToken in Prisma schema + migration.
2. Extract `getTokenEncryptionKey()` to shared location.
3. Add `tryDecrypt()` with GCM error classification to encryption.ts.
4. Update `performLogin()` to pass `lifetimeSeconds` and store `expiresAt`.
5. Add constants for token lifetime, rotation threshold, preflight minimum.

### Phase 2: Coder API Extensions
6. Add `deleteApiKey()` and `listApiKeys()` to CoderClient.
7. Add corresponding types to types.ts.

### Phase 3: Token Rotation Job (R097)
8. Create `src/lib/queue/token-rotation.ts` with queue, processor, and worker factory.
9. Implement transactional rotation: create new -> encrypt -> update DB (optimistic lock) -> delete old.
10. Register in index.ts and instrumentation.ts.

### Phase 4: Worker Pre-flight & Error Classification (R098, R108)
11. Create `src/lib/auth/token-status.ts` with `getTokenStatus()`.
12. Add pre-flight check to task-queue.ts worker processor.
13. Add network-vs-auth error classification in worker catch block.
14. Configure BullMQ retry strategy: backoff for network errors, no retry for auth errors.

### Phase 5: In-App Banner (R105)
15. Create `src/components/token-expiry-banner.tsx` using shadcn Alert.
16. Create server action to expose token status to the client.
17. Add banner to `src/app/(dashboard)/layout.tsx`.

## Verification Approach

- **Unit tests** for `tryDecrypt()` with valid key, wrong key (GCM mismatch), and corrupted data.
- **Unit tests** for token status classification logic (valid/expiring/expired/key_mismatch).
- **Unit tests** for network-vs-auth error classification.
- **Unit tests** for rotation processor: mock Coder API calls, verify transactional sequence (create -> update DB -> delete old).
- **Unit tests** for optimistic locking: simulate concurrent version conflict, verify graceful skip.
- **Unit tests** for pre-flight check: mock token with <2h remaining, verify job refusal.
- **Component tests** for TokenExpiryBanner: render with each status variant.
- **Integration test** for full rotation flow with mocked Coder API.

## Constraints

### BullMQ Patterns (from codebase)
- All queues use `getRedisConnection()` singleton from `src/lib/queue/connection.ts`.
- Worker factories follow the pattern: `export function createXWorker(): Worker<T>` (see council-queues.ts).
- Queue singletons use lazy initialization with module-level `let queue: Queue | null`.
- Workers are started in `src/instrumentation.ts` (Next.js instrumentation hook, Node.js runtime only).
- Job timeout set via `lockDuration` in worker options.

### Optimistic Locking
- CoderToken has a `version Int @default(1)` column.
- Login already increments version on upsert: `version: { increment: 1 }`.
- Rotation must use `UPDATE ... WHERE id = X AND version = Y`, then check rows affected. If 0 rows, another process won.
- Prisma doesn't natively support conditional updates; use `prisma.$executeRaw` or a transaction with a read-then-write pattern using `prisma.$transaction()`.

### API Key Lifecycle
- Coder API keys cannot be refreshed — must create new and delete old (D040).
- `createApiKey` returns only `{ key: string }` — no key ID in the response.
- To delete the old key, must list keys via `GET /api/v2/users/{userId}/keys` to find the key ID.
- Alternative: store the key ID in a new column on CoderToken, populated at creation time. This avoids the list-keys call during rotation.

## Pitfalls

### Concurrent Rotation Races
- Multiple instances of the rotation worker could attempt to rotate the same token simultaneously.
- Mitigation: optimistic locking via `version` column. Only one writer wins. Losers detect version mismatch and skip.
- BullMQ repeatable jobs are singleton by default (same repeat key), but if multiple Node processes run, each gets its own worker. Use a BullMQ `limiter` or rely on optimistic locking.

### Transactional Rotation Failure Modes
- **Create succeeds, DB update fails**: New key exists in Coder but DB still has old key. Old key still works until it expires. New key is orphaned. Mitigation: attempt to delete the new key on DB failure (best-effort cleanup).
- **Create succeeds, DB update succeeds, delete-old fails**: Old key still exists in Coder but DB has new key. Not harmful — old key will expire naturally. Log a warning.
- **Create fails**: No state change. Log and retry on next schedule.

### CoderToken Missing expiresAt
- The current schema has no `expiresAt` on CoderToken. Existing tokens (created before this migration) will have `NULL` expiresAt. Rotation logic must handle NULL gracefully — either skip (treat as non-expiring) or calculate from `createdAt + 30 days`.

### GCM Auth Tag Error Detection
- Node.js crypto throws a generic error message for GCM auth failures. The exact message varies by Node version. Must test with the project's Node version and use a robust detection pattern (check for "unable to authenticate" in the message).

### TaskJobData Lacks User Context
- Current `TaskJobData` has `taskId`, `repoUrl`, `prompt`, `branchName`, `params` — no user ID.
- Pre-flight check needs to know which user's token to verify. Options:
  1. Add `userId` to `TaskJobData` (breaking change for in-flight jobs).
  2. Look up user via task -> workspace -> user relationship (but Task doesn't have userId either).
  3. Add `userId` to the Task model. This is the cleanest but requires another migration.
- Recommendation: Add `userId` to TaskJobData at dispatch time. The task creation endpoint already has user context from the session.

### Banner Reactivity
- The expiry banner must update without requiring a full page reload. Options:
  1. Server component that checks on each navigation (sufficient for "next visit" requirement per R105).
  2. Client component with periodic polling (more responsive but adds load).
- R105 says "on next visit" — server component approach is sufficient.
