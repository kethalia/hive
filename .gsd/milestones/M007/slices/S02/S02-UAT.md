# S02: Terminal Integration & Session Management — UAT

**Milestone:** M007
**Written:** 2026-04-17T05:25:32.258Z

# S02 UAT: Terminal Integration & Session Management

## Preconditions
- Hive dashboard running at localhost
- At least one Coder workspace in "running" status with a Coder agent available
- Sidebar visible (click floating trigger if needed)

---

## Test Case 1: Workspace Expansion Shows Sessions and External Links

1. Open the sidebar and locate the "Workspaces" section
2. Click on a running workspace name to expand it
3. **Expected:** Collapsible opens showing:
   - Three external-link icon buttons (Filebrowser, KasmVNC, Code Server) if agent is available
   - List of existing terminal sessions (if any)
   - A "+" button to create a new session
4. Click one of the external-link buttons (e.g., Filebrowser)
5. **Expected:** Opens in a new browser tab with the correct URL

## Test Case 2: Create Terminal Session from Sidebar

1. Expand a running workspace in the sidebar
2. Click the "+" button
3. **Expected:** A new session is created, and the browser navigates to `/workspaces/[id]/terminal?session=<name>`
4. **Expected:** Terminal fills the entire viewport with no visible padding or gaps
5. **Expected:** Terminal is auto-focused — type a command (e.g., `ls`) and it appears in the terminal without clicking first

## Test Case 3: Keystroke Exclusivity

1. Navigate to a terminal page (via Test Case 2 or clicking an existing session)
2. Press Space, Arrow keys, Tab, and letter keys
3. **Expected:** All keystrokes are captured by xterm — none trigger sidebar actions or page scrolling
4. Click somewhere else on the page (outside terminal area), then click back inside the terminal area
5. **Expected:** Terminal re-focuses and captures keystrokes again

## Test Case 4: Kill Session from Sidebar

1. Expand a workspace that has at least one active session
2. Click the "x" button next to a session name
3. **Expected:** Session is removed from the sidebar list
4. **Expected:** Other sessions and workspace state remain unaffected

## Test Case 5: Session Polling

1. Expand a workspace in the sidebar
2. In a separate terminal or via Coder CLI, create a new tmux session in that workspace
3. Wait up to 30 seconds
4. **Expected:** The new session appears in the sidebar without manual refresh

## Test Case 6: Stale Entry Recovery

1. Expand a workspace and note a session entry
2. Stop the workspace via Coder (or kill the session externally)
3. Click the now-stale session entry in the sidebar
4. **Expected:** Terminal page shows an error Alert ("Could not find a running agent") with a "Back to home" link
5. **Expected:** Sidebar automatically refreshes its data (stale workspace/session removed or updated)

## Test Case 7: Error Handling — Agent Fetch Failure

1. Expand a workspace whose agent is unavailable (e.g., workspace is starting up)
2. **Expected:** External link buttons are hidden (agent info unavailable)
3. **Expected:** Session list shows error or gracefully degrades

## Test Case 8: Error Handling — Session Fetch Failure

1. Expand a workspace when the session fetch fails (simulate by network throttling or stopping the workspace mid-fetch)
2. **Expected:** Inline Alert appears with a retry button
3. Click retry
4. **Expected:** Sessions re-fetch and display correctly when the workspace is available

## Edge Cases

- **Zero sessions:** Expanding a workspace with no sessions shows only the "+" create button
- **Multiple workspaces expanded:** Each workspace polls independently; expanding/collapsing one doesn't affect others
- **Rapid expand/collapse:** No orphaned polling intervals or stale data
