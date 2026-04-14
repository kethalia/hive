# S03: Multi-Tab Terminal & Session Management

**Goal:** Users can open multiple terminal tabs simultaneously, each connected to a distinct tmux session, and manage session lifecycle (create, rename, kill) from the dashboard UI.
**Demo:** User has multiple terminal tabs open simultaneously across workspaces, creates sessions auto-named from cwd, renames them, kills unused ones

## Must-Haves

- `pnpm vitest run` — all existing tests pass plus new server action tests
- `pnpm build` — succeeds with updated terminal page
- New test file `src/__tests__/lib/actions/session-actions.test.ts` passes with tests covering create, rename, kill actions including SAFE_IDENTIFIER_RE validation and error handling
- Tab manager renders multiple InteractiveTerminal instances, each with independent WebSocket connections
- Inactive tabs stay mounted (CSS hidden) — switching back preserves terminal state
- Session picker shows existing tmux sessions for quick connection
- Rename and kill controls work through the server actions

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (E2E needs live Coder workspace, but unit tests cover action logic)
- Human/UAT required: yes (multi-tab terminal UX needs manual verification)

## Integration Closure

- Upstream surfaces consumed: `InteractiveTerminal` component (unchanged), `useTerminalWebSocket` hook (unchanged), `execInWorkspace` utility, `getWorkspaceSessionsAction`, `SAFE_IDENTIFIER_RE`, WebSocket proxy at `/api/terminal/ws`
- New wiring introduced: TerminalTabManager composes multiple InteractiveTerminal instances; page.tsx fetches session list on load; three new server actions for tmux lifecycle
- What remains before milestone is truly usable end-to-end: S04+ slices (workspace detail page, filebrowser/VNC embedding per roadmap)

## Verification

- Runtime signals: Browser console logs tab create/close/switch events; server actions log tmux command execution via execInWorkspace
- Inspection surfaces: Tab bar UI shows active sessions; session picker shows all available tmux sessions
- Failure visibility: Server action errors surface in UI via toast/alert; connection state badge per tab shows individual terminal health
- Redaction constraints: none (no secrets handled beyond existing CODER_SESSION_TOKEN which stays server-side)

## Tasks

- [x] **T01: Add tmux session create, rename, and kill server actions with unit tests** `est:30m`
  Add three new server actions to `src/lib/actions/workspaces.ts` following the existing `getWorkspaceSessionsAction` pattern: `createSessionAction` (creates a new tmux session with optional name, validates against SAFE_IDENTIFIER_RE, defaults to auto-generated name like `session-1`), `renameSessionAction` (renames existing tmux session via `tmux rename-session -t oldName newName`, validates both names), and `killSessionAction` (kills tmux session via `tmux kill-session -t name`). All three use `execInWorkspace` with the same zod-validated input pattern. Write unit tests in `src/__tests__/lib/actions/session-actions.test.ts` mocking `execInWorkspace` to verify correct tmux commands, SAFE_IDENTIFIER_RE validation rejection, and error handling for missing agents.

Context from S02: `execInWorkspace(agentTarget, command)` executes commands via `coder ssh`. `getWorkspaceSessionsAction` at line ~50 of workspaces.ts is the pattern to follow — zod schema for input, resolve agent via `getWorkspaceAgentAction`, call `execInWorkspace`, return parsed result. `SAFE_IDENTIFIER_RE` is imported from `src/lib/constants.ts` and must validate all session names.

R039 requires create (auto-named), rename, and kill from the dashboard. Auto-naming from cwd is deferred to a simple counter pattern (`session-1`, `session-2`) per research recommendation — cwd-based naming adds complexity for marginal UX benefit in v1.
  - Files: `src/lib/actions/workspaces.ts`, `src/__tests__/lib/actions/session-actions.test.ts`
  - Verify: pnpm vitest run src/__tests__/lib/actions/session-actions.test.ts && pnpm vitest run

