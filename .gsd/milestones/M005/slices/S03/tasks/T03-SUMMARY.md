---
id: T03
parent: S03
milestone: M005
key_files:
  - src/components/workspaces/TerminalTabManager.tsx
  - src/__tests__/components/terminal-tab-manager.test.tsx
  - vitest.config.ts
key_decisions:
  - Session picker uses dropdown from + button rather than a separate panel — simpler UX, fewer components
  - Kill action uses Trash2 icon distinct from X close button to clearly differentiate 'destroy session' from 'disconnect tab'
  - Vitest config updated to include .tsx test files for component testing with jsdom environment
duration: 
verification_result: passed
completed_at: 2026-04-14T11:32:53.275Z
blocker_discovered: false
---

# T03: Add inline tab rename, kill session action, and session picker dropdown to TerminalTabManager

**Add inline tab rename, kill session action, and session picker dropdown to TerminalTabManager**

## What Happened

Extended TerminalTabManager with three features:

**Rename:** Double-clicking a tab label enters inline edit mode — the session name becomes an input field. On Enter or blur, `renameSessionAction` is called server-side and local tab state updates. Client-side validation against `SAFE_IDENTIFIER_RE` prevents invalid names from reaching the server. Escape cancels the rename. The active WebSocket connection is unaffected since tmux attaches by PID, not name.

**Kill:** Each tab has a trash icon (Trash2) that calls `killSessionAction` to destroy the tmux session, then removes the tab. If the killed tab was active, the nearest remaining tab becomes active. When all tabs are killed, an empty state with "Create New Session" button is shown. The existing close button (X) remains separate — it only disconnects the WebSocket without killing the tmux session.

**Session picker:** The "+" button now opens a dropdown that fetches available sessions via `getWorkspaceSessionsAction` and filters out sessions already open in tabs. Clicking an unopened session opens it as a new tab. A "Create New" option is always present at the bottom. Click-outside closes the picker.

Updated vitest config to include `.tsx` test files alongside `.ts` files.

## Verification

Ran component tests (8 pass), full test suite (397 tests across 50 files pass), and production build succeeds.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/terminal-tab-manager.test.tsx` | 0 | ✅ pass | 651ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 2560ms |
| 3 | `pnpm build` | 0 | ✅ pass | 2200ms |

## Deviations

The + button behavior changed from directly creating a session to opening a session picker dropdown. Creating a new session is now done via the 'Create New' option inside the picker. This is a better UX since it exposes existing sessions before creating new ones.

## Known Issues

none

## Files Created/Modified

- `src/components/workspaces/TerminalTabManager.tsx`
- `src/__tests__/components/terminal-tab-manager.test.tsx`
- `vitest.config.ts`
