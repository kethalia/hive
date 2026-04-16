# S03 Research: Scrollback Persistence Backend

## Summary

The terminal-proxy (`services/terminal-proxy/`) is a lightweight, stateless Node.js WebSocket relay. It accepts browser WebSocket connections on `/ws`, validates parameters (agentId, reconnectId, sessionName), and opens an upstream WebSocket to the Coder agent PTY endpoint (`/api/v2/workspaceagents/{agentId}/pty`). All PTY output flows through `upstream.on("message")` in `proxy.ts:154-158` — this is the exact interception point where scrollback capture must be added. The proxy currently has zero database dependencies (only `ws` and `dotenv`), runs as a standalone Docker container on port 3001, and loads `.env` from the repo root via a relative path resolve.

The Postgres instance runs as a sibling Docker Compose service (`postgres:16-alpine`, user/pass/db all `hive`). The main Next.js app connects via Prisma (`src/lib/db/index.ts`) using `DATABASE_URL=postgresql://hive:hive@postgres:5432/hive`. The terminal-proxy container currently receives only `CODER_URL`, `CODER_AGENT_URL`, and `CODER_SESSION_TOKEN` — no `DATABASE_URL`. The Prisma schema (`prisma/schema.prisma`) has three models (Task, TaskLog, Workspace) and uses PostgreSQL with UUID primary keys and `@db.Timestamptz` timestamps. A new `scrollback_chunks` table must be added here.

The client-side terminal (`InteractiveTerminal.tsx`) uses xterm.js with `scrollback: 10000` lines. It generates a `reconnectId` (UUID, persisted in localStorage with 24h TTL) that is passed to the proxy. This reconnectId is the natural key for associating scrollback chunks with a session. The client protocol is JSON-based: `{data: string}` for input, `{height, width}` for resize. Output from Coder arrives as binary ArrayBuffer frames, forwarded as-is to the browser. The scrollback persistence layer must capture these binary output frames.

## Recommendation

**Terminal-proxy should connect to Postgres directly** (not through the Next.js API). Rationale:

1. **Latency & throughput**: The proxy handles high-frequency PTY output. Adding an HTTP round-trip per batch write would add latency and create a coupling between two services that should be independently deployable.
2. **Docker networking**: Both services are already on the same Docker Compose network. Adding `DATABASE_URL` to terminal-proxy's environment is trivial (one line in `docker-compose.yml`).
3. **Simplicity**: The proxy already loads `.env` from the repo root, so in dev mode it would pick up `DATABASE_URL` automatically. Using a lightweight Postgres client (`pg` or `postgres` npm package) avoids pulling in the full Prisma ORM into the proxy.
4. **Separation of concerns**: The proxy writes chunks; the Next.js app reads them for hydration. This is a clean producer/consumer split over a shared table.

Use the `postgres` (porsager/postgres) npm package — it is lightweight (~50KB), supports connection pooling, parameterized queries, and has no native dependencies (pure JS), which keeps the Alpine Docker image small.

For the hydration read path, add a Next.js API route (e.g., `GET /api/terminal/scrollback?reconnectId=...`) that reads chunks from Postgres via Prisma. This keeps the read side in the existing Prisma ecosystem.

## Implementation Landscape

