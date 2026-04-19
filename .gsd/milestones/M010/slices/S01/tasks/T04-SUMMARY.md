---
id: T04
parent: S01
milestone: M010
key_files:
  - src/app/login/page.tsx
  - src/app/login/layout.tsx
  - src/app/(dashboard)/layout.tsx
  - src/app/(dashboard)/page.tsx
  - src/app/layout.tsx
  - src/components/app-sidebar.tsx
key_decisions:
  - AppSidebar fetches session via getSessionAction on mount rather than receiving coderUrl as prop — decouples sidebar from env vars and enables per-user Coder URL display
  - Login page uses useAction onError callback to extract serverError messages for display — keeps error handling within the safe-action pipeline
duration: 
verification_result: passed
completed_at: 2026-04-18T19:55:59.530Z
blocker_discovered: false
---

# T04: Build login page UI with error display, restructure app routes into (dashboard) group with sidebar, and add session indicator with logout to sidebar footer

**Build login page UI with error display, restructure app routes into (dashboard) group with sidebar, and add session indicator with logout to sidebar footer**

## What Happened

Created the login page at `src/app/login/page.tsx` as a client component with three controlled inputs (Coder URL, email, password), loading state via `isPending` from `useAction`, and error display using shadcn Alert. The `loginAction` is invoked through next-safe-action's `useAction` hook with `onSuccess` redirecting to `/` and `onError` extracting `serverError` for display.

Created a minimal login layout at `src/app/login/layout.tsx` that centers the form vertically and horizontally with Hive branding (Hexagon icon + title).

Restructured the app routing by creating `src/app/(dashboard)/layout.tsx` which contains the SidebarProvider, AppSidebar, SidebarTrigger, and SidebarInset that were previously in the root layout. Moved `tasks/`, `templates/`, `workspaces/`, and `page.tsx` into the `(dashboard)` route group so the sidebar only renders for authenticated routes.

Simplified `src/app/layout.tsx` to contain only HTML structure, fonts, and TooltipProvider — no sidebar rendering.

Updated `src/components/app-sidebar.tsx` to remove the `coderUrl` prop. The sidebar now fetches session data via `getSessionAction` on mount and derives `coderUrl` from the session. Added a session indicator in the sidebar footer showing the user's email and connected Coder URL, with a logout button that calls `logoutAction` and redirects to `/login`.

Updated three test files to fix import paths after route group restructure, and updated the sidebar test to mock auth actions and remove the removed `coderUrl` prop.

## Verification

All 4 task plan verification checks pass:
- `test -f src/app/login/page.tsx` — login page exists
- `test -f src/app/(dashboard)/layout.tsx` — dashboard layout exists
- `! grep -q 'AppSidebar' src/app/layout.tsx` — sidebar removed from root layout
- `grep -q 'AppSidebar' src/app/(dashboard)/layout.tsx` — sidebar in dashboard layout
- `grep -q 'logoutAction' src/components/app-sidebar.tsx` — logout wired in sidebar

TypeScript type-check passes for all changed files (remaining errors are pre-existing from prior tasks).

All 17 sidebar tests pass. All 51 task-related tests pass after import path fixes.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f src/app/login/page.tsx && test -f 'src/app/(dashboard)/layout.tsx' && ! grep -q 'AppSidebar' src/app/layout.tsx && grep -q 'AppSidebar' 'src/app/(dashboard)/layout.tsx' && grep -q 'logoutAction' src/components/app-sidebar.tsx` | 0 | ✅ pass | 50ms |
| 2 | `npx vitest run src/__tests__/components/app-sidebar.test.tsx` | 0 | ✅ pass — 17 tests passed | 1880ms |
| 3 | `npx vitest run src/__tests__/app/tasks/` | 0 | ✅ pass — 51 tests passed | 933ms |
| 4 | `npx tsc --noEmit (filtered to changed files)` | 0 | ✅ pass — no new type errors from this task | 15000ms |

## Deviations

Updated three test files (council-result-card, agent-stream-panel, task-detail-results) to fix import paths after route group restructure — these were not in the task plan but were necessary to maintain test integrity.

## Known Issues

None

## Files Created/Modified

- `src/app/login/page.tsx`
- `src/app/login/layout.tsx`
- `src/app/(dashboard)/layout.tsx`
- `src/app/(dashboard)/page.tsx`
- `src/app/layout.tsx`
- `src/components/app-sidebar.tsx`
