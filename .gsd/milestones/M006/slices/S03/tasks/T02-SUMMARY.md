---
id: T02
parent: S03
milestone: M006
key_files:
  - services/terminal-proxy/src/scrollback-writer.ts
  - services/terminal-proxy/test/scrollback-writer.test.ts
key_decisions:
  - Ring buffer capacity set to 256 chunks (configurable via constructor option) — balances memory use vs. resilience during Postgres outages
  - Retry loop re-pushes all drained chunks back to ring buffer on failure rather than holding them in a separate collection — simpler state management, ring buffer handles overflow
duration: 
verification_result: passed
completed_at: 2026-04-15T16:54:08.163Z
blocker_discovered: false
---

# T02: Implement ScrollbackWriter with batched Postgres writes, ring buffer fallback, and exponential backoff retry

**Implement ScrollbackWriter with batched Postgres writes, ring buffer fallback, and exponential backoff retry**

## What Happened

Built `ScrollbackWriter` class in `services/terminal-proxy/src/scrollback-writer.ts` that accumulates PTY output in memory and flushes to the `scrollback_chunks` Postgres table. Key behaviors:

- **Synchronous `append(data)`** — appends to internal buffer array, triggers flush when buffer exceeds 100KB or a single message exceeds 256KB. Never blocks the WebSocket relay.
- **5-second interval timer** — fires `flush()` if buffer is non-empty, ensuring data reaches Postgres even under low throughput.
- **Postgres failure → ring buffer fallback** — on INSERT failure, the chunk is pushed to a `BoundedRingBuffer<ScrollbackChunk>` (capacity 256) and a retry loop starts with exponential backoff (1s → 2s → 4s → ... → 30s max).
- **Retry drain** — on each retry tick, drains all ring buffer chunks and attempts batch INSERT. On success, resets backoff. On failure, re-pushes chunks and doubles delay.
- **`close()`** — clears timers, flushes in-memory buffer, then drains ring buffer with one final attempt. Logs a data-loss warning if chunks remain after close.
- **Monotonic seqNum** — each flush increments a per-instance sequence number, ensuring correct ordering on restore.

Structured log lines follow the slice redaction constraints: only metadata (seqNum, byteSize, reconnectId) is logged, never chunk content.

Created 11 unit tests with mock Postgres pools covering: batching thresholds (small data no flush, 100KB triggers flush, 5s timer flush), failure/recovery (flush failure → ring buffer, drain on recovery), close semantics (flushes pending data, drains ring buffer), seqNum monotonicity, concurrent append safety, oversized message immediate flush, and post-close rejection.

## Verification

Ran `cd services/terminal-proxy && pnpm test -- scrollback-writer` — all 11 scrollback-writer tests pass. Full suite: 88 tests across 6 files, all passing with no regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd services/terminal-proxy && pnpm test -- scrollback-writer` | 0 | ✅ pass | 10260ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `services/terminal-proxy/src/scrollback-writer.ts`
- `services/terminal-proxy/test/scrollback-writer.test.ts`
