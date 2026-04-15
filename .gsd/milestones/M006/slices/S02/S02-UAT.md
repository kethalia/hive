# S02: Infinite Reconnection & Session Continuity — UAT

**Milestone:** M006
**Written:** 2026-04-15T15:10:15.859Z

# S02 UAT: Infinite Reconnection & Session Continuity

## Preconditions
- Hive dashboard running via `tsx watch server.ts`
- At least one Coder workspace in "running" state
- Browser DevTools console open, filtered to `[terminal]`

## Test Cases

### TC1: Infinite Reconnection with Banner
1. Open a terminal session to a running workspace
2. Simulate network disconnection (DevTools → Network → Offline, or disconnect WiFi)
3. **Expected:** Reconnecting banner appears with spinning icon showing "Reconnecting... Attempt 1"
4. Wait 30+ seconds, observe attempt count incrementing in the banner
5. **Expected:** Attempts continue beyond 10 (the old hard limit) — no permanent "failed" state from retry exhaustion
6. **Expected:** Console shows `[terminal] Reconnect attempt N` with increasing N, backoff delays capping at 60 seconds between attempts
7. Re-enable network
8. **Expected:** Terminal reconnects automatically, banner disappears, session resumes

### TC2: Reconnect Now Button
1. With terminal in reconnecting state (network disconnected), observe the reconnecting banner
2. **Expected:** "Reconnect Now" button visible in the banner
3. Click "Reconnect Now"
4. **Expected:** Immediate reconnection attempt (resets backoff timer)
5. If terminal reaches "failed" state (e.g., workspace offline), verify "Reconnect Now" button also appears in the failed banner

### TC3: ReconnectId Regeneration After 3 Consecutive Failures
1. Open a terminal session, note the reconnectId in localStorage (key: `terminal_reconnect_{agentId}_{sessionName}`)
2. Stop the terminal-proxy server to simulate a completely unreachable backend
3. **Expected:** After 3 consecutive connection failures (WebSocket connects then immediately closes), console shows `[terminal] Regenerating reconnectId after 3 consecutive failures`
4. Check localStorage — reconnectId should be a new UUID with fresh timestamp
5. Restart the terminal-proxy
6. **Expected:** Terminal reconnects using the new reconnectId, attaching to the same tmux session

### TC4: Tab Switching Preserves Scrollback
1. Open two terminal tabs in the same workspace
2. In Tab 1, run `seq 1 500` to generate scrollback
3. In Tab 2, run `seq 1 200` to generate scrollback
4. Switch to Tab 1
5. **Expected:** All 500 lines of scrollback visible, scroll position preserved, no rendering glitches
6. Switch to Tab 2
7. **Expected:** All 200 lines of scrollback visible, no data loss
8. Resize the browser window while on Tab 2
9. Switch to Tab 1
10. **Expected:** Terminal re-fits to new dimensions, scrollback still intact

### TC5: Backoff Cap at 60 Seconds
1. Open browser console, filter to `[terminal]`
2. Disconnect network
3. Observe reconnection attempt logs with backoff timing
4. **Expected:** Backoff increases exponentially (1s, 2s, 4s, 8s, 16s, 32s) then caps at 60s
5. **Expected:** No attempt exceeds 60-second delay

## Edge Cases
- **Browser tab backgrounded during reconnection:** Reconnection should continue when tab is foregrounded
- **Rapid tab switching:** Switching between 3+ tabs rapidly should not cause double-fit or rendering corruption
- **localStorage cleared during session:** ReconnectId regenerates cleanly on next connection attempt
