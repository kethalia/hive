# S01: Workspace Keep-Alive Service — UAT

**Milestone:** M006
**Written:** 2026-04-15T14:37:22.720Z

# S01 UAT: Workspace Keep-Alive Service

## Preconditions
- Terminal-proxy running with `CODER_URL` and `CODER_SESSION_TOKEN` set
- At least one Coder workspace in running state
- Browser open to Hive dashboard

## Test Cases

### TC1: Keep-alive status endpoint returns health data
1. Open a terminal tab for a running workspace in the dashboard
2. Wait 10 seconds for WebSocket connection to establish
3. Run `curl http://localhost:3001/keepalive/status`
4. **Expected:** JSON response with `workspaces` object containing the workspace ID as key, with `consecutiveFailures: 0`, `lastSuccess` timestamp, and `lastFailure: null`

### TC2: Keep-alive pings prevent workspace auto-stop
1. Open a terminal tab for a workspace with a short auto-stop deadline (e.g., 1 hour)
2. Verify the workspace deadline extends after 55 seconds by checking Coder dashboard or `coder list`
3. Close the browser tab but leave terminal-proxy running
4. Wait 5 minutes — the workspace should NOT auto-stop because keep-alive continues pinging
5. **Expected:** Workspace remains running; `/keepalive/status` shows `consecutiveFailures: 0`

### TC3: Warning banner appears after 3 consecutive failures
1. Open a terminal tab for a workspace
2. Stop the Coder API or set an invalid `CODER_SESSION_TOKEN` on the proxy
3. Wait ~3 minutes (3 × 55s intervals) for 3 consecutive failures
4. Observe the terminal UI in the browser
5. **Expected:** A red destructive Alert banner appears above the terminal tabs reading "Keep-alive service cannot reach Coder API (3 consecutive failures). Your workspace may auto-stop if this continues."

### TC4: Warning banner disappears on recovery
1. With the warning banner visible from TC3, restore the Coder API or fix the session token
2. Wait for the next ping interval (~55s)
3. **Expected:** The warning banner disappears after the failure counter resets to 0

### TC5: No banner below threshold
1. Open a terminal tab for a workspace
2. Cause exactly 2 consecutive keep-alive failures (e.g., briefly block the Coder API)
3. **Expected:** No warning banner appears — threshold is 3

### TC6: Keep-alive stops when last connection closes
1. Open a terminal tab for a workspace — verify `/keepalive/status` shows the workspace
2. Close all terminal tabs for that workspace
3. Wait 60 seconds
4. Check `/keepalive/status`
5. **Expected:** The workspace is no longer listed in the status endpoint — no orphaned pings

### TC7: Graceful degradation without env vars
1. Start terminal-proxy WITHOUT `CODER_URL` and `CODER_SESSION_TOKEN`
2. Open a terminal — verify it connects and works normally
3. **Expected:** Terminal works for interactive use; proxy logs `[keep-alive]` warning about missing env vars; `/keepalive/status` is not registered (404)

### TC8: workspaceId flows through WebSocket connection
1. Open browser DevTools Network tab
2. Open a terminal tab for a workspace
3. Inspect the WebSocket connection URL
4. **Expected:** URL includes `workspaceId=<actual-workspace-id>` as a query parameter

### TC9: CORS on status endpoint
1. From a browser on the Hive dashboard origin, run `fetch('http://localhost:3001/keepalive/status')` in DevTools console
2. **Expected:** Response is returned without CORS error (origin matches ALLOWED_ORIGINS)
3. From a different origin, attempt the same fetch
4. **Expected:** CORS error — origin not in ALLOWED_ORIGINS

### Edge Cases

### TC10: Multiple workspaces tracked independently
1. Open terminal tabs for two different workspaces
2. Check `/keepalive/status`
3. **Expected:** Both workspaces appear with independent failure counters and timestamps
