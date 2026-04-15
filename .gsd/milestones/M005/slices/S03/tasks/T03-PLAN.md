---
estimated_steps: 5
estimated_files: 2
skills_used: []
---

# T03: Add session rename, kill controls, and session picker to tab manager

Extend the TerminalTabManager from T02 with session lifecycle management UI (R039) and a session picker for connecting to existing sessions.

**Rename:** Double-click on a tab label enters inline edit mode — the tab name becomes an input field. On Enter or blur, call `renameSessionAction` from T01 to rename the tmux session server-side, then update local tab state. Validate against SAFE_IDENTIFIER_RE client-side before calling the action. On Escape, cancel the rename. Important: renaming only changes the tmux session name and tab label — the active WebSocket connection is unaffected because it's already attached to the tmux session by PID, not name (per research pitfalls).

**Kill:** Add a kill button (or right-click context option) that calls `killSessionAction` from T01 to destroy the tmux session, then removes the tab. If the killed tab was active, switch to the nearest remaining tab. If no tabs remain, show an empty state with a "Create New Session" button. Closing a tab (X button from T02) should only disconnect the WebSocket without killing the tmux session — kill is a separate explicit action.

**Session picker:** Add a dropdown or panel (triggered from the "+" button area) that lists existing tmux sessions not already open in a tab. Fetches via `getWorkspaceSessionsAction`. Clicking a session in the picker opens it as a new tab. If all sessions are already open, show a "Create New" option only.

Write tests in `src/__tests__/components/terminal-tab-manager.test.tsx` covering: tab rename triggers renameSessionAction, kill removes tab and calls killSessionAction, session picker filters already-open sessions.

## Inputs

- ``src/components/workspaces/TerminalTabManager.tsx` — tab manager from T02 to extend`
- ``src/lib/actions/workspaces.ts` — renameSessionAction, killSessionAction, getWorkspaceSessionsAction from T01`
- ``src/lib/constants.ts` — SAFE_IDENTIFIER_RE for client-side validation`

## Expected Output

- ``src/components/workspaces/TerminalTabManager.tsx` — extended with inline rename, kill action, session picker dropdown`
- ``src/__tests__/components/terminal-tab-manager.test.tsx` — tests for rename, kill, and session picker behavior`

## Verification

pnpm vitest run src/__tests__/components/terminal-tab-manager.test.tsx && pnpm vitest run && pnpm build
