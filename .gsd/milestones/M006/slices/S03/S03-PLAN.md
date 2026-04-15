# S03: Scrollback Persistence Backend

**Goal:** Terminal output is written to Postgres in real-time chunks. Restart the terminal-proxy — reconnect and scrollback is restored from Postgres.
**Demo:** Terminal output is written to Postgres in real-time chunks. Restart the terminal-proxy — reconnect and scrollback is restored from Postgres.

## Must-Haves

- `npx prisma migrate status` shows ScrollbackChunk migration applied with no pending migrations
- `cd services/terminal-proxy && pnpm test` — all tests pass including ring-buffer, scrollback-writer, and scrollback-integration tests
- Integration test proves: proxy writes chunks to Postgres, API route reads them back in correct order, ring buffer catches chunks during Postgres outage
- `docker compose config` shows terminal-proxy has DATABASE_URL and depends_on postgres

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (Postgres needed for integration tests)
- Human/UAT required: no

## Integration Closure

- Upstream surfaces consumed: `services/terminal-proxy/src/proxy.ts` (upstream.on("message") handler at line 171), `prisma/schema.prisma` (existing models), `docker-compose.yml` (postgres service)
- New wiring introduced in this slice: ScrollbackWriter instantiated per WebSocket connection in proxy.ts, DB connection pool in terminal-proxy, DATABASE_URL threaded to terminal-proxy container, Next.js API route reading scrollback_chunks via Prisma
- What remains before the milestone is truly usable end-to-end: S04 (client-side hydration UI — reads from the API route created here), S05 (workspace keep-alive to prevent workspace shutdown)

## Verification

- Runtime signals: ScrollbackWriter logs flush events (`[scrollback] flushed seqNum=N bytes=M reconnectId=...`), ring buffer warnings at >80% capacity, errors on chunk drops
- Inspection surfaces: `scrollback_chunks` table queryable via psql (`SELECT reconnect_id, seq_num, byte_size, created_at FROM scrollback_chunks ORDER BY created_at DESC LIMIT 20`), `/healthz` endpoint unchanged
- Failure visibility: ScrollbackWriter logs Postgres connection errors with reconnectId correlation, ring buffer size and drop count logged on each failed flush
- Redaction constraints: raw PTY data in `data` column may contain user secrets — no logging of chunk content, only metadata (seqNum, byteSize, reconnectId)

## Tasks

- [x] **T01: Add ScrollbackChunk Prisma model, ring buffer, and DB connection module** `est:45m`
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
  - Files: `prisma/schema.prisma`, `services/terminal-proxy/package.json`, `services/terminal-proxy/src/db.ts`, `services/terminal-proxy/src/ring-buffer.ts`, `services/terminal-proxy/test/ring-buffer.test.ts`
  - Verify: npx prisma migrate status && cd services/terminal-proxy && pnpm test -- ring-buffer

- [x] **T02: Implement ScrollbackWriter with batched writes and ring buffer fallback** `est:1h`
  ## Description

Core persistence logic: build the `ScrollbackWriter` class that accumulates PTY output in memory, flushes to Postgres in batches (per D022: 5s timer or 100KB threshold), and falls back to the ring buffer (R051) when Postgres is unreachable.

The writer must be non-blocking — `append()` is synchronous (called from the WebSocket message handler), `flush()` is async and must never block the relay. Each writer instance is scoped to one reconnectId+agentId+sessionName triple. Sequence numbers are monotonically increasing per instance.

The retry loop drains the ring buffer with exponential backoff (1s → 2s → 4s → ... → max 30s) when Postgres connectivity returns.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Postgres INSERT | Push chunk to ring buffer, schedule retry with backoff | Same as error — treat timeout as transient failure | N/A — parameterized query, no response parsing |

## Load Profile

- **Shared resources**: Postgres connection pool (shared with other writers), in-memory buffer per writer instance
- **Per-operation cost**: One INSERT per flush (~100KB payload), one connection lease from pool
- **10x breakpoint**: 10x concurrent sessions = 10x flush frequency. Pool queue absorbs bursts; ring buffer catches if pool saturates

