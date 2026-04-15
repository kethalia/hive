---
estimated_steps: 43
estimated_files: 2
skills_used: []
---

# T02: Implement ScrollbackWriter with batched writes and ring buffer fallback

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

## Inputs

- ``services/terminal-proxy/src/db.ts` — getPool() returns postgres SQL instance`
- ``services/terminal-proxy/src/ring-buffer.ts` — BoundedRingBuffer class`

## Expected Output

- ``services/terminal-proxy/src/scrollback-writer.ts` — ScrollbackWriter class with append/flush/close`
- ``services/terminal-proxy/test/scrollback-writer.test.ts` — unit tests with mocked postgres`

## Verification

cd services/terminal-proxy && pnpm test -- scrollback-writer
