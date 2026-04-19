---
id: T01
parent: S02
milestone: M010
key_files:
  - prisma/schema.prisma
  - prisma/migrations/20250418000000_add_task_user_id/migration.sql
  - src/lib/coder/user-client.ts
  - src/__tests__/lib/coder/user-client.test.ts
key_decisions:
  - Used UserClientException class with code enum rather than plain Error subclasses — allows catch-site switching on error.code
  - Placed test at src/__tests__/lib/coder/ following existing convention (not src/__tests__/coder/ as plan suggested)
  - Used getDb() singleton rather than instantiating new PrismaClient — consistent with codebase pattern
duration: 
verification_result: passed
completed_at: 2026-04-18T20:14:39.836Z
blocker_discovered: false
---

# T01: Add nullable userId FK to Task model and create getCoderClientForUser factory with typed errors and unit tests

**Add nullable userId FK to Task model and create getCoderClientForUser factory with typed errors and unit tests**

## What Happened

Added a nullable `userId` FK (`user_id UUID`) to the Task Prisma model linking tasks to their submitting user, with a corresponding `tasks Task[]` relation on the User model. Created migration `20250418000000_add_task_user_id` and ran `prisma generate` to update the client types.

Built `src/lib/coder/user-client.ts` with `getCoderClientForUser(userId)` that: queries the User table, fetches the most recent CoderToken (ordered by `createdAt desc`), decrypts the token using the `ENCRYPTION_KEY` env var, and returns a new `CoderClient` configured with the user's `coderUrl` and decrypted session token.

Exported `UserClientError` enum (NO_TOKEN, DECRYPT_FAILED, USER_NOT_FOUND) and `UserClientException` class for typed error handling. All error paths log with `[user-client]` prefix per slice verification requirements.

Wrote 7 unit tests covering: happy path, most-recent-token ordering, USER_NOT_FOUND, NO_TOKEN, corrupted ciphertext (DECRYPT_FAILED), missing ENCRYPTION_KEY (DECRYPT_FAILED), and `[user-client]` log prefix verification.

## Verification

Ran `pnpm prisma generate && pnpm vitest run src/__tests__/lib/coder/user-client.test.ts` — Prisma client generated successfully, all 7 tests passed.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm prisma generate` | 0 | ✅ pass | 36ms |
| 2 | `pnpm vitest run src/__tests__/lib/coder/user-client.test.ts` | 0 | ✅ pass (7/7 tests) | 169ms |

## Deviations

Test file placed at `src/__tests__/lib/coder/user-client.test.ts` instead of `src/__tests__/coder/user-client.test.ts` to match existing test directory structure. Added missing ENCRYPTION_KEY check before calling decrypt() — the plan didn't specify this but it's needed to provide a typed DECRYPT_FAILED error instead of an opaque crash. Started local PostgreSQL and created local dev database since the remote DB in .env was unreachable.

## Known Issues

The remote DATABASE_URL in .env (192.168.0.31:47964) is unreachable from this workspace. Migration was validated against a local PostgreSQL instance. The migration SQL will need to be applied to the remote database when it becomes available.

## Files Created/Modified

- `prisma/schema.prisma`
- `prisma/migrations/20250418000000_add_task_user_id/migration.sql`
- `src/lib/coder/user-client.ts`
- `src/__tests__/lib/coder/user-client.test.ts`
