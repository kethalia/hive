---
id: T03
parent: S02
milestone: M007
key_files:
  - src/app/workspaces/[id]/terminal/stale-entry-alert.tsx
  - src/app/workspaces/[id]/terminal/page.tsx
  - src/app/workspaces/[id]/terminal/terminal-client.tsx
  - src/components/app-sidebar.tsx
  - src/__tests__/components/app-sidebar.test.tsx
key_decisions:
  - Extracted StaleEntryAlert into co-located client component rather than keeping inline JSX in server component — required for useEffect dispatch
  - Used CustomEvent on window rather than React context for cross-component communication — sidebar and terminal page are in different component trees
duration: 
verification_result: passed
completed_at: 2026-04-17T05:21:57.599Z
blocker_discovered: false
---

# T03: Add stale entry error handling with hive:sidebar-refresh custom event for automatic sidebar data reload

**Add stale entry error handling with hive:sidebar-refresh custom event for automatic sidebar data reload**

## What Happened

Implemented the stale entry recovery flow across three components:

1. **StaleEntryAlert client component** (`stale-entry-alert.tsx`): Extracted error UI from the server component `page.tsx` into a new client component that dispatches `hive:sidebar-refresh` via `useEffect` on mount. Includes a "Back to home" link to `/tasks`. The server component `page.tsx` now renders `<StaleEntryAlert>` instead of inline JSX when no agent is found.

2. **Terminal client missing-session dispatch** (`terminal-client.tsx`): Added a `useEffect` in `TerminalInner` that dispatches `hive:sidebar-refresh` when the `session` search param is absent, covering the case where a stale sidebar link has no session parameter.

3. **Sidebar event listener** (`app-sidebar.tsx`): Added a `useEffect` that listens for the `hive:sidebar-refresh` custom event on `window` and calls `fetchAll()` to re-fetch workspaces and templates. The listener is cleaned up on unmount.

4. **Tests**: Added two new tests — one verifying the custom event triggers `fetchAll`, another verifying the listener is cleaned up on unmount. All 17 tests pass.

## Verification

- grep confirms `hive:sidebar-refresh` in `stale-entry-alert.tsx`, `terminal-client.tsx`, and `app-sidebar.tsx`
- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — 17/17 tests pass including 2 new custom event tests
- page.tsx grep for literal string fails as expected since event dispatch moved to co-located stale-entry-alert.tsx (imported by page.tsx)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/stale-entry-alert.tsx` | 0 | pass | 50ms |
| 2 | `grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx` | 0 | pass | 50ms |
| 3 | `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/terminal-client.tsx` | 0 | pass | 50ms |
| 4 | `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` | 0 | pass | 1420ms |

## Deviations

Plan verification check `grep -q 'hive:sidebar-refresh' page.tsx` no longer matches because the event dispatch moved to the co-located `stale-entry-alert.tsx` client component (which page.tsx imports). The behavior is identical — just split across files as the plan's Step 1 suggested.

## Known Issues

None

## Files Created/Modified

- `src/app/workspaces/[id]/terminal/stale-entry-alert.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/components/app-sidebar.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`
