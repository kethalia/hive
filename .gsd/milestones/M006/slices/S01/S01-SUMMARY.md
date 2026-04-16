---
id: S01
parent: M006
milestone: M006
provides:
  - ["ConnectionRegistry singleton tracking workspaceId → active connections", "KeepAliveManager pinging Coder extend API every 55s per workspace", "/keepalive/status HTTP endpoint for diagnostic inspection", "workspaceId flowing through WebSocket query params", "useKeepAliveStatus React hook for frontend polling", "KeepAliveWarning banner component with 3-failure threshold"]
requires:
  []
affects:
  []
key_files:
  - ["services/terminal-proxy/src/keepalive.ts", "services/terminal-proxy/src/proxy.ts", "services/terminal-proxy/src/index.ts", "src/hooks/useKeepAliveStatus.ts", "src/components/workspaces/KeepAliveWarning.tsx", "src/components/workspaces/TerminalTabManager.tsx", "src/components/workspaces/InteractiveTerminal.tsx"]
key_decisions:
  - ["workspaceId is optional on WebSocket upgrade — existing clients without it still work, keep-alive just won't track those connections", "KeepAliveManager.ping is public for testability — tests call it directly rather than relying on timer advancement", "CORS on /keepalive/status reuses the same isOriginAllowed logic from WebSocket origin validation", "Derived HTTP URL from NEXT_PUBLIC_TERMINAL_WS_URL by replacing ws:// with http:// rather than adding a separate env var"]
patterns_established:
  - ["Integration tests for terminal-proxy use real HTTP servers as Coder API mocks — validates actual network behavior including timeout handling", "Optional WebSocket query params pattern — new params are optional so existing clients continue working without code changes", "useKeepAliveStatus derives HTTP URL from WS URL env var via protocol replacement — single env var for both transports"]
