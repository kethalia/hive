# S03 — Multi-Tab Terminal & Session Management — Research

**Date:** 2026-04-14
**Depth:** Light research — straightforward extension of established S02 patterns to add tabbed UI, session create/rename/kill.

## Summary

S03 adds multi-tab terminal support and tmux session lifecycle management (create, rename, kill) to the workspace terminal page. S02 delivered the complete single-terminal stack: `InteractiveTerminal` component, `useTerminalWebSocket` hook, WebSocket proxy, and PTY protocol layer. S03 wraps multiple `InteractiveTerminal` instances in a tabbed container, adds server actions for tmux rename/kill, and provides UI controls for session management.

This is well-scoped work with no new technology. The existing `InteractiveTerminal` component is already parameterized by `sessionName` and `agentId` — each tab instantiates its own component with a distinct session name. The WebSocket proxy already handles concurrent connections (each upgrade is independent). The `execInWorkspace` utility already executes arbitrary commands via `coder ssh`, so rename/kill are just new tmux commands through the same channel.

## Recommendation

Build a `TerminalTabManager` client component that replaces the current single-terminal `TerminalClient`. It manages an array of open tabs (each with agentId + sessionName), renders a tab bar with close/rename controls, and mounts one `InteractiveTerminal` per tab (keeping inactive tabs mounted but hidden to preserve terminal state). Add three new server actions (`createSessionAction`, `renameSessionAction`, `killSessionAction`) following the existing `getWorkspaceSessionsAction` pattern. No changes needed to the WebSocket proxy, protocol layer, or `InteractiveTerminal` itself.

## Implementation Landscape

### Key Files

- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — Currently renders a single `InteractiveTerminal`. Replace with tabbed container that manages multiple terminals. This is the primary new UI work.
- `src/app/workspaces/[id]/terminal/page.tsx` — Server component that resolves agentId. Needs to also fetch existing tmux sessions so the tab manager can show a session picker on load.
- `src/components/workspaces/InteractiveTerminal.tsx` — No changes needed. Already accepts `agentId`, `sessionName`, `coderUrl` props. Each tab instantiates one.
- `src/hooks/useTerminalWebSocket.ts` — No changes needed. Each `InteractiveTerminal` creates its own hook instance.
- `src/lib/actions/workspaces.ts` — Add `createSessionAction`, `renameSessionAction`, `killSessionAction`. All use `execInWorkspace` with tmux commands, same pattern as `getWorkspaceSessionsAction`.
- `src/lib/workspaces/sessions.ts` — May need to export session name generation logic (auto-name from cwd pattern).
- `src/components/workspaces/WorkspacesClient.tsx` — Minor: rename/kill buttons could be added to the session list in the workspace overview, or this can be deferred to the terminal page only.
- `src/lib/constants.ts` — `SAFE_IDENTIFIER_RE` already exists for session name validation.

### Build Order

1. **Server actions first (rename, kill, create)** — These are independent pure functions using `execInWorkspace`. Easy to unit test in isolation. Unblocks all UI work.
   - `createSessionAction(workspaceId, sessionName?)` — if no name provided, could default or let tmux auto-name. Validates against `SAFE_IDENTIFIER_RE`.
   - `renameSessionAction(workspaceId, oldName, newName)` — `tmux rename-session -t oldName newName`
   - `killSessionAction(workspaceId, sessionName)` — `tmux kill-session -t sessionName`

2. **Tab manager component** — The core UI. A client component that:
   - Maintains `tabs: Array<{ id: string, sessionName: string }>` state
   - Renders a horizontal tab bar (use existing Button variant="ghost" for tabs, no Tabs component exists in the UI library)
   - Active tab's `InteractiveTerminal` is visible; inactive tabs are `display: none` (NOT unmounted — unmounting destroys the xterm instance and WebSocket)
   - "+" button opens a new tab (calls `createSessionAction` or connects to existing session)
   - "x" button on each tab closes it (disposes terminal, optionally kills tmux session)
   - Right-click or double-click tab name to rename (calls `renameSessionAction`)
   - Session picker dropdown/modal for connecting to existing sessions

3. **Wire into page** — Update `page.tsx` to fetch sessions list alongside agentId. Update `terminal-client.tsx` to use tab manager instead of single terminal.

4. **Session management panel** — Optional sidebar or dropdown showing all tmux sessions for the workspace, with create/rename/kill controls. Could be part of the tab manager or a separate component.

### Verification Approach

- `pnpm vitest run` — all existing 375 tests still pass (no regressions)
- New unit tests for server actions (rename, kill, create) — mock `execInWorkspace`, verify correct tmux commands and `SAFE_IDENTIFIER_RE` validation
- `pnpm build` — succeeds with updated terminal page
- Manual verification: open terminal page, create multiple tabs, switch between them, verify each has independent terminal state
- Verify inactive tabs preserve terminal content when switching back
- Verify rename updates tab label and tmux session name
- Verify kill removes the tmux session and closes the tab

## Constraints

- No existing `Tabs` UI component — the codebase uses `@base-ui/react` with custom Tailwind styling, not shadcn. Tab bar must be built from `Button` components with ghost/outline variants.
- `InteractiveTerminal` must stay mounted when inactive (hidden via CSS) — unmounting destroys the xterm.js `Terminal` instance and its WebSocket connection. The `useEffect` cleanup in `InteractiveTerminal.tsx:165-172` calls `term.dispose()` on unmount.
- Session names must pass `SAFE_IDENTIFIER_RE` (`/^[a-zA-Z0-9._-]+$/`) — this is validated at both protocol and proxy layers (defense-in-depth from S02).
- `execInWorkspace` uses `coder ssh` which requires the workspace to be running — session management actions should handle non-running workspaces gracefully.
- Next.js 16 Turbopack requires server/client component split for `ssr: false` dynamic imports — the existing `terminal-client.tsx` wrapper pattern must be preserved.

## Common Pitfalls

- **Unmounting inactive terminals** — If tabs use conditional rendering (`{activeTab === id && <InteractiveTerminal />}`), switching tabs destroys and recreates terminals. Must use CSS visibility/display to hide inactive tabs while keeping them mounted.
- **Tab close without session kill** — Closing a tab should disconnect the WebSocket but NOT kill the tmux session by default (user may want to reconnect later). Kill should be an explicit action. This matches the persistence model from D019.
- **Race condition on rename** — If user renames a session while it's connected, the WebSocket proxy still references the old session name. Rename should only apply to the tmux session name (server-side), and the tab label updates locally. The active WebSocket connection is unaffected because it's already attached to the tmux session by PID, not name.
- **Auto-naming from cwd** — R039 says "auto-named from cwd". This requires executing `tmux display-message -p -t sessionName '#{pane_current_path}'` after session creation to get the cwd, then renaming. Or simpler: create with a default name pattern like `session-1`, `session-2` and let the user rename. The cwd-based naming adds complexity for marginal UX benefit in v1.
