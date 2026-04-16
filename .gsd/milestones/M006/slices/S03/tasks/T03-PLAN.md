---
estimated_steps: 33
estimated_files: 3
skills_used: []
---

# T03: Wire ScrollbackWriter into proxy, add Docker config and graceful shutdown

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

## Inputs

- ``services/terminal-proxy/src/proxy.ts` — existing proxy with upstream.on('message') at line 171`
- ``services/terminal-proxy/src/index.ts` — existing server setup with healthz endpoint`
- ``services/terminal-proxy/src/scrollback-writer.ts` — ScrollbackWriter class from T02`
- ``services/terminal-proxy/src/db.ts` — getPool/closePool from T01`
- ``docker-compose.yml` — existing compose with postgres and terminal-proxy services`

## Expected Output

- ``services/terminal-proxy/src/proxy.ts` — updated with ScrollbackWriter integration`
- ``services/terminal-proxy/src/index.ts` — updated with graceful shutdown handler`
- ``docker-compose.yml` — updated with DATABASE_URL for terminal-proxy`

## Verification

cd services/terminal-proxy && pnpm test && cd /home/coder/hive && docker compose config | grep -q DATABASE_URL