### Key Files — Modifications Required

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `ScrollbackChunk` model with fields: `id` (UUID PK), `reconnectId` (UUID, indexed), `agentId` (UUID), `sessionName` (string), `seqNum` (int, monotonic per reconnectId), `data` (bytes — raw PTY output), `byteSize` (int), `createdAt` (timestamptz). Add composite index on `(reconnectId, seqNum)`. |
| `services/terminal-proxy/package.json` | Add `postgres` (porsager/postgres) dependency |
| `services/terminal-proxy/src/scrollback-writer.ts` | **New file.** Implements `ScrollbackWriter` class: accepts output buffers, accumulates in memory buffer, flushes to Postgres on 5s timer or 1000-line threshold (per D022). Manages per-session sequence numbers. |
| `services/terminal-proxy/src/ring-buffer.ts` | **New file.** Implements `BoundedRingBuffer<T>` for R051. Fixed-capacity circular buffer that holds chunks during Postgres outages. On flush failure, chunks go into ring buffer; a retry loop with exponential backoff drains the buffer when connectivity returns. |
| `services/terminal-proxy/src/proxy.ts` | In `connectUpstream()`: instantiate `ScrollbackWriter` per connection (keyed by reconnectId+agentId+sessionName). In `upstream.on("message")` handler (line 154), call `writer.append(data)` before forwarding to browser. In `cleanup()`, call `writer.flush()` then `writer.close()`. |
| `services/terminal-proxy/src/db.ts` | **New file.** Postgres connection pool singleton. Reads `DATABASE_URL` from env. Provides `getPool()` and `closePool()`. |
| `services/terminal-proxy/src/index.ts` | Add graceful shutdown handler (`SIGTERM`/`SIGINT`) that calls `closePool()`. |
| `docker-compose.yml` | Add `DATABASE_URL` to terminal-proxy environment. Add `depends_on: postgres` with health check condition. |
| `docker-compose.dev.yml` | No change needed (proxy runs outside Docker in dev, reads `.env` directly). |
| `src/app/api/terminal/scrollback/route.ts` | **New file.** `GET` handler: accepts `reconnectId` query param, reads chunks from Postgres via Prisma ordered by `seqNum`, returns concatenated binary data. Used by S04 (hydration UI). |

### Prisma Schema Addition

```prisma
model ScrollbackChunk {
  id          String   @id @default(uuid()) @db.Uuid
  reconnectId String   @map("reconnect_id") @db.Uuid
  agentId     String   @map("agent_id") @db.Uuid
  sessionName String   @map("session_name")
  seqNum      Int      @map("seq_num")
  data        Bytes
  byteSize    Int      @map("byte_size")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@unique([reconnectId, seqNum])
  @@index([reconnectId])
  @@map("scrollback_chunks")
}
```

### ScrollbackWriter Design

```
class ScrollbackWriter {
  private buffer: Buffer[] = [];
  private bufferBytes = 0;
  private seqNum = 0;
  private flushTimer: NodeJS.Timeout;
  private ringBuffer: BoundedRingBuffer<ChunkRecord>;

  constructor(reconnectId, agentId, sessionName, pool)

  append(data: Buffer | Uint8Array): void
    — Appends to internal buffer
    — If bufferBytes >= BATCH_SIZE_BYTES or lineCount >= 1000, triggers flush

  flush(): Promise<void>
    — Concatenates buffer into single chunk
    — Attempts INSERT into scrollback_chunks
    — On failure: pushes to ringBuffer, schedules retry

  close(): Promise<void>
    — Clears timer, final flush, drains ring buffer
}
```

### BoundedRingBuffer Design (R051)

- Fixed capacity (e.g., 100 chunks ~ 10MB at 100KB/chunk)
- Circular overwrite: oldest chunk dropped when full (bounded memory)
- `push(item)`, `drain(): item[]`, `size`, `isFull`
- Retry loop: exponential backoff (1s, 2s, 4s, ... max 30s), drains ring buffer on success
- Logs warning when buffer is >80% full, error when chunks are dropped

### Build Order

1. **Prisma migration** — Add `ScrollbackChunk` model, run `npx prisma migrate dev`
2. **Ring buffer** — `ring-buffer.ts` + tests (pure logic, no deps)
3. **DB module** — `db.ts` with connection pool
4. **ScrollbackWriter** — `scrollback-writer.ts` + tests (mock Postgres)
5. **Proxy integration** — Wire writer into `proxy.ts` upstream message handler
6. **Docker config** — Add `DATABASE_URL` to `docker-compose.yml`
7. **Hydration endpoint** — `src/app/api/terminal/scrollback/route.ts` (needed by S04 but schema should be ready)
8. **Integration test** — End-to-end: proxy writes chunks, API reads them back

### Verification Approach

