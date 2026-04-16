# S01: Workspace Keep-Alive Service

**Goal:** Workspace stays alive for hours with no browser connected; terminal UI shows keep-alive status indicator and warning banner on failure
**Demo:** Workspace stays alive for hours with no browser connected; terminal UI shows keep-alive status indicator and warning banner on failure

## Must-Haves

- `cd services/terminal-proxy && pnpm vitest run` — all keep-alive unit tests pass (KeepAliveManager start/stop, failure counting, reset on success, status endpoint response shape)
- `cd services/terminal-proxy && pnpm vitest run` — connection registry tests pass (tracks workspaceId from WebSocket query params, increments/decrements on connect/disconnect)
- `pnpm vitest run --project client` or equivalent — KeepAliveWarning component renders nothing when failures < 3, renders destructive Alert when failures >= 3
- `grep -q "extendWorkspace\|keepalive/status" services/terminal-proxy/src/keepalive.ts` — keep-alive manager exists with extend logic
- `grep -q "KeepAliveWarning" src/components/workspaces/TerminalTabManager.tsx` — warning banner is mounted in terminal UI

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (terminal-proxy must run to exercise keep-alive pings)
- Human/UAT required: yes (final verification that banner appears in browser after simulated failures)

## Integration Closure

- Upstream surfaces consumed: `services/terminal-proxy/src/proxy.ts` (WebSocket connection lifecycle), `services/terminal-proxy/src/index.ts` (HTTP server), Coder API `PUT /api/v2/workspaces/{id}/extend` endpoint
- New wiring introduced in this slice: KeepAliveManager instantiated in proxy index.ts on startup, connection registry exported from proxy.ts, `/keepalive/status` HTTP route on proxy server, `useKeepAliveStatus` hook polling proxy, `KeepAliveWarning` mounted in TerminalTabManager, `workspaceId` query param added to WebSocket connection URL
- What remains before the milestone is truly usable end-to-end: S02 (reconnection hardening), S03 (scrollback persistence), S04 (virtual scrolling) — keep-alive is independently useful without those slices

## Verification

- Runtime signals: `[keep-alive]` prefixed logs for ping attempts, successes, failures, and start/stop events per workspace
- Inspection surfaces: `GET /keepalive/status` HTTP endpoint on terminal-proxy returning per-workspace failure counts, last success/failure timestamps
- Failure visibility: consecutiveFailures counter per workspace, lastError message, timestamp of last failure — all exposed via status endpoint and logs
- Redaction constraints: CODER_SESSION_TOKEN must never appear in logs or status endpoint responses

## Tasks

- [x] **T01: Build KeepAliveManager, connection registry, and status endpoint in terminal-proxy** `est:2h`
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
  - Files: `services/terminal-proxy/src/keepalive.ts`, `services/terminal-proxy/src/proxy.ts`, `services/terminal-proxy/src/index.ts`, `services/terminal-proxy/src/__tests__/keepalive.test.ts`
  - Verify: cd services/terminal-proxy && pnpm vitest run

- [x] **T02: Add keep-alive polling hook and warning banner to terminal UI** `est:1h`
  ## Description

Create a React hook that polls the terminal-proxy's `/keepalive/status` endpoint and a warning banner component that renders when consecutive failures reach the threshold. The hook polls every 30 seconds and exposes per-workspace status. The banner uses shadcn's Alert component with the `destructive` variant, matching the existing pattern in InteractiveTerminal.tsx. Mount the banner in TerminalTabManager above the terminal tabs.

Also update the WebSocket connection URL construction to include `workspaceId` as a query parameter so the proxy can track which workspaces have active sessions.

## Steps

1. Find where the terminal WebSocket URL is constructed (likely in `useTerminalWebSocket` or the component that calls it) and add `workspaceId` as a query parameter to the connection URL.
2. Create `src/hooks/useKeepAliveStatus.ts`: a hook that accepts `workspaceId` and the terminal-proxy base URL, polls `GET {proxyUrl}/keepalive/status` every 30s via `fetch`, extracts the workspace's entry from the response, and returns `{consecutiveFailures: number, lastSuccess: string | null, lastFailure: string | null, isLoading: boolean}`. Use `useEffect` with `setInterval` pattern matching existing hooks. Clean up interval on unmount.
3. Create `src/components/workspaces/KeepAliveWarning.tsx`: accepts `workspaceId` prop, calls `useKeepAliveStatus`, renders nothing when `consecutiveFailures < 3`, renders shadcn `Alert` with `variant="destructive"` when `consecutiveFailures >= 3`. Message: "Keep-alive service cannot reach Coder API ({consecutiveFailures} consecutive failures). Your workspace may auto-stop if this continues." Include AlertTitle and AlertDescription.
4. Mount `KeepAliveWarning` in `src/components/workspaces/TerminalTabManager.tsx` above the terminal tab bar, passing the `workspaceId` prop.

