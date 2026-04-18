---
id: T03
parent: S03
milestone: M010
key_files:
  - src/lib/queue/token-rotation.ts
  - src/lib/queue/index.ts
  - src/instrumentation.ts
  - src/__tests__/queue/token-rotation.test.ts
key_decisions:
  - Optimistic locking uses Prisma.$executeRaw with WHERE version = oldVersion — avoids Prisma's findFirst+update race and gives direct control over the UPDATE result count
  - Old key cleanup uses the new key as session token (not the old one) after successful DB update — the new key is now the active credential
  - Version conflict triggers best-effort cleanup of the newly created key to avoid orphaned keys in Coder
duration: 
verification_result: passed
completed_at: 2026-04-18T21:00:08.906Z
blocker_discovered: false
---

# T03: Implement BullMQ token rotation job with transactional create-encrypt-update-delete flow and optimistic locking

**Implement BullMQ token rotation job with transactional create-encrypt-update-delete flow and optimistic locking**

## What Happened

Created the token rotation BullMQ queue and worker in `src/lib/queue/token-rotation.ts`. The processor queries all CoderTokens with their User relation, determines effective expiry (falling back to createdAt + 30 days when expiresAt is null), and rotates tokens that have reached >=75% of their lifetime.

The rotation flow for each eligible token:
1. tryDecrypt the current ciphertext — skip on key_mismatch (user must re-login) or other errors
2. Call CoderClient.createApiKey with the decrypted session token to create a new API key
3. Encrypt the new key and perform an optimistic-lock UPDATE (WHERE version = oldVersion)
4. If version conflict (0 rows updated), log and attempt best-effort cleanup of the newly created key
5. If update succeeded, attempt to delete old keys via listApiKeys + deleteApiKey (best-effort, warnings only)

The worker is registered in `src/lib/queue/index.ts` and started in `src/instrumentation.ts` alongside the existing template push worker. A repeatable job scheduler runs rotation every hour via `upsertJobScheduler`.

All observability signals follow the slice contract: `[token-rotation] Rotated token for user X`, `[token-rotation] Skipped — version conflict`, `[token-rotation] Skipped — key_mismatch`, `[token-rotation] createApiKey failed`. Decrypted token values are never logged.

## Verification

Ran `pnpm vitest run src/__tests__/queue/token-rotation.test.ts` — all 11 tests pass covering: skip below threshold, rotate at threshold, createApiKey failure, version conflict with cleanup, key_mismatch skip, expired token skip, null expiresAt fallback, old key deletion after success, deleteApiKey failure tolerance, 74.9% boundary (no rotate), 75% boundary (rotate). TypeScript compilation checked — no new errors introduced.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/queue/token-rotation.test.ts` | 0 | ✅ pass | 916ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/lib/queue/token-rotation.ts`
- `src/lib/queue/index.ts`
- `src/instrumentation.ts`
- `src/__tests__/queue/token-rotation.test.ts`
