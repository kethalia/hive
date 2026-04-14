---
id: T02
parent: S03
milestone: M005
key_files:
  - src/components/workspaces/TerminalTabManager.tsx
  - src/app/workspaces/[id]/terminal/terminal-client.tsx
  - src/app/workspaces/[id]/terminal/page.tsx
key_decisions:
  - Inactive terminals use display:none (not conditional rendering) to preserve xterm.js instances and WebSocket connections
  - Tab initialization priority: initialSessionName from URL > first session from initialSessions > fallback 'hive-main'
  - Close button hidden when only one tab remains to prevent user from closing all terminals
duration: 
verification_result: passed
completed_at: 2026-04-14T11:29:14.435Z
blocker_discovered: false
---

# T02: Build TerminalTabManager component with multi-tab terminal support, CSS-hidden inactive terminals, and session fetching on page load

**Build TerminalTabManager component with multi-tab terminal support, CSS-hidden inactive terminals, and session fetching on page load**

## What Happened

Created `TerminalTabManager.tsx` — a client component that manages multiple terminal tabs with create/close/switch functionality. Key implementation details:

- Tab state managed as `Array<{ id: string, sessionName: string }>` with `activeTabId` tracking the active tab.
- Tab bar renders Button components: `outline` variant for active tab, `ghost` for inactive. Each tab shows session name and an X close button (hidden when only one tab remains).
- "+" button calls `createSessionAction` from T01 to create a new tmux session, then adds a tab for it.
- **CRITICAL**: Inactive terminals hidden via `style={{ display: 'none' }}` — NOT conditional rendering. This preserves xterm.js Terminal instances and WebSocket connections (InteractiveTerminal cleanup on unmount calls `term.dispose()`).
- InteractiveTerminal is dynamically imported with `ssr: false` (same pattern as before).
- Console logging on tab create/close/switch events for runtime observability.

Updated `terminal-client.tsx` to render TerminalTabManager instead of single InteractiveTerminal, passing through `workspaceId`, `initialSessions`, and `initialSessionName`.

Updated `page.tsx` to call `getWorkspaceSessionsAction` alongside `getWorkspaceAgentAction` using `Promise.all` for parallel fetching. Sessions list passed to client component. The `session` query param flows through as `initialSessionName`.

## Verification

Build passes, TerminalTabManager referenced in terminal-client.tsx, getWorkspaceSessionsAction referenced in page.tsx

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm build` | 0 | ✅ pass | 2300ms |
| 2 | `grep -q 'TerminalTabManager' src/app/workspaces/[id]/terminal/terminal-client.tsx` | 0 | ✅ pass | 10ms |
| 3 | `grep -q 'getWorkspaceSessionsAction' src/app/workspaces/[id]/terminal/page.tsx` | 0 | ✅ pass | 10ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/components/workspaces/TerminalTabManager.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