## Must-Haves

- [ ] WebSocket connection URL includes `workspaceId` query parameter
- [ ] useKeepAliveStatus hook polls /keepalive/status every 30s, returns per-workspace failure data
- [ ] KeepAliveWarning renders nothing when consecutiveFailures < 3
- [ ] KeepAliveWarning renders destructive Alert banner when consecutiveFailures >= 3
- [ ] Uses shadcn Alert component (not custom HTML)
- [ ] Hook cleans up interval on unmount

## Verification

- `grep -q 'useKeepAliveStatus' src/hooks/useKeepAliveStatus.ts` — hook file exists
- `grep -q 'KeepAliveWarning' src/components/workspaces/TerminalTabManager.tsx` — banner mounted in tab manager
- `grep -q 'workspaceId' src/hooks/useTerminalWebSocket.ts || grep -rq 'workspaceId.*ws' src/components/workspaces/` — workspaceId passed in WebSocket URL
- `pnpm tsc --noEmit` — no TypeScript errors
  - Files: `src/hooks/useKeepAliveStatus.ts`, `src/components/workspaces/KeepAliveWarning.tsx`, `src/components/workspaces/TerminalTabManager.tsx`, `src/hooks/useTerminalWebSocket.ts`
  - Verify: pnpm tsc --noEmit && grep -q 'KeepAliveWarning' src/components/workspaces/TerminalTabManager.tsx

- [x] **T03: Add integration tests and verify end-to-end keep-alive flow** `est:1h30m`
  ## Description

Write integration tests that verify the complete keep-alive flow: proxy with mocked Coder API receives connections, pings the extend endpoint on interval, accumulates failures when API returns errors, exposes correct status via HTTP endpoint, and resets on recovery. Also add a component test for KeepAliveWarning rendering behavior.

## Negative Tests

- **Error paths**: Coder API returns 401 (expired token) — verify failure counter increments and lastError captured; API returns 500 — same treatment; network timeout — same treatment
- **Boundary conditions**: Zero connections → no pings; exactly 3 failures → banner threshold; recovery after failures → counter resets to 0

## Steps

1. Create `services/terminal-proxy/src/__tests__/keepalive-integration.test.ts`: spin up a mock HTTP server simulating Coder's extend endpoint, instantiate ConnectionRegistry + KeepAliveManager pointing at mock server, add a connection, verify ping hits mock server within interval, simulate API failure (return 500), verify consecutiveFailures increments, simulate recovery (return 200), verify counter resets.
2. Add status endpoint test: start the real proxy HTTP server (or a minimal version), hit `GET /keepalive/status`, verify response shape `{workspaces: {[id]: {consecutiveFailures, lastSuccess, lastFailure}}}`.
3. Create `src/components/workspaces/__tests__/KeepAliveWarning.test.tsx`: render KeepAliveWarning with mocked useKeepAliveStatus returning various failure counts. Assert: renders nothing at 0, 1, 2 failures; renders Alert with destructive variant at 3+ failures; displays correct failure count in message.
4. Verify all existing terminal-proxy tests still pass (no regressions from proxy.ts changes).

## Must-Haves

- [ ] Integration test proves KeepAliveManager pings mock Coder API on interval
- [ ] Integration test proves failure counter increments on API error and resets on success
- [ ] Component test proves KeepAliveWarning renders nothing below threshold and destructive Alert at threshold
- [ ] All existing terminal-proxy tests pass without regression

## Verification

- `cd services/terminal-proxy && pnpm vitest run` — all proxy tests pass including new integration tests
- `pnpm vitest run src/components/workspaces/__tests__/KeepAliveWarning.test.tsx` — component tests pass

## Observability Impact

- Signals added: test coverage for failure-path logging (verifies [keep-alive] prefix appears in expected scenarios)
- How a future agent inspects this: run test suites to verify keep-alive behavior without manual Coder API access
  - Files: `services/terminal-proxy/src/__tests__/keepalive-integration.test.ts`, `src/components/workspaces/__tests__/KeepAliveWarning.test.tsx`
  - Verify: cd services/terminal-proxy && pnpm vitest run && cd /home/coder/hive && pnpm vitest run src/components/workspaces/__tests__/KeepAliveWarning.test.tsx

## Files Likely Touched

- services/terminal-proxy/src/keepalive.ts
- services/terminal-proxy/src/proxy.ts
- services/terminal-proxy/src/index.ts
- services/terminal-proxy/src/__tests__/keepalive.test.ts
- src/hooks/useKeepAliveStatus.ts
- src/components/workspaces/KeepAliveWarning.tsx
- src/components/workspaces/TerminalTabManager.tsx
- src/hooks/useTerminalWebSocket.ts
- services/terminal-proxy/src/__tests__/keepalive-integration.test.ts
- src/components/workspaces/__tests__/KeepAliveWarning.test.tsx
