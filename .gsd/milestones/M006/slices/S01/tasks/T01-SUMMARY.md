---
id: T01
parent: S01
milestone: M006
key_files:
  - services/terminal-proxy/src/keepalive.ts
  - services/terminal-proxy/src/proxy.ts
  - services/terminal-proxy/src/index.ts
  - services/terminal-proxy/test/keepalive.test.ts
key_decisions:
  - workspaceId is optional on WebSocket upgrade — existing clients without it still work, keep-alive just won't track those connections
  - KeepAliveManager.ping is public for testability — tests call it directly rather than relying on timer advancement for assertion precision
  - CORS on /keepalive/status reuses the same isOriginAllowed logic from WebSocket origin validation
duration: 
verification_result: passed
completed_at: 2026-04-15T14:28:32.894Z
blocker_discovered: false
---

# T01: Add ConnectionRegistry, KeepAliveManager, and /keepalive/status endpoint to terminal-proxy

**Add ConnectionRegistry, KeepAliveManager, and /keepalive/status endpoint to terminal-proxy**

## What Happened

Created `services/terminal-proxy/src/keepalive.ts` with two classes:\n\n- **ConnectionRegistry**: Tracks `workspaceId → Set<connectionId>` mappings. Auto-removes workspace entries when the last connection closes. Methods: `addConnection`, `removeConnection`, `getActiveWorkspaceIds`, `getConnectionCount`.\n\n- **KeepAliveManager**: Accepts a ConnectionRegistry, coderUrl, and sessionToken. Runs a 55-second interval that calls `PUT /api/v2/workspaces/{id}/extend` for each workspace with active connections. Tracks per-workspace health: consecutiveFailures (resets to 0 on success), lastSuccess, lastFailure, lastError. All logs use `[keep-alive]` prefix. Session token never appears in logs.\n\nModified `proxy.ts` to parse `workspaceId` as an optional WebSocket query parameter. When provided, connections are registered in a singleton `ConnectionRegistry` on upgrade and deregistered on WebSocket close. Each connection gets a unique UUID.\n\nModified `index.ts` to instantiate KeepAliveManager on startup (only when CODER_URL and CODER_SESSION_TOKEN are set), add the `GET /keepalive/status` HTTP endpoint returning per-workspace health JSON, and apply CORS headers matching the existing ALLOWED_ORIGINS pattern.\n\nGraceful degradation: if env vars are missing, logs a warning and skips keep-alive initialization — proxy still works for terminals.\n\nFailure modes implemented: HTTP errors increment consecutiveFailures with status code in lastError; network errors and fetch timeouts (10s AbortController) are treated as failures; 401/404 responses are logged clearly.

## Verification

Ran `pnpm vitest run` — all 56 tests pass (21 new keep-alive tests + 35 existing). Verified `keep-alive` string exists in keepalive.ts and `keepalive/status` route registered in index.ts. Tests cover: registry add/remove/auto-cleanup, ping success/failure/timeout, interval start/stop, no-ping-on-zero-connections, token redaction, trailing-slash normalization, rapid connect/disconnect, and HTTP 401/404 error paths.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd services/terminal-proxy && pnpm vitest run` | 0 | ✅ pass | 208ms |
| 2 | `grep -q 'keep-alive' services/terminal-proxy/src/keepalive.ts` | 0 | ✅ pass | 5ms |
| 3 | `grep -q 'keepalive/status' services/terminal-proxy/src/index.ts` | 0 | ✅ pass | 5ms |

## Deviations

Test file placed in test/keepalive.test.ts (matching vitest.config.ts include pattern) instead of src/__tests__/keepalive.test.ts as the task plan suggested.

## Known Issues

None

## Files Created/Modified

- `services/terminal-proxy/src/keepalive.ts`
- `services/terminal-proxy/src/proxy.ts`
- `services/terminal-proxy/src/index.ts`
- `services/terminal-proxy/test/keepalive.test.ts`
