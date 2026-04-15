---
estimated_steps: 37
estimated_files: 4
skills_used: []
---

# T01: Build KeepAliveManager, connection registry, and status endpoint in terminal-proxy

## Description

Create the server-side keep-alive infrastructure in the terminal-proxy process. This involves three pieces: (1) a connection registry that tracks which workspaces have active WebSocket connections by accepting `workspaceId` as a new query parameter, (2) a KeepAliveManager class that periodically calls the Coder API `PUT /api/v2/workspaces/{id}/extend` endpoint for each workspace with active connections, tracking consecutive failures per workspace, and (3) a `/keepalive/status` HTTP endpoint exposing per-workspace health data.

The proxy currently only receives `agentId` in WebSocket query params. The frontend already has `workspaceId` context, so we add `workspaceId` as a required query param. The KeepAliveManager uses a simple authenticated fetch (not the Next.js CoderClient — the proxy is a separate process) to call the Coder extend endpoint.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder extend API | Increment consecutiveFailures, log `[keep-alive]` error with status code | Increment consecutiveFailures after 10s fetch timeout | Increment consecutiveFailures, log response body |
| CODER_SESSION_TOKEN env | Log fatal error on startup if missing, skip keep-alive initialization | N/A | N/A |

## Load Profile

- **Shared resources**: One interval timer per KeepAliveManager instance, one fetch per active workspace per interval
- **Per-operation cost**: 1 HTTP PUT per workspace per 55-second interval
- **10x breakpoint**: 30+ simultaneous workspaces could hit Coder API rate limits — acceptable for current 1-3 workspace usage

## Negative Tests

- **Malformed inputs**: Missing workspaceId query param returns 400 on WebSocket upgrade (existing connections unaffected)
- **Error paths**: Coder API 401 (token expired) increments failure counter and logs clearly; API 404 (workspace deleted) same treatment; network timeout after 10s treated as failure
- **Boundary conditions**: Zero active connections means no pings; last connection disconnect stops pinging that workspace; rapid connect/disconnect doesn't leave stale entries

## Steps

1. Create `services/terminal-proxy/src/keepalive.ts` with `ConnectionRegistry` class: `Map<workspaceId, Set<connectionId>>` with `addConnection(workspaceId, connId)`, `removeConnection(workspaceId, connId)`, `getActiveWorkspaceIds(): string[]` methods
2. In the same file, create `KeepAliveManager` class that accepts a `ConnectionRegistry` instance, `coderUrl`, and `sessionToken`. Implements `start()` (setInterval at 55s), `stop()` (clearInterval), and private `ping(workspaceId)` method that calls `PUT {coderUrl}/api/v2/workspaces/{workspaceId}/extend` with body `{deadline: new Date(Date.now() + 60*60*1000).toISOString()}` and auth header `Coder-Session-Token: {token}`. Tracks `Map<workspaceId, {consecutiveFailures, lastSuccess, lastFailure, lastError}>`. Resets failures to 0 on success. All logs use `[keep-alive]` prefix.
3. Update `services/terminal-proxy/src/proxy.ts` to accept `workspaceId` as an optional query parameter on WebSocket upgrade. Parse it alongside existing agentId. If provided, register connection in the exported `ConnectionRegistry` singleton. On WebSocket close, deregister.
4. Update `services/terminal-proxy/src/index.ts` to: instantiate `ConnectionRegistry` and `KeepAliveManager` on startup (only if CODER_URL and CODER_SESSION_TOKEN are set), call `manager.start()`, and add HTTP route handler for `GET /keepalive/status` that returns JSON `{workspaces: {[id]: {consecutiveFailures, lastSuccess, lastFailure}}}`. Add CORS headers matching existing ALLOWED_ORIGINS pattern.
5. Export `ConnectionRegistry` from proxy.ts so index.ts can wire it to KeepAliveManager.

## Must-Haves

- [ ] ConnectionRegistry tracks workspaceId→connectionId mappings, auto-removes workspace when last connection closes
- [ ] KeepAliveManager pings every 55s for each workspace with active connections, stops pinging workspaces with zero connections
- [ ] Consecutive failure counter per workspace, resets to 0 on successful ping
- [ ] `/keepalive/status` endpoint returns JSON with per-workspace failure data
- [ ] All logs use `[keep-alive]` prefix, never log CODER_SESSION_TOKEN
- [ ] Graceful degradation: if CODER_URL or CODER_SESSION_TOKEN not set, log warning and skip keep-alive (proxy still works for terminals)

## Verification

- `cd services/terminal-proxy && pnpm vitest run` — keep-alive and connection registry tests pass
- `grep -q 'keep-alive' services/terminal-proxy/src/keepalive.ts` — file exists with keep-alive logic
- `grep -q 'keepalive/status' services/terminal-proxy/src/index.ts` — status endpoint registered

## Observability Impact

- Signals added: `[keep-alive]` log lines for ping success/failure/start/stop per workspace, `[keep-alive]` warning when env vars missing
- How a future agent inspects this: `curl http://localhost:3001/keepalive/status` returns JSON with per-workspace health
- Failure state exposed: consecutiveFailures count, lastError message, lastFailure timestamp per workspace

## Inputs

- ``services/terminal-proxy/src/proxy.ts` — existing WebSocket proxy with connection handling, query param parsing, and cleanup logic`
- ``services/terminal-proxy/src/index.ts` — existing HTTP server setup with /healthz endpoint and WebSocket upgrade handling`
- ``services/terminal-proxy/src/protocol.ts` — UUID and session name validation regexes, buildPtyUrl helper`

## Expected Output

- ``services/terminal-proxy/src/keepalive.ts` — new file with ConnectionRegistry and KeepAliveManager classes`
- ``services/terminal-proxy/src/proxy.ts` — modified to accept workspaceId query param and register/deregister connections in ConnectionRegistry`
- ``services/terminal-proxy/src/index.ts` — modified to instantiate KeepAliveManager, wire ConnectionRegistry, add /keepalive/status HTTP endpoint`
- ``services/terminal-proxy/src/__tests__/keepalive.test.ts` — unit tests for ConnectionRegistry (add/remove/getActive) and KeepAliveManager (ping success/failure, interval, stop on zero connections)`

## Verification

cd services/terminal-proxy && pnpm vitest run
