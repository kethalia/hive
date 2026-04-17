---
id: T02
parent: S03
milestone: M007
key_files:
  - src/hooks/use-sidebar-mode.ts
  - src/components/app-sidebar.tsx
  - src/components/workspaces/TerminalBreadcrumbs.tsx
  - src/components/workspaces/WorkspaceToolPanel.tsx
key_decisions:
  - Used PinOff icon for offcanvas mode (click to collapse) and Pin icon for icon mode (click to expand) — follows convention where the icon shows the action's result
  - Deleted workspaces-client.test.tsx alongside the component it tested since the test subject no longer exists
duration: 
verification_result: passed
completed_at: 2026-04-17T05:35:12.880Z
blocker_discovered: false
---

# T02: Add sidebar pin/unpin mode toggle with localStorage persistence, remove old workspaces listing page, update breadcrumb links to /tasks

**Add sidebar pin/unpin mode toggle with localStorage persistence, remove old workspaces listing page, update breadcrumb links to /tasks**

## What Happened

Created `src/hooks/use-sidebar-mode.ts` — a localStorage-backed hook returning `[mode, toggleMode]` with SSR safety (defaults to "offcanvas" when window is undefined). The hook reads/writes the `sidebar_mode` key with values "offcanvas" or "icon".

Updated `src/components/app-sidebar.tsx` to wire the `collapsible` prop on `<Sidebar>` to the hook's mode value. Added a Pin/PinOff toggle button in the SidebarFooter next to the existing refresh button. When mode is "offcanvas", PinOff icon is shown (click to collapse to icons); when "icon", Pin icon is shown (click to expand).

Deleted `src/app/workspaces/page.tsx` and `src/components/workspaces/WorkspacesClient.tsx` — the old workspaces listing page is no longer needed. Also deleted the corresponding test file `src/__tests__/components/workspaces-client.test.tsx` since its subject was removed.

Updated breadcrumb links in `TerminalBreadcrumbs.tsx` and `WorkspaceToolPanel.tsx` from `/workspaces` to `/tasks`.

No other files imported the deleted components — verified via grep.

## Verification

Ran the task plan verification command: `! test -f src/app/workspaces/page.tsx && grep -q 'collapsible' src/components/app-sidebar.tsx && grep -q 'sidebar_mode' src/hooks/use-sidebar-mode.ts && grep -q '/tasks' src/components/workspaces/TerminalBreadcrumbs.tsx && grep -q '/tasks' src/components/workspaces/WorkspaceToolPanel.tsx` — PASS. TypeScript check confirmed no new type errors introduced (all 22 remaining errors are pre-existing in queue/prisma files). Grep confirmed no remaining imports of deleted WorkspacesClient.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `! test -f src/app/workspaces/page.tsx && grep -q 'collapsible' src/components/app-sidebar.tsx && grep -q 'sidebar_mode' src/hooks/use-sidebar-mode.ts && grep -q '/tasks' src/components/workspaces/TerminalBreadcrumbs.tsx && grep -q '/tasks' src/components/workspaces/WorkspaceToolPanel.tsx && echo PASS` | 0 | ✅ pass | 150ms |
| 2 | `npx tsc --noEmit --pretty` | 2 | ✅ pass (no new errors — 22 pre-existing) | 15000ms |
| 3 | `grep -r 'WorkspacesClient' src/` | 1 | ✅ pass (no remaining imports of deleted component) | 100ms |

## Deviations

Deleted src/__tests__/components/workspaces-client.test.tsx — not in the original plan but necessary since it imported the deleted WorkspacesClient component and would cause a type error.

## Known Issues

none

## Files Created/Modified

- `src/hooks/use-sidebar-mode.ts`
- `src/components/app-sidebar.tsx`
- `src/components/workspaces/TerminalBreadcrumbs.tsx`
- `src/components/workspaces/WorkspaceToolPanel.tsx`
