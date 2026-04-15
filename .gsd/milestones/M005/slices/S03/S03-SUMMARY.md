---
id: S03
parent: M005
milestone: M005
provides:
  - ["multi-tab-terminal-ui", "session-lifecycle-actions", "session-picker"]
requires:
  []
affects:
  []
key_files:
  - ["src/lib/actions/workspaces.ts", "src/components/workspaces/TerminalTabManager.tsx", "src/app/workspaces/[id]/terminal/terminal-client.tsx", "src/app/workspaces/[id]/terminal/page.tsx", "src/__tests__/lib/actions/session-actions.test.ts", "src/__tests__/components/terminal-tab-manager.test.tsx"]
key_decisions:
  - ["Inactive terminals hidden via display:none (not conditional rendering) to preserve xterm.js instances and WebSocket connections", "Auto-naming uses session-<Date.now()> — collision-free without state tracking, simpler than counter or cwd-based naming", "Close (X) disconnects WebSocket only; Kill is a separate explicit action that destroys the tmux session server-side"]
patterns_established:
  - ["TerminalTabManager pattern: compose multiple InteractiveTerminal instances with CSS visibility toggle for tab switching", "Session lifecycle server actions follow getWorkspaceSessionsAction pattern: zod schema → agent resolution → execInWorkspace → parsed result", "Inline rename UX: double-click to edit, Enter/blur to commit, Escape to cancel, client-side validation before server action"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-14T11:34:43.091Z
blocker_discovered: false
---

# S03: Multi-Tab Terminal & Session Management

**Users can open multiple terminal tabs simultaneously, each connected to a distinct tmux session, with full session lifecycle management (create, rename, kill) and a session picker for reconnecting to existing sessions.**

## What Happened

## What Was Built

Three tasks delivered the complete multi-tab terminal experience with session lifecycle management:

**T01 — Server Actions (14 tests)**
Added `createSessionAction`, `renameSessionAction`, and `killSessionAction` to `src/lib/actions/workspaces.ts`, following the established `getWorkspaceSessionsAction` pattern. Each action validates session names against `SAFE_IDENTIFIER_RE`, resolves the workspace agent via `client.getWorkspaceAgentName()`, and executes tmux commands via `execInWorkspace()`. Auto-naming uses `session-<Date.now()>` (timestamp-based, collision-free without state tracking). 14 unit tests cover happy paths, validation rejection, command failures, and missing agent errors.

**T02 — TerminalTabManager Component (build verified)**
Created `src/components/workspaces/TerminalTabManager.tsx` — a client component managing multiple terminal tabs with state `tabs: Array<{id, sessionName}>` and `activeTabId`. Critical design: inactive terminals are hidden via `style={{ display: 'none' }}` rather than conditional rendering, preserving xterm.js Terminal instances and WebSocket connections across tab switches. Tab bar uses Button components (ghost/outline variants). The "+" button creates new sessions via `createSessionAction`. Updated `page.tsx` to fetch existing tmux sessions on load and `terminal-client.tsx` to wire the tab manager. Tab initialization follows priority: URL `initialSessionName` > first session from `initialSessions` > fallback `hive-main`.

**T03 — Rename, Kill, and Session Picker (8 tests)**
Extended TerminalTabManager with inline rename (double-click tab label → input field, Enter/blur commits via `renameSessionAction`, Escape cancels, client-side SAFE_IDENTIFIER_RE validation), explicit kill (separate from close — kill destroys the tmux session server-side, close only disconnects the WebSocket), and a session picker dropdown that lists existing tmux sessions not already open in a tab. Empty state with "Create New Session" button when all tabs are killed. 8 component tests verify rename triggers, kill behavior, and session picker filtering.

## Integration Points

- **Upstream consumed:** `InteractiveTerminal` component (unchanged), `useTerminalWebSocket` hook (unchanged), `execInWorkspace` utility, `getWorkspaceSessionsAction`, `SAFE_IDENTIFIER_RE`, WebSocket proxy at `/api/terminal/ws`
- **New wiring:** TerminalTabManager composes multiple InteractiveTerminal instances; page.tsx fetches session list on load; three new server actions for tmux lifecycle
- **Close vs Kill distinction:** Close (X button) disconnects WebSocket only — tmux session persists for later reconnection. Kill is an explicit destructive action that destroys the tmux session server-side.

## Verification

## Verification Results

All slice plan must-haves confirmed:

| Check | Result |
|-------|--------|
| `pnpm vitest run src/__tests__/lib/actions/session-actions.test.ts` | ✅ 14/14 passed (200ms) |
| `pnpm vitest run src/__tests__/components/terminal-tab-manager.test.tsx` | ✅ 8/8 passed (674ms) |
| `pnpm vitest run` (full suite) | ✅ 397/397 passed, 50 files (2.52s) |
| `pnpm build` | ✅ success, all routes compiled |
| TerminalTabManager wired in terminal-client.tsx | ✅ confirmed via grep |
| getWorkspaceSessionsAction called in page.tsx | ✅ confirmed via grep |
| Inactive tabs use CSS hidden (not conditional render) | ✅ display:none pattern in TerminalTabManager |
| Session picker shows existing sessions | ✅ tested in component tests |
| Rename and kill work through server actions | ✅ tested in both action and component tests |

No regressions — test count grew from 375 (S02) to 397 (S03), net +22 tests.

## Requirements Advanced

- R038 — TerminalTabManager renders multiple InteractiveTerminal instances simultaneously, each with independent WebSocket connections to distinct tmux sessions. Inactive tabs hidden via display:none to preserve state.
- R039 — Three server actions (create, rename, kill) with SAFE_IDENTIFIER_RE validation. UI: inline tab rename on double-click, explicit kill button, session picker for existing sessions. Auto-naming via timestamp.

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Auto-naming uses `session-<Date.now()>` instead of the plan's `session-1` counter pattern. A counter would require querying existing sessions to determine the next number, adding complexity and a race condition. Timestamp is simpler and collision-free.

## Known Limitations

None.

## Follow-ups

S04 (External Tool Integration) remains — embedded Filebrowser/KasmVNC iframes in workspace detail page. UAT requires manual verification of multi-tab UX with live Coder workspaces.

## Files Created/Modified

- `src/lib/actions/workspaces.ts` — Added createSessionAction, renameSessionAction, killSessionAction server actions
- `src/__tests__/lib/actions/session-actions.test.ts` — 14 unit tests for session lifecycle actions
- `src/components/workspaces/TerminalTabManager.tsx` — Multi-tab terminal manager with rename, kill, and session picker
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — Updated to use TerminalTabManager instead of single terminal
- `src/app/workspaces/[id]/terminal/page.tsx` — Added session list fetch on page load
- `src/__tests__/components/terminal-tab-manager.test.tsx` — 8 component tests for tab management UI
