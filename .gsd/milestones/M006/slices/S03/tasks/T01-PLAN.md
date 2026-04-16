---
estimated_steps: 36
estimated_files: 5
skills_used: []
---

# T01: Add ScrollbackChunk Prisma model, ring buffer, and DB connection module

## Description

Foundation task: add the `ScrollbackChunk` model to the Prisma schema, run the migration, then build the two pure modules the ScrollbackWriter depends on — a bounded ring buffer (R051) and a Postgres connection pool singleton.

The ring buffer is a fixed-capacity circular buffer that holds chunks during Postgres outages. It must be bounded to prevent memory exhaustion (R051). The DB module uses the `postgres` (porsager/postgres) npm package — NOT Prisma — to keep the terminal-proxy lightweight (per D022 research).

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Postgres (db.ts pool) | Log error, return pool in disconnected state — callers handle | Connection timeout after 10s, pool rejects pending queries | N/A — wire protocol, not HTTP |

## Load Profile

- **Shared resources**: Single Postgres connection pool shared across all ScrollbackWriter instances (5-10 connections)
- **Per-operation cost**: Pool creation is once at startup; each query uses one connection from pool
- **10x breakpoint**: Pool exhaustion if >10 concurrent flush operations — mitigated by pool queue

## Negative Tests

- **Ring buffer**: push to full buffer overwrites oldest, drain returns items in FIFO order, drain on empty returns []
- **Boundary conditions**: capacity=1 buffer, capacity=0 rejected, push/drain interleaving

## Steps

1. Add `ScrollbackChunk` model to `prisma/schema.prisma` with fields: `id` (UUID PK), `reconnectId` (UUID, indexed), `agentId` (UUID), `sessionName` (string), `seqNum` (int), `data` (Bytes), `byteSize` (int), `createdAt` (timestamptz). Add `@@unique([reconnectId, seqNum])` and `@@index([reconnectId])`. Map to `scrollback_chunks` table.
2. Run `npx prisma migrate dev --name add-scrollback-chunks` to generate and apply migration.
3. Run `npx prisma generate` to update the Prisma client (needed by T04's API route).
4. Add `postgres` package to `services/terminal-proxy/package.json`: `cd services/terminal-proxy && pnpm add postgres`.
5. Create `services/terminal-proxy/src/db.ts`: export `getPool()` returning a singleton `postgres()` instance configured from `DATABASE_URL` env var with `max: 10` connections. Export `closePool()` for graceful shutdown. If `DATABASE_URL` is not set, throw a clear error at pool creation time.
6. Create `services/terminal-proxy/src/ring-buffer.ts`: export `BoundedRingBuffer<T>` class with constructor(capacity), `push(item)`, `drain(): T[]`, `size` getter, `isFull` getter. Fixed-capacity circular array — oldest item dropped on overflow. Log warning when >80% full.
7. Create `services/terminal-proxy/test/ring-buffer.test.ts` with Vitest tests: capacity enforcement, FIFO drain order, overwrite-oldest semantics, empty drain, single-capacity edge case, size/isFull getters.

## Must-Haves

- [ ] ScrollbackChunk model in Prisma schema with correct field types and indexes
- [ ] Migration applied successfully (no pending migrations)
- [ ] `postgres` package added to terminal-proxy dependencies
- [ ] `db.ts` exports getPool/closePool with configurable DATABASE_URL
- [ ] `ring-buffer.ts` implements bounded circular buffer with push/drain/size/isFull
- [ ] Ring buffer tests cover capacity enforcement, FIFO order, overwrite-oldest, edge cases

## Verification

- `npx prisma migrate status` shows no pending migrations
- `cd services/terminal-proxy && pnpm test -- ring-buffer` — all ring buffer tests pass

## Observability Impact

- Signals added: ring buffer logs warning at >80% capacity via console.warn
- How a future agent inspects: `psql -c "\d scrollback_chunks"` to verify table schema
- Failure state exposed: db.ts throws descriptive error if DATABASE_URL missing

## Inputs

- ``prisma/schema.prisma` — existing schema with Task, TaskLog, Workspace models`
- ``services/terminal-proxy/package.json` — existing deps (ws, dotenv)`
- ``services/terminal-proxy/vitest.config.ts` — existing test config`

## Expected Output

- ``prisma/schema.prisma` — updated with ScrollbackChunk model`
- ``prisma/migrations/*_add_scrollback_chunks/migration.sql` — generated migration`
- ``services/terminal-proxy/package.json` — updated with postgres dependency`
- ``services/terminal-proxy/src/db.ts` — Postgres connection pool singleton`
- ``services/terminal-proxy/src/ring-buffer.ts` — BoundedRingBuffer class`
- ``services/terminal-proxy/test/ring-buffer.test.ts` — ring buffer unit tests`

## Verification

npx prisma migrate status && cd services/terminal-proxy && pnpm test -- ring-buffer