- [x] **T02: Build TerminalTabManager component with multi-tab terminal support** `est:1h`
  Create `src/components/workspaces/TerminalTabManager.tsx` — a client component that manages multiple terminal tabs. Replace the single-terminal rendering in `terminal-client.tsx` with this tab manager. Update `page.tsx` to fetch existing tmux sessions and pass them to the client.

The tab manager maintains state: `tabs: Array<{ id: string, sessionName: string }>` and `activeTabId: string`. It renders a horizontal tab bar using Button components (ghost variant for inactive, outline for active — no Tabs component exists in the UI library per research). Each tab shows the session name and an X close button. A "+" button at the end creates a new tab by calling `createSessionAction` from T01.

CRITICAL: Inactive terminals must be hidden via `style={{ display: 'none' }}`, NOT via conditional rendering. Unmounting destroys the xterm.js Terminal instance and WebSocket connection (cleanup in InteractiveTerminal.tsx lines 165-172 calls term.dispose()). All InteractiveTerminal instances stay mounted — only visibility changes.

The tab manager receives `agentId`, `coderUrl`, and `initialSessions: TmuxSession[]` as props. On mount, if `initialSessionName` is provided (from URL query param), it opens that session as the first tab. The "+" button calls `createSessionAction` to create a new tmux session, then adds a tab for it.

Update `page.tsx` to call `getWorkspaceSessionsAction` alongside `getWorkspaceAgentAction` so existing sessions are available on page load. Pass the sessions list to terminal-client.tsx which forwards to TerminalTabManager.

This task delivers R038 (multiple terminal tabs open simultaneously).
  - Files: `src/components/workspaces/TerminalTabManager.tsx`, `src/app/workspaces/[id]/terminal/terminal-client.tsx`, `src/app/workspaces/[id]/terminal/page.tsx`
  - Verify: pnpm build && grep -q 'TerminalTabManager' src/app/workspaces/\[id\]/terminal/terminal-client.tsx && grep -q 'getWorkspaceSessionsAction' src/app/workspaces/\[id\]/terminal/page.tsx

- [ ] **T03: Add session rename, kill controls, and session picker to tab manager** `est:1h`
  Extend the TerminalTabManager from T02 with session lifecycle management UI (R039) and a session picker for connecting to existing sessions.

**Rename:** Double-click on a tab label enters inline edit mode — the tab name becomes an input field. On Enter or blur, call `renameSessionAction` from T01 to rename the tmux session server-side, then update local tab state. Validate against SAFE_IDENTIFIER_RE client-side before calling the action. On Escape, cancel the rename. Important: renaming only changes the tmux session name and tab label — the active WebSocket connection is unaffected because it's already attached to the tmux session by PID, not name (per research pitfalls).

**Kill:** Add a kill button (or right-click context option) that calls `killSessionAction` from T01 to destroy the tmux session, then removes the tab. If the killed tab was active, switch to the nearest remaining tab. If no tabs remain, show an empty state with a "Create New Session" button. Closing a tab (X button from T02) should only disconnect the WebSocket without killing the tmux session — kill is a separate explicit action.

**Session picker:** Add a dropdown or panel (triggered from the "+" button area) that lists existing tmux sessions not already open in a tab. Fetches via `getWorkspaceSessionsAction`. Clicking a session in the picker opens it as a new tab. If all sessions are already open, show a "Create New" option only.

Write tests in `src/__tests__/components/terminal-tab-manager.test.tsx` covering: tab rename triggers renameSessionAction, kill removes tab and calls killSessionAction, session picker filters already-open sessions.
  - Files: `src/components/workspaces/TerminalTabManager.tsx`, `src/__tests__/components/terminal-tab-manager.test.tsx`
  - Verify: pnpm vitest run src/__tests__/components/terminal-tab-manager.test.tsx && pnpm vitest run && pnpm build

## Files Likely Touched

- src/lib/actions/workspaces.ts
- src/__tests__/lib/actions/session-actions.test.ts
- src/components/workspaces/TerminalTabManager.tsx
- src/app/workspaces/[id]/terminal/terminal-client.tsx
- src/app/workspaces/[id]/terminal/page.tsx
- src/__tests__/components/terminal-tab-manager.test.tsx