- **Unit tests**: `ring-buffer.ts` — capacity, overwrite, drain semantics
- **Unit tests**: `scrollback-writer.ts` — batching thresholds (time and size), flush behavior, ring buffer fallback on simulated Postgres failure
- **Integration test**: Stand up Postgres (docker-compose), connect proxy, send mock PTY data, verify chunks appear in `scrollback_chunks` table with correct ordering
- **Failure test**: Kill Postgres mid-stream, verify ring buffer catches chunks, restart Postgres, verify chunks eventually drain
- **Manual test**: Open terminal, run `seq 1 5000`, verify chunks in DB via `psql`

## Constraints

- **Memory budget**: Terminal-proxy must remain lightweight. The ring buffer must be bounded (fixed max capacity). The in-memory batch buffer should cap at ~100KB before forcing a flush regardless of timing.
- **Binary data**: PTY output is raw bytes (ArrayBuffer/Buffer), not UTF-8 strings. The `data` column must be `Bytes` (Prisma) / `bytea` (Postgres). Do not attempt string conversion.
- **Sequence ordering**: `seqNum` must be monotonically increasing per `reconnectId` to enable correct replay ordering. Use an in-memory counter, not a DB sequence.
- **No Prisma in proxy**: The proxy should use the lightweight `postgres` npm package directly, not Prisma. Prisma would add ~10MB+ to the container and require code generation. The read side (Next.js API) can use Prisma since it already has it.
- **reconnectId lifecycle**: The client generates a new reconnectId on fresh session or after 24h TTL expiry. Old scrollback chunks should be garbage-collected eventually (add a `created_at` index, implement cleanup in a future slice or cron job).

## Common Pitfalls

1. **Backpressure**: If Postgres writes are slow, the message handler must not block the WebSocket relay. `append()` must be synchronous (buffer in memory), with `flush()` running asynchronously. Never `await` inside the `upstream.on("message")` handler.
2. **Connection pool exhaustion**: The proxy may handle many concurrent sessions. Use a shared connection pool (not per-session connections). Pool size should be modest (5-10 connections).
3. **Chunk size explosion**: A single `cat large-file.bin` can produce megabytes of output in milliseconds. The writer must flush when byte threshold is hit, not just on line count. Cap individual chunk size at ~256KB.
4. **Graceful shutdown**: On `SIGTERM`, the proxy must flush all in-flight writers before exiting. Add a shutdown handler that iterates all active writers and calls `close()`.
5. **Docker networking**: In Docker Compose, the proxy connects to `postgres:5432` (service name). In dev mode (running outside Docker), it connects to `localhost:47964` (mapped port from `docker-compose.dev.yml`). The `DATABASE_URL` from `.env` handles this, but verify both paths work.
6. **Binary frame forwarding**: The current proxy forwards `data` as-is with `{binary: isBinary}`. The scrollback writer must capture the raw data before it is sent, not after. Ensure no mutations occur between capture and send.

## Open Risks

1. **Postgres write latency under load**: Heavy terminal output (e.g., `find / -type f`) could generate hundreds of chunks per minute. Need to measure write throughput and potentially increase batch window. Mitigation: the 5s/1000-line batching from D022 should amortize this, but load testing is essential.
2. **Data volume growth**: Scrollback data could grow large quickly. No retention policy is defined yet. Risk: disk usage on Postgres. Mitigation: add a comment/TODO for a cleanup job (e.g., delete chunks older than 7 days). This can be deferred to S05 or a maintenance slice.
3. **reconnectId collision/reuse**: If a user clears localStorage, a new reconnectId is generated, orphaning old chunks. If two tabs share a reconnectId (same agent+session), chunks could interleave. Mitigation: the current localStorage logic scopes by `agentId:sessionName`, so two tabs with the same session would share a reconnectId. The writer must handle this gracefully — use `seqNum` per writer instance and accept that interleaved chunks from concurrent connections are a known limitation.
4. **No schema for output frame type**: The protocol.ts in the proxy is minimal (URL building + regex). The Coder PTY protocol sends binary frames where the first byte may indicate frame type. Currently the proxy does not parse frames at all — it relays raw bytes. The scrollback writer should capture all forwarded data without parsing frame types, keeping it protocol-agnostic.
5. **Migration coordination**: The Prisma migration must run before the new proxy code deploys. In production, this means the migration must be part of the deploy pipeline. For dev, `npx prisma migrate dev` suffices.
