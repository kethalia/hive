---
id: T01
parent: S03
milestone: M006
key_files:
  - prisma/schema.prisma
  - prisma/migrations/20260415000000_add_scrollback_chunks/migration.sql
  - services/terminal-proxy/src/db.ts
  - services/terminal-proxy/src/ring-buffer.ts
  - services/terminal-proxy/test/ring-buffer.test.ts
  - services/terminal-proxy/package.json
key_decisions:
  - Used prisma db push instead of migrate dev due to broken migration baseline (prior migration ALTERs tasks table without CREATE). Migration SQL file still committed for production deploy.
  - Started local Postgres 17 cluster for development since remote DB was unreachable.
duration: 
verification_result: passed
completed_at: 2026-04-15T16:51:11.620Z
blocker_discovered: false
---

# T01: Add ScrollbackChunk Prisma model, postgres connection pool, and bounded ring buffer with full test coverage

**Add ScrollbackChunk Prisma model, postgres connection pool, and bounded ring buffer with full test coverage**

## What Happened

Added the `ScrollbackChunk` model to `prisma/schema.prisma` with UUID PK, reconnectId/seqNum unique constraint, reconnectId index, and all required fields (agentId, sessionName, data as Bytes, byteSize, createdAt as timestamptz). Created the migration SQL file and verified the table schema via `psql \d scrollback_chunks`.

Created `services/terminal-proxy/src/db.ts` exporting `getPool()` (singleton postgres connection pool from `DATABASE_URL` with max 10 connections, 10s connect timeout) and `closePool()` for graceful shutdown. Uses the `postgres` (porsager) package per D022.

Created `services/terminal-proxy/src/ring-buffer.ts` implementing `BoundedRingBuffer<T>` — a fixed-capacity circular buffer that drops oldest items on overflow and logs a warning at >80% capacity (R051). Exports push, drain, size, and isFull.

Created comprehensive ring buffer tests covering: capacity rejection (<1), size/isFull tracking, FIFO drain order, empty drain, overwrite-oldest semantics, capacity=1 edge case, push/drain interleaving, >80% capacity warning, and size reset after drain. All 9 tests pass. Full test suite (77 tests across 5 files) passes with no regressions.

Local Postgres was started and configured for development. Used `prisma db push` to sync schema since the existing migration history had a broken baseline (ALTER TABLE without prior CREATE TABLE). Migration SQL file is committed for production deployment.

## Verification

1. `psql \d scrollback_chunks` — table exists with correct columns, types, PK, unique constraint, and index.
2. `SELECT reconnect_id, seq_num, byte_size, created_at FROM scrollback_chunks` — table is queryable.
3. `pnpm test -- ring-buffer` — all 9 ring buffer tests pass.
4. Full test suite (77 tests across 5 files) passes with no regressions.
5. `prisma migrate status` shows migration files exist (not applied via migrate dev due to broken baseline, but schema is in sync via db push).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd services/terminal-proxy && pnpm test -- ring-buffer` | 0 | ✅ pass | 10290ms |
| 2 | `PGPASSWORD=coder psql -U coder -d hive -c "\d scrollback_chunks"` | 0 | ✅ pass | 50ms |
| 3 | `PGPASSWORD=coder psql -U coder -d hive -c "SELECT reconnect_id, seq_num, byte_size, created_at FROM scrollback_chunks ORDER BY created_at DESC LIMIT 20"` | 0 | ✅ pass | 30ms |

## Deviations

Used `prisma db push` instead of `prisma migrate dev` because the existing migration history has a broken baseline — the first migration (add_council_columns) ALTERs the tasks table without a prior migration creating it. The migration SQL file was created manually and is correct for production deployment via `prisma migrate deploy`.

## Known Issues

Migration history baseline is broken — the first migration assumes tables already exist. A future task should consider adding a baseline migration or using `prisma migrate resolve` to mark existing migrations as applied.

## Files Created/Modified

- `prisma/schema.prisma`
- `prisma/migrations/20260415000000_add_scrollback_chunks/migration.sql`
- `services/terminal-proxy/src/db.ts`
- `services/terminal-proxy/src/ring-buffer.ts`
- `services/terminal-proxy/test/ring-buffer.test.ts`
- `services/terminal-proxy/package.json`
