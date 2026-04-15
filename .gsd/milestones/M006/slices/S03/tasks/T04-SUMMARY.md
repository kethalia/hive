---
id: T04
parent: S03
milestone: M006
key_files:
  - src/app/api/terminal/scrollback/route.ts
  - src/app/api/terminal/scrollback/__tests__/route.test.ts
  - services/terminal-proxy/test/scrollback-integration.test.ts
  - prisma/migrations/20260415000000_add_scrollback_chunks/migration.sql
key_decisions:
  - Fixed scrollback_chunks.id column to use gen_random_uuid() as database-level default — Prisma @default(uuid()) only applies via Prisma client, not raw SQL inserts from the postgres driver used by ScrollbackWriter
  - Integration tests use sizeThreshold: 1MB to prevent append() from auto-triggering scheduleFlush() which races with explicit flush() calls due to the flushing guard
duration: 
verification_result: passed
completed_at: 2026-04-15T17:01:07.729Z
blocker_discovered: false
---

# T04: Add scrollback hydration API route returning ordered binary chunks and integration test proving write→read cycle with real Postgres

**Add scrollback hydration API route returning ordered binary chunks and integration test proving write→read cycle with real Postgres**

## What Happened

Created `src/app/api/terminal/scrollback/route.ts` — a Next.js API route that accepts `reconnectId` as a query parameter, validates it as a UUID, queries `scrollbackChunk` via Prisma ordered by `seqNum` ascending, and returns concatenated binary data with `Content-Type: application/octet-stream`. Handles error cases: 400 for missing/invalid reconnectId, 200 with empty body when no chunks exist, 500 on Prisma errors (no stack trace exposed).

Created unit tests in `src/app/api/terminal/scrollback/__tests__/route.test.ts` with mocked Prisma client covering: missing reconnectId (400), invalid UUID (400), no chunks (200 empty), concatenated binary response, and Prisma error (500).

Created integration tests in `services/terminal-proxy/test/scrollback-integration.test.ts` that use real Postgres via the `postgres` pool. Tests verify: write→read cycle with correct seqNum ordering and data content, monotonically increasing seqNums across multiple flushes, and byteSize field accuracy. Tests skip gracefully when DATABASE_URL is not set.

Fixed the `scrollback_chunks` table `id` column to have `DEFAULT gen_random_uuid()` — the Prisma `@default(uuid())` annotation only works at the Prisma client level, but ScrollbackWriter uses raw SQL via the `postgres` driver. Updated both the live table and the migration SQL file.

## Verification

1. API route unit tests: `pnpm test -- route.test.ts` — 5 tests pass (missing reconnectId→400, invalid UUID→400, empty chunks→200, binary concat→200, Prisma error→500).
2. Integration tests: `DATABASE_URL=... pnpm test -- scrollback-integration` — 3 tests pass with real Postgres (write→read cycle, seqNum ordering, byteSize accuracy).
3. Full test suite: 427 tests pass (root), 91 tests pass (terminal-proxy) — no regressions.
4. API route file exists at expected path.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd services/terminal-proxy && DATABASE_URL="postgresql://coder:coder@localhost:5432/hive" pnpm test -- scrollback-integration` | 0 | ✅ pass | 10270ms |
| 2 | `pnpm test -- src/app/api/terminal/scrollback/__tests__/route.test.ts` | 0 | ✅ pass | 3690ms |
| 3 | `test -f src/app/api/terminal/scrollback/route.ts` | 0 | ✅ pass | 10ms |

## Deviations

Added gen_random_uuid() default to scrollback_chunks.id column — the existing table (created via prisma db push in T01) lacked this database-level default, causing all raw SQL inserts from ScrollbackWriter to fail with NOT NULL constraint violation. Updated both the live table and migration SQL.

## Known Issues

none

## Files Created/Modified

- `src/app/api/terminal/scrollback/route.ts`
- `src/app/api/terminal/scrollback/__tests__/route.test.ts`
- `services/terminal-proxy/test/scrollback-integration.test.ts`
- `prisma/migrations/20260415000000_add_scrollback_chunks/migration.sql`