## Negative Tests

- **Flush on Postgres failure**: chunk goes to ring buffer, not lost
- **Ring buffer drain on recovery**: chunks written to DB in correct seqNum order after reconnect
- **Oversized single append**: >256KB single message triggers immediate flush (not buffered indefinitely)
- **Close with pending data**: final flush drains both in-memory buffer and ring buffer

## Steps

1. Create `services/terminal-proxy/src/scrollback-writer.ts`. Export `ScrollbackWriter` class with constructor accepting `{ reconnectId, agentId, sessionName, pool }` where pool is the postgres SQL instance from db.ts.
2. Implement `append(data: Buffer): void` — appends to internal buffer array, increments `bufferBytes`. If `bufferBytes >= 102400` (100KB), calls `this.scheduleFlush()`. Must be synchronous — no await.
3. Implement private `scheduleFlush()` — if no flush is pending, calls `this.flush()` as fire-and-forget (catch errors internally). Prevents concurrent flushes.
4. Implement `flush(): Promise<void>` — concatenates buffer into single Buffer, creates chunk record `{ reconnectId, agentId, sessionName, seqNum: this.seqNum++, data, byteSize }`. Attempts `INSERT INTO scrollback_chunks`. On failure: logs error, pushes chunk to ring buffer, starts retry timer if not already running.
5. Implement private retry loop: `startRetryLoop()` — exponential backoff (1s base, 2x multiplier, 30s max). On each tick, calls `drain()` on ring buffer, attempts batch INSERT. On success: resets backoff, stops loop if ring buffer empty. On failure: continues with increased delay.
6. Implement `close(): Promise<void>` — clears flush timer, performs final flush of in-memory buffer, then drains ring buffer with one last attempt. Logs if chunks remain in ring buffer after close (data loss warning).
7. Set up 5-second flush interval timer in constructor (per D022). Timer calls `flush()` if buffer is non-empty. Timer cleared on `close()`.
8. Create `services/terminal-proxy/test/scrollback-writer.test.ts` with Vitest tests using a mock postgres pool:
   - Append small data → no immediate flush (batching)
   - Append 100KB+ → triggers flush
   - 5s timer triggers flush of buffered data
   - Flush failure → chunk enters ring buffer
   - Recovery → ring buffer drains to DB
   - close() flushes remaining data
   - seqNum increments monotonically across flushes
   - Concurrent appends during flush don't corrupt state

## Must-Haves

- [ ] ScrollbackWriter.append() is synchronous — no await, no blocking
- [ ] Flushes on 5s interval OR 100KB threshold (whichever first)
- [ ] Postgres failure → chunks buffered in ring buffer with retry backoff
- [ ] close() drains both in-memory buffer and ring buffer
- [ ] seqNum monotonically increasing per writer instance
- [ ] Unit tests cover batching thresholds, failure/recovery, and close semantics

## Verification

- `cd services/terminal-proxy && pnpm test -- scrollback-writer` — all tests pass
  - Files: `services/terminal-proxy/src/scrollback-writer.ts`, `services/terminal-proxy/test/scrollback-writer.test.ts`
  - Verify: cd services/terminal-proxy && pnpm test -- scrollback-writer

- [x] **T03: Wire ScrollbackWriter into proxy, add Docker config and graceful shutdown** `est:45m`
  ## Description

Integration task: connect the ScrollbackWriter into the live WebSocket proxy so every PTY output frame is captured, update Docker Compose to provide DATABASE_URL to terminal-proxy, and add SIGTERM/SIGINT handlers for graceful shutdown.

The critical change is in `proxy.ts:connectUpstream()` — it currently receives only `(browserWs, upstreamUrl, token, agentId)` but needs `reconnectId` and `sessionName` to instantiate a writer. The `upstream.on("message")` handler at line 171 must call `writer.append(data)` before forwarding to the browser. The `cleanup()` function must call `writer.close()` to flush pending data.

