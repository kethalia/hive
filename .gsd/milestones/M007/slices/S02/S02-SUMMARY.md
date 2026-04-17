---
id: S02
parent: M007
milestone: M007
provides:
  - ["sidebar-session-nesting: Workspaces are collapsible with nested terminal sessions and external links", "terminal-keystroke-exclusivity: Terminal page captures all keystrokes with auto-focus and stopPropagation", "sidebar-refresh-event: hive:sidebar-refresh CustomEvent bridge for cross-component data reload", "session-crud-sidebar: Create and kill terminal sessions directly from sidebar"]
requires:
  []
affects:
  []
key_files:
  - (none)
key_decisions:
  - ["Kill button placed outside SidebarMenuSubButton to avoid nested button HTML violation", "StaleEntryAlert extracted as co-located client component from server component page.tsx — required for useEffect-based event dispatch", "CustomEvent on window chosen over React context for sidebar-terminal communication — different component trees"]
patterns_established:
  - ["CustomEvent bridge (hive:sidebar-refresh) for cross-component-tree communication between terminal pages and sidebar — avoids React context coupling across route boundaries", "Negative margin cancellation (-m-6 -mt-14) for full-viewport pages within padded layouts — reusable for any page that needs edge-to-edge rendering", "Lazy agent info fetch with per-workspace state caching — fetch on first expand, cache in component state keyed by ID", "Per-workspace session polling scoped to expanded collapsibles — intervals tracked in ref map, cleared on collapse/unmount"]
observability_surfaces:
  - ["Console logs with [workspaces] prefix for session create/kill/list operations", "hive:sidebar-refresh CustomEvent dispatched on stale entry detection — observable in DevTools Event Listeners", "Inline Alert components for error states (missing agent, session fetch failure) — visible in UI and React DevTools", "Browser DevTools Network tab shows server action calls for session CRUD"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-17T05:25:32.258Z
blocker_discovered: false
---

# S02: Terminal Integration & Session Management

**Terminal sessions nested under each workspace in sidebar with full-viewport terminal page, keystroke exclusivity, session CRUD, and stale entry recovery via custom event bridge.**

## What Happened

## What This Slice Delivered

This slice wired terminal session management into the sidebar navigation and made the terminal page a first-class full-viewport experience with exclusive keystroke capture.

### T01: Sidebar Session Nesting
Transformed each workspace from a flat `SidebarMenuSubItem` into a nested `Collapsible` containing: (1) three external-link icon buttons (Filebrowser, KasmVNC, Code Server) using `buildWorkspaceUrls()` with lazy-fetched agent info, (2) terminal sessions fetched via `getWorkspaceSessionsAction` on first expand with 30s polling for expanded workspaces, (3) a "+" button to create sessions via `createSessionAction` with navigation to the terminal page, and (4) an "x" kill button per session via `killSessionAction`. Agent info is cached per workspace ID to avoid redundant fetches. Error states show inline Alerts with retry. The kill button was placed outside `SidebarMenuSubButton` to avoid nested `<button>` HTML violations. 7 new tests added (15 → 17 total after T03).

### T02: Full-Viewport Terminal with Keystroke Exclusivity
Terminal page now uses `-m-6 -mt-14 h-[100vh] w-[calc(100%+3rem)]` to fully cancel the root layout's `p-6 pt-14` padding. `onKeyDown stopPropagation` on the terminal wrapper prevents keystroke bubbling to sidebar/layout. `term.focus()` is called immediately after `term.open()` for auto-focus on mount. Click-to-refocus handler on the container div ensures clicking anywhere in the terminal area re-focuses xterm. Error and loading states use the same full-viewport sizing.

### T03: Stale Entry Recovery
Created `StaleEntryAlert` client component (extracted from server component `page.tsx`) that dispatches `hive:sidebar-refresh` CustomEvent on mount when a workspace agent is not found. Terminal client also dispatches the event when no session param is present. Sidebar listens for the custom event and calls `fetchAll()` to re-fetch all data. Event listener cleaned up on unmount. 2 new tests verify the event bridge.

### T04: Keystroke Exclusivity Integration Tests
3 integration tests verify: (1) `term.focus()` called after mount, (2) keydown events don't bubble past the `stopPropagation` wrapper, (3) clicking the terminal container re-focuses xterm. Tests follow established `vi.hoisted()` + `vi.mock()` patterns from existing integration tests.

## Verification

## Verification Results

All slice-level checks pass:

| # | Check | Result |
|---|-------|--------|
| 1 | `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` | ✅ 17/17 tests pass |
| 2 | `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` | ✅ 3/3 tests pass |
| 3 | `grep -q 'getWorkspaceSessionsAction' src/components/app-sidebar.tsx` | ✅ present |
| 4 | `grep -q 'buildWorkspaceUrls' src/components/app-sidebar.tsx` | ✅ present |
| 5 | `grep -q 'createSessionAction' src/components/app-sidebar.tsx` | ✅ present |
| 6 | `grep -q 'killSessionAction' src/components/app-sidebar.tsx` | ✅ present |
| 7 | `grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx` | ✅ present |
| 8 | `grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx` | ✅ present |
| 9 | `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/stale-entry-alert.tsx` | ✅ present (co-located client component imported by page.tsx) |
| 10 | `grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx` | ✅ present |
| 11 | `pnpm tsc --noEmit` filtered for terminal errors | ✅ 0 new errors (4 pre-existing in unrelated files) |

## TypeScript Note
4 pre-existing TS errors in `council-queues`, `push-queue`, and `workspace/cleanup.ts` — none in files touched by this slice.

## Requirements Advanced

- R057 — External link buttons (Filebrowser, KasmVNC, Code Server) rendered per workspace using buildWorkspaceUrls() with lazy-fetched agent name
- R058 — Session list/create/kill wired in sidebar — create navigates to terminal, kill removes from list
- R063 — Terminal page fills full viewport via negative margin cancellation, term.focus() on mount, stopPropagation on keydown
- R068 — Stale entry click dispatches hive:sidebar-refresh, sidebar re-fetches, error Alert shown with back link
- R069 — 3 integration tests verify focus-on-mount, keydown non-bubbling, and click-to-refocus

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

The plan's verification check `grep -q 'hive:sidebar-refresh' page.tsx` does not match because the event dispatch was correctly extracted into a co-located `stale-entry-alert.tsx` client component (server components cannot use useEffect/dispatch browser events). The plan's Step 1 actually suggested this extraction. Functionally identical — page.tsx imports and renders StaleEntryAlert which dispatches the event.

## Known Limitations

None.

## Follow-ups

None.

## Files Created/Modified

- `src/components/app-sidebar.tsx` — Nested Collapsible per workspace with sessions, external links, create/kill buttons, session polling, and hive:sidebar-refresh listener
- `src/__tests__/components/app-sidebar.test.tsx` — Extended from 8 to 17 tests covering session nesting, external links, CRUD actions, error states, and custom event bridge
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — Full-viewport sizing with negative margins, stopPropagation on keydown, hive:sidebar-refresh dispatch on missing session
- `src/components/workspaces/InteractiveTerminal.tsx` — Auto-focus term.focus() on mount, click-to-refocus handler on container
- `src/app/workspaces/[id]/terminal/page.tsx` — Renders StaleEntryAlert client component on agent error, full-viewport error sizing
- `src/app/workspaces/[id]/terminal/stale-entry-alert.tsx` — New client component dispatching hive:sidebar-refresh on mount with error Alert and back link
- `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — New integration test with 3 cases: focus-on-mount, keydown non-bubbling, click-to-refocus
