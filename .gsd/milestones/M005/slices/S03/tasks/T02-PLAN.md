---
estimated_steps: 6
estimated_files: 3
skills_used: []
---

# T02: Build TerminalTabManager component with multi-tab terminal support

Create `src/components/workspaces/TerminalTabManager.tsx` — a client component that manages multiple terminal tabs. Replace the single-terminal rendering in `terminal-client.tsx` with this tab manager. Update `page.tsx` to fetch existing tmux sessions and pass them to the client.

The tab manager maintains state: `tabs: Array<{ id: string, sessionName: string }>` and `activeTabId: string`. It renders a horizontal tab bar using Button components (ghost variant for inactive, outline for active — no Tabs component exists in the UI library per research). Each tab shows the session name and an X close button. A "+" button at the end creates a new tab by calling `createSessionAction` from T01.

CRITICAL: Inactive terminals must be hidden via `style={{ display: 'none' }}`, NOT via conditional rendering. Unmounting destroys the xterm.js Terminal instance and WebSocket connection (cleanup in InteractiveTerminal.tsx lines 165-172 calls term.dispose()). All InteractiveTerminal instances stay mounted — only visibility changes.

The tab manager receives `agentId`, `coderUrl`, and `initialSessions: TmuxSession[]` as props. On mount, if `initialSessionName` is provided (from URL query param), it opens that session as the first tab. The "+" button calls `createSessionAction` to create a new tmux session, then adds a tab for it.

Update `page.tsx` to call `getWorkspaceSessionsAction` alongside `getWorkspaceAgentAction` so existing sessions are available on page load. Pass the sessions list to terminal-client.tsx which forwards to TerminalTabManager.

This task delivers R038 (multiple terminal tabs open simultaneously).

## Inputs

- ``src/lib/actions/workspaces.ts` — createSessionAction from T01, getWorkspaceSessionsAction, getWorkspaceAgentAction`
- ``src/components/workspaces/InteractiveTerminal.tsx` — InteractiveTerminal component (unchanged, props: agentId, sessionName, coderUrl, className?)`
- ``src/app/workspaces/[id]/terminal/terminal-client.tsx` — current single-terminal wrapper to replace`
- ``src/app/workspaces/[id]/terminal/page.tsx` — server component to update with sessions fetch`
- ``src/lib/workspaces/sessions.ts` — TmuxSession interface`

## Expected Output

- ``src/components/workspaces/TerminalTabManager.tsx` — new TerminalTabManager client component with tab state, tab bar, CSS-hidden inactive terminals, create/close tab functionality`
- ``src/app/workspaces/[id]/terminal/terminal-client.tsx` — updated to render TerminalTabManager instead of single InteractiveTerminal`
- ``src/app/workspaces/[id]/terminal/page.tsx` — updated to fetch sessions list and pass to client`

## Verification

pnpm build && grep -q 'TerminalTabManager' src/app/workspaces/\[id\]/terminal/terminal-client.tsx && grep -q 'getWorkspaceSessionsAction' src/app/workspaces/\[id\]/terminal/page.tsx
