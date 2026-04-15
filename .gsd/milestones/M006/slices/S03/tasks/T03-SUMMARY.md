---
id: T03
parent: S03
milestone: M006
key_files:
  - services/terminal-proxy/src/proxy.ts
  - services/terminal-proxy/src/index.ts
  - docker-compose.yml
key_decisions:
  - Writer instantiation is guarded by DATABASE_URL check — proxy works without Postgres (graceful degradation)
  - connectUpstream refactored to accept options object instead of positional args — cleaner extensibility
  - writer.close() in cleanup is fire-and-forget with error logging — sync cleanup function cannot await async close without blocking WebSocket teardown
  - Shutdown timeout set to 10 seconds — balances data flush completeness against container kill deadline
duration: 
verification_result: passed
completed_at: 2026-04-15T16:56:06.658Z
blocker_discovered: false
---

# T03: Wire ScrollbackWriter into WebSocket proxy with Docker config and graceful SIGTERM/SIGINT shutdown

**Wire ScrollbackWriter into WebSocket proxy with Docker config and graceful SIGTERM/SIGINT shutdown**

## What Happened

Integrated ScrollbackWriter from T02 into the live WebSocket proxy so every PTY output frame is captured to Postgres.

**proxy.ts changes:**
- Added imports for `ScrollbackWriter` and `getPool` from T01/T02 artifacts.
- Exported `activeWriters` Map keyed by connectionId for shutdown handler access.
- Changed `connectUpstream` to accept an options object with `reconnectId`, `sessionName`, and `connectionId` in addition to existing params.
- Writer is only instantiated when `DATABASE_URL` is set — graceful degradation preserves existing behavior.
- `writer.append()` is called in `upstream.on("message")` BEFORE `browserWs.send()` — capture before relay.
- `cleanup()` calls `writer.close()` as fire-and-forget with error logging, then deletes from activeWriters.
- Observability: logs writer creation and closure with reconnectId correlation.

**index.ts changes:**
- Imported `activeWriters` from proxy and `closePool` from db.
- Added warning log when `DATABASE_URL` is not set.
- Added `gracefulShutdown()` handler for SIGTERM and SIGINT: iterates all active writers, closes them in parallel, closes the DB pool, then exits. 10-second timeout force-exits if flush hangs.

**docker-compose.yml changes:**
- Added `DATABASE_URL=postgresql://hive:hive@postgres:5432/hive` to terminal-proxy environment.
- Added `depends_on: postgres: condition: service_healthy` so terminal-proxy waits for Postgres.

## Verification

- `pnpm test` in services/terminal-proxy: all 88 tests pass (6 test files) — existing tests unaffected since DATABASE_URL is not set in test env, so writer is never instantiated.
- `docker compose config | grep DATABASE_URL` confirms DATABASE_URL is set for terminal-proxy.
- `docker compose config | grep -A5 terminal-proxy` confirms depends_on postgres with service_healthy condition.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd services/terminal-proxy && pnpm test` | 0 | ✅ pass | 10270ms |
| 2 | `docker compose config | grep DATABASE_URL (terminal-proxy)` | 0 | ✅ pass | 500ms |
| 3 | `docker compose config | grep -A10 terminal-proxy: (depends_on check)` | 0 | ✅ pass | 500ms |

## Deviations

connectUpstream signature changed to options object pattern instead of adding 3 more positional params — cleaner than the plan's suggested approach but equivalent behavior.

## Known Issues

None

## Files Created/Modified

- `services/terminal-proxy/src/proxy.ts`
- `services/terminal-proxy/src/index.ts`
- `docker-compose.yml`