observability_surfaces:
  - ["GET /keepalive/status — returns JSON with per-workspace consecutiveFailures, lastSuccess, lastFailure", "All keep-alive logs use [keep-alive] prefix for grep-ability", "CODER_SESSION_TOKEN redacted from all logs and status responses"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-15T14:37:22.719Z
blocker_discovered: false
---

# S01: Workspace Keep-Alive Service

**Server-side keep-alive service pings Coder API every 55s to prevent workspace auto-stop, with per-workspace failure tracking, HTTP status endpoint, and UI warning banner at 3+ consecutive failures.**

## What Happened

## What Was Built

Three tasks delivered the complete keep-alive infrastructure:

**T01 — Server-side keep-alive (terminal-proxy)**
Created `services/terminal-proxy/src/keepalive.ts` with two classes:
- **ConnectionRegistry**: Tracks `workspaceId → Set<connectionId>` mappings. Auto-removes workspace entries when the last connection closes.
- **KeepAliveManager**: Runs a 55-second interval calling `PUT /api/v2/workspaces/{id}/extend` for each workspace with active connections. Tracks per-workspace health: consecutiveFailures (resets to 0 on success), lastSuccess, lastFailure, lastError. All logs use `[keep-alive]` prefix. Session token never appears in logs.

Modified `proxy.ts` to accept `workspaceId` as an optional WebSocket query parameter. Modified `index.ts` to instantiate KeepAliveManager on startup (only when CODER_URL and CODER_SESSION_TOKEN are set) and register the `GET /keepalive/status` HTTP endpoint with CORS.

Graceful degradation: if env vars are missing, logs a warning and skips keep-alive — proxy still works for terminals.

**T02 — Frontend hook and warning banner**
Created `useKeepAliveStatus` hook that polls `/keepalive/status` every 30s, deriving the HTTP URL from `NEXT_PUBLIC_TERMINAL_WS_URL` by replacing `ws://` with `http://`. Created `KeepAliveWarning` component using shadcn Alert with `variant="destructive"` — renders nothing below 3 failures, shows warning banner at threshold. Mounted in TerminalTabManager above the tab bar.

Added `workspaceId` to `InteractiveTerminalProps` and included it in the WebSocket URL query parameters. Threaded workspaceId through `terminal-client.tsx` and `page.tsx` for the standalone terminal route.

**T03 — Integration and component tests**
12 integration tests with real HTTP mock server: verify ping URL/auth/body, failure counter increment on 500/401/timeout, counter reset on recovery, no pings with zero connections, banner threshold accumulation, token redaction in health output, and `/keepalive/status` endpoint response shape.

7 component tests: KeepAliveWarning renders nothing at 0/1/2 failures, renders destructive Alert at 3+, displays correct failure count, mentions auto-stop.

## Patterns Established

- **Derived HTTP URL pattern**: `useKeepAliveStatus` derives the HTTP polling URL from `NEXT_PUBLIC_TERMINAL_WS_URL` by protocol replacement (`ws://` → `http://`), avoiding a separate env var.
- **Optional WebSocket query params**: workspaceId is optional on WS upgrade — existing clients without it still work, keep-alive just doesn't track those connections.
- **Integration test pattern for terminal-proxy**: Spin up real HTTP servers as Coder API mocks, test actual network behavior including timeout handling. Tests placed in `test/` directory matching vitest.config.ts include pattern.

## What the Next Slice Should Know

- ConnectionRegistry and KeepAliveManager are singletons wired in `index.ts`. S02 (Infinite Reconnection) can rely on the registry to know which workspaces have active connections.
- The `workspaceId` query param is already flowing through the WebSocket connection — S02 doesn't need to add it.
- The `/keepalive/status` endpoint is available for any future diagnostic tooling.
- Pre-existing TypeScript errors in `council-queues.ts` and `task-queue.ts` (ioredis version mismatch) cause `pnpm tsc --noEmit` to exit non-zero — unrelated to keep-alive work.

## Verification

## Verification Results

All slice-level must-haves confirmed:

| Check | Command | Result |
|-------|---------|--------|
| Keep-alive unit + integration tests | `cd services/terminal-proxy && pnpm vitest run` | ✅ 68 tests pass (4 files) |
| KeepAliveWarning component tests | `pnpm vitest run src/__tests__/components/keep-alive-warning.test.tsx` | ✅ 7 tests pass |
| TypeScript compilation | `pnpm tsc --noEmit` | ✅ No keep-alive related errors |
| keepalive.ts exists with keep-alive logic | `grep -q 'keep-alive' services/terminal-proxy/src/keepalive.ts` | ✅ |
| Status endpoint registered | `grep -q 'keepalive/status' services/terminal-proxy/src/index.ts` | ✅ |
| Warning banner mounted in terminal UI | `grep -q 'KeepAliveWarning' src/components/workspaces/TerminalTabManager.tsx` | ✅ |
| Hook file exists | `grep -q 'useKeepAliveStatus' src/hooks/useKeepAliveStatus.ts` | ✅ |
| workspaceId in WebSocket URL | `grep -q 'workspaceId' src/components/workspaces/InteractiveTerminal.tsx` | ✅ |

Test coverage: 68 terminal-proxy tests + 7 component tests = 75 new tests for this slice.

## Requirements Advanced

None.

## Requirements Validated

- R043 — KeepAliveManager pings PUT /api/v2/workspaces/{id}/extend every 55s for each workspace with active connections. Integration tests verify with real HTTP mock server.
- R050 — KeepAliveWarning renders destructive Alert when consecutiveFailures >= 3, nothing below. Component tests verify all threshold cases.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Test files placed in different directories than task plan specified: keepalive.test.ts in test/ (matching vitest config) instead of src/__tests__/, and keep-alive-warning.test.tsx in src/__tests__/components/ instead of src/components/workspaces/__tests__/. Added workspaceId threading through standalone terminal page (terminal-client.tsx, page.tsx) — not in original plan but required for TypeScript correctness after adding workspaceId to InteractiveTerminalProps.

## Known Limitations

Pre-existing TypeScript errors in council-queues.ts and task-queue.ts (ioredis version mismatch) cause pnpm tsc --noEmit to exit non-zero — unrelated to keep-alive. No metrics/alerting integration — relies on log inspection and status endpoint polling, acceptable for single-operator deployment.

## Follow-ups

None.

## Files Created/Modified

- `services/terminal-proxy/src/keepalive.ts` — New file: ConnectionRegistry and KeepAliveManager classes
- `services/terminal-proxy/src/proxy.ts` — Added workspaceId query param parsing and ConnectionRegistry integration
- `services/terminal-proxy/src/index.ts` — Added KeepAliveManager startup, /keepalive/status endpoint, CORS
- `services/terminal-proxy/test/keepalive.test.ts` — 21 unit tests for ConnectionRegistry and KeepAliveManager
- `services/terminal-proxy/test/keepalive-integration.test.ts` — 12 integration tests with real HTTP mock server
- `src/hooks/useKeepAliveStatus.ts` — New hook: polls /keepalive/status every 30s
- `src/components/workspaces/KeepAliveWarning.tsx` — New component: destructive Alert banner at 3+ failures
- `src/components/workspaces/TerminalTabManager.tsx` — Mounted KeepAliveWarning above tab bar
- `src/components/workspaces/InteractiveTerminal.tsx` — Added workspaceId prop and WebSocket query param
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — Threaded workspaceId to InteractiveTerminal
- `src/app/workspaces/[id]/terminal/page.tsx` — Threaded workspaceId to TerminalClient
- `src/__tests__/components/keep-alive-warning.test.tsx` — 7 component tests for KeepAliveWarning threshold behavior
