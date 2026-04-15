# S03: Multi-Tab Terminal & Session Management — UAT

**Milestone:** M005
**Written:** 2026-04-14T11:34:43.091Z

# S03 UAT: Multi-Tab Terminal & Session Management

## Preconditions
- Hive dashboard running (`tsx watch server.ts`)
- At least one Coder workspace online with tmux available
- Browser open to `/workspaces`

## Test Case 1: Create Multiple Terminal Tabs
1. Click a workspace from the list to open `/workspaces/[id]/terminal`
2. **Expected:** Terminal page loads with one tab connected to a tmux session (either from URL param, existing sessions, or fallback `hive-main`)
3. Click the "+" button in the tab bar
4. **Expected:** A new tab appears with an auto-generated name (e.g., `session-1713100000000`), connected to a new tmux session
5. Click "+" again to create a third tab
6. **Expected:** Three tabs visible in the tab bar, each with its own session name

## Test Case 2: Tab Switching Preserves Terminal State
1. In the first tab, type `echo "tab1"` and press Enter
2. Switch to the second tab by clicking it
3. **Expected:** Second tab's terminal is visible and interactive; first tab's terminal is hidden but NOT destroyed
4. Type `echo "tab2"` in the second tab
5. Switch back to the first tab
6. **Expected:** First tab shows previous output (`tab1`) with scrollback intact — xterm.js instance was preserved, not recreated

## Test Case 3: Inline Tab Rename
1. Double-click on a tab label
2. **Expected:** Tab label becomes an editable input field
3. Type a new valid name (e.g., `my-build`) and press Enter
4. **Expected:** Tab label updates to `my-build`; tmux session is renamed server-side (verify with `tmux list-sessions` in another terminal)
5. Double-click another tab label, type an invalid name (e.g., `bad;name`), press Enter
6. **Expected:** Rename is rejected (client-side SAFE_IDENTIFIER_RE validation), original name restored
7. Double-click a tab label, then press Escape
8. **Expected:** Rename cancelled, original name restored

## Test Case 4: Kill Session (Destructive)
1. With multiple tabs open, click the kill button on a non-active tab
2. **Expected:** Tab is removed from the tab bar; tmux session is destroyed server-side
3. Kill the active tab
4. **Expected:** Tab removed, focus switches to nearest remaining tab
5. Kill all remaining tabs
6. **Expected:** Empty state displayed with "Create New Session" button

## Test Case 5: Close Tab vs Kill (Non-Destructive)
1. Create a tab connected to session `test-close`
2. Click the X (close) button on the tab
3. **Expected:** Tab removed from tab bar, but tmux session `test-close` still exists (verify with `tmux list-sessions` in another terminal)
4. Use session picker to reconnect to `test-close`
5. **Expected:** Previous session output and scrollback are intact

## Test Case 6: Session Picker
1. Create several tmux sessions manually in the workspace (`tmux new-session -d -s manual-1`, `tmux new-session -d -s manual-2`)
2. Click the session picker (dropdown near the "+" button)
3. **Expected:** Dropdown shows `manual-1` and `manual-2` (sessions not already open in tabs)
4. Click `manual-1` in the picker
5. **Expected:** New tab opens connected to the existing `manual-1` session
6. Open the picker again
7. **Expected:** `manual-1` no longer listed (already open); `manual-2` still available
8. Open all remaining sessions
9. **Expected:** Picker shows only "Create New" option when all sessions are open

## Edge Cases
- **Single tab protection:** With only one tab open, the X close button should be hidden
- **Network interruption:** Disconnect network briefly; tabs should show connection state badges and attempt reconnection
- **Rapid tab creation:** Click "+" multiple times quickly; each should create a distinct session without collisions (timestamp-based naming)
