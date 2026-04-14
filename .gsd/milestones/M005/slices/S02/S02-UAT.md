# S02: Bidirectional Terminal via PTY WebSocket — UAT

**Milestone:** M005
**Written:** 2026-04-14T11:18:41.657Z

# S02 UAT: Bidirectional Terminal via PTY WebSocket

## Preconditions
- Hive dashboard running via `tsx watch server.ts` (custom server, not `next dev`)
- At least one Coder workspace in "running" state with a connected agent
- `CODER_SESSION_TOKEN` set in server environment
- Browser with devtools open (Console + Network tabs)

## Test Cases

### TC1: New Terminal Button Visibility
1. Navigate to `/workspaces`
2. Observe workspace cards
3. **Expected:** Running workspaces show a "New Terminal" button with Terminal icon in the tool links bar
4. **Expected:** Non-running workspaces do NOT show a terminal button

### TC2: Open New Terminal Session
1. Click "New Terminal" on a running workspace
2. **Expected:** Browser navigates to `/workspaces/{id}/terminal`
3. **Expected:** Connection state badge shows yellow (connecting) briefly, then green (connected)
4. **Expected:** Terminal renders with Dracula-like theme, blinking cursor
5. Type `echo hello` and press Enter
6. **Expected:** "hello" appears as output in the terminal
7. Type `whoami` and press Enter
8. **Expected:** Workspace user name appears

### TC3: Interactive Program (vim)
1. In the open terminal, type `vim /tmp/test.txt` and press Enter
2. **Expected:** Vim opens in the terminal with full TUI rendering
3. Press `i`, type "test content", press Escape, type `:wq` and Enter
4. Type `cat /tmp/test.txt` and press Enter
5. **Expected:** "test content" is displayed

### TC4: Terminal Resize
1. Resize the browser window (drag edge to make it narrower/wider)
2. **Expected:** Terminal content reflows to fit the new dimensions
3. Run `tput cols && tput lines`
4. **Expected:** Values match the visible terminal dimensions

### TC5: Tmux Session Persistence (D019)
1. Open a terminal and run `echo $TMUX` — confirm you're inside tmux
2. Run `for i in $(seq 1 50); do echo "line $i"; done` to generate scrollback
3. Close the browser tab
4. Navigate back to `/workspaces/{id}/terminal`
5. **Expected:** Terminal reconnects and shows the same tmux session
6. **Expected:** Scrollback history is preserved (scroll up to see "line 1" through "line 50")

### TC6: Per-Session Connect Button
1. Navigate to `/workspaces`, expand a workspace's tmux sessions panel
2. Click "Connect" on a specific session (e.g., "hive-main")
3. **Expected:** Browser navigates to `/workspaces/{id}/terminal?session=hive-main`
4. **Expected:** Terminal attaches to the named tmux session, not a new one

### TC7: Auto-Reconnect on Network Interruption (R042)
1. Open a terminal with a connected session
2. In browser devtools Network tab, switch to "Offline" mode
3. **Expected:** Connection badge turns yellow (reconnecting)
4. **Expected:** Browser console shows reconnect attempts with increasing backoff intervals
5. Switch back to "Online" mode
6. **Expected:** Terminal reconnects automatically, badge turns green
7. **Expected:** Tmux session is reattached with scrollback intact

### TC8: Workspace Offline Detection
1. Stop the Coder workspace agent (e.g., `coder stop <workspace>`)
2. Attempt to open a terminal for that workspace
3. **Expected:** Terminal shows "Workspace offline" message with red badge
4. **Expected:** No reconnect attempts after offline detection

### TC9: Security — Token Not Exposed
1. Open browser devtools, go to Network tab
2. Open a terminal session
3. Inspect the WebSocket upgrade request
4. **Expected:** `CODER_SESSION_TOKEN` does NOT appear in any request headers, query params, or WebSocket frames visible to the browser
5. In browser console, search for "CODER_SESSION_TOKEN"
6. **Expected:** No matches

### TC10: Multiple Workspaces
1. Open terminals for two different running workspaces in separate tabs
2. Type commands in each
3. **Expected:** Each terminal operates independently with its own session
4. **Expected:** Closing one does not affect the other

## Edge Cases

### EC1: Non-Running Workspace Direct URL
1. Navigate directly to `/workspaces/{stopped-workspace-id}/terminal`
2. **Expected:** Graceful error or redirect — not a crash

### EC2: Invalid Session Name
1. Navigate to `/workspaces/{id}/terminal?session=bad;name`
2. **Expected:** Falls back to default session name or shows validation error — no command injection