A Map of active writers in `index.ts` enables the SIGTERM handler to flush all writers before process exit.

## Steps

1. Modify `services/terminal-proxy/src/proxy.ts`:
   a. Add import for `ScrollbackWriter` and `getPool`.
   b. Export a `Map<string, ScrollbackWriter>` called `activeWriters` (keyed by connectionId).
   c. Change `connectUpstream` signature to accept `{ browserWs, upstreamUrl, token, agentId, reconnectId, sessionName, connectionId }`.
   d. In `connectUpstream`, instantiate `ScrollbackWriter` with `{ reconnectId, agentId, sessionName, pool: getPool() }`. Store in `activeWriters`.
   e. In `upstream.on("message")` handler (line 171), add `writer.append(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))` BEFORE the existing `browserWs.send()` call.
   f. In `cleanup()`, add `await writer.close()` and `activeWriters.delete(connectionId)`. Note: cleanup is sync currently — wrap the async part in a fire-and-forget with error logging.
   g. Update the `handleUpgrade` call to `connectUpstream` to pass the new params from the already-parsed URL search params.
2. Modify `services/terminal-proxy/src/index.ts`:
   a. Import `closePool` from `db.ts` and `activeWriters` from `proxy.ts`.
   b. Add graceful shutdown handler for SIGTERM and SIGINT: iterate `activeWriters.values()`, call `close()` on each, then call `closePool()`, then `process.exit(0)`. Use a 10-second timeout to force-exit if flush hangs.
   c. Guard the DB pool initialization — only create if `DATABASE_URL` is set. If not set, log a warning but don't crash (scrollback persistence is degraded, proxy still relays).
3. Modify `docker-compose.yml`:
   a. Add `DATABASE_URL: postgresql://hive:hive@postgres:5432/hive` to terminal-proxy environment.
   b. Add `depends_on: postgres: condition: service_healthy` to terminal-proxy (postgres already has a healthcheck).
4. Verify existing proxy tests still pass — the writer instantiation should be conditional on DATABASE_URL being set, so existing tests (which don't set it) should not break.

## Must-Haves

- [ ] writer.append() called in upstream.on("message") BEFORE browserWs.send() — capture before relay
- [ ] writer.close() called in cleanup() — no data loss on disconnect
- [ ] SIGTERM handler flushes all active writers then closes DB pool
- [ ] docker-compose.yml: terminal-proxy has DATABASE_URL and depends_on postgres
- [ ] Proxy still works without DATABASE_URL (graceful degradation) — existing tests pass

## Verification

- `cd services/terminal-proxy && pnpm test` — all existing and new tests pass
- `docker compose config | grep -A5 terminal-proxy` shows DATABASE_URL and depends_on

## Observability Impact

- Signals added: proxy logs `[scrollback] writer created reconnectId=...` on connection, `[scrollback] writer closed reconnectId=...` on cleanup
- Failure state exposed: if DATABASE_URL missing, logs `[terminal-proxy] DATABASE_URL not set — scrollback persistence disabled`
  - Files: `services/terminal-proxy/src/proxy.ts`, `services/terminal-proxy/src/index.ts`, `docker-compose.yml`
  - Verify: cd services/terminal-proxy && pnpm test && cd /home/coder/hive && docker compose config | grep -q DATABASE_URL

- [x] **T04: Add scrollback hydration API route and write integration test** `est:45m`
  ## Description

Completes the read path (R047) and proves the full write→read cycle works. Creates a Next.js API route that reads scrollback chunks from Postgres via Prisma, ordered by seqNum, and returns concatenated binary data. Then writes an integration test that spins up a real Postgres connection, writes chunks via ScrollbackWriter, reads them back via the Prisma client, and verifies ordering and content integrity.

The API route is consumed by S04 (client-side hydration UI) — it must return binary data with appropriate content-type so the terminal can replay it directly.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Postgres via Prisma | Return 500 with error message (no stack trace) | Prisma default timeout (5s) | N/A — Prisma validates |
| reconnectId param | Return 400 if missing or not valid UUID | N/A | Return 400 with message |

## Negative Tests

- **Missing reconnectId**: returns 400
- **Invalid UUID format**: returns 400
- **No chunks found**: returns 200 with empty body (not 404 — session may not have output yet)
- **Non-GET method**: returns 405

## Steps

1. Create `src/app/api/terminal/scrollback/route.ts`:
   a. Export async `GET(request: NextRequest)` handler.
   b. Parse `reconnectId` from URL search params. Validate it matches UUID format. Return 400 if missing or invalid.
   c. Query `prisma.scrollbackChunk.findMany({ where: { reconnectId }, orderBy: { seqNum: 'asc' } })` to get all chunks for the session.
   d. If no chunks found, return `new Response(null, { status: 200 })` with `Content-Length: 0`.
   e. Concatenate all chunk `data` fields (Buffer/Uint8Array) into a single response body.
   f. Return with `Content-Type: application/octet-stream` header.
   g. Wrap in try/catch — on error, log and return 500.
2. Create `services/terminal-proxy/test/scrollback-integration.test.ts`:
   a. Import `ScrollbackWriter`, `getPool`, `closePool` from source modules.
   b. Use `describe` block with `beforeAll` that checks `DATABASE_URL` env var — skip entire suite if not set (CI-friendly).
   c. Test: create a ScrollbackWriter, append several buffers of known content, call `flush()`, then query `scrollback_chunks` table directly via the pool to verify chunks exist with correct seqNum ordering and data content.
   d. Test: append data in multiple batches (trigger multiple flushes), verify all chunks have monotonically increasing seqNum.
   e. Test: verify `byteSize` field matches actual data length.
   f. Cleanup: delete test rows from `scrollback_chunks` after each test using the test reconnectId.
   g. `afterAll`: call `closePool()`.
3. Add a simple test for the API route in `src/app/api/terminal/scrollback/__tests__/route.test.ts`:
   a. Test: missing reconnectId → 400.
   b. Test: invalid UUID → 400.
   c. Use Vitest with mocked Prisma client for unit tests (no real DB needed for route logic tests).

## Must-Haves

- [ ] GET /api/terminal/scrollback?reconnectId=... returns binary chunks ordered by seqNum
- [ ] 400 on missing/invalid reconnectId, 200 with empty body on no chunks
- [ ] Integration test proves write→read cycle with real Postgres
- [ ] Integration test verifies seqNum ordering and data integrity
- [ ] Tests skip gracefully when DATABASE_URL is not available

## Verification

- `cd services/terminal-proxy && pnpm test -- scrollback-integration` — integration tests pass (requires DATABASE_URL)
- `test -f src/app/api/terminal/scrollback/route.ts` — API route file exists

## Observability Impact

- Signals added: API route logs `[scrollback] hydration request reconnectId=... chunks=N bytes=M`
- Failure state exposed: 500 response with logged error on Prisma query failure
  - Files: `src/app/api/terminal/scrollback/route.ts`, `services/terminal-proxy/test/scrollback-integration.test.ts`
  - Verify: cd services/terminal-proxy && pnpm test -- scrollback-integration && test -f /home/coder/hive/src/app/api/terminal/scrollback/route.ts

## Files Likely Touched

- prisma/schema.prisma
- services/terminal-proxy/package.json
- services/terminal-proxy/src/db.ts
- services/terminal-proxy/src/ring-buffer.ts
- services/terminal-proxy/test/ring-buffer.test.ts
- services/terminal-proxy/src/scrollback-writer.ts
- services/terminal-proxy/test/scrollback-writer.test.ts
- services/terminal-proxy/src/proxy.ts
- services/terminal-proxy/src/index.ts
- docker-compose.yml
- src/app/api/terminal/scrollback/route.ts
- services/terminal-proxy/test/scrollback-integration.test.ts
