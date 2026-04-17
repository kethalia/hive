---
id: S01
parent: M007
milestone: M007
provides:
  - ["collapsible-sidebar-sections", "floating-sidebar-trigger", "listTemplateStatusesAction", "sidebar-polling-infrastructure", "sidebar-error-retry-pattern"]
requires:
  []
affects:
  []
key_files:
  - ["src/app/layout.tsx", "src/components/app-sidebar.tsx", "src/lib/actions/templates.ts", "src/__tests__/components/app-sidebar.test.tsx"]
key_decisions:
  - ["D029: Header/breadcrumbs removed globally, replaced with floating SidebarTrigger", "D027: shadcn SidebarMenuSub/Collapsible primitives for tree structure", "Per-section independent error/loading state so one section failing doesn't block the other", "useRef for interval ID to prevent polling stacking on re-renders from usePathname()"]
patterns_established:
  - ["Collapsible sidebar section pattern: Collapsible + CollapsibleTrigger + CollapsibleContent wrapping SidebarMenuSub — reusable for S02 terminal sessions", "Server action wrapper pattern: listTemplateStatusesAction mirrors listWorkspacesAction for consistent data fetching", "Per-section independent state management for sidebar data (data/isLoading/error per section)", "Component test mock pattern for sidebar: vi.mock for shadcn UI components, next/navigation, and server actions"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-17T05:07:36.636Z
blocker_discovered: false
---

# S01: Sidebar Tree Structure & Layout Overhaul

**Replaced flat sidebar nav with collapsible Workspaces/Templates tree sections fed by live Coder API data, removed header/breadcrumbs globally, added floating sidebar trigger, footer timestamp/refresh, and inline error states with retry.**

## What Happened

## T01: Header removal and floating sidebar trigger

Removed the `<header>` block from `src/app/layout.tsx` containing SidebarTrigger, Separator, and HeaderContent. Deleted `src/components/HeaderContent.tsx` entirely (breadcrumb component). Repositioned `SidebarTrigger` as a fixed floating button (`fixed top-3 left-3 z-50`) placed as a sibling after `AppSidebar` but before `SidebarInset`, keeping it inside `SidebarProvider` for toggle functionality. Added `pt-14` to `<main>` to prevent content from sitting under the floating trigger.

## T02: Collapsible tree sections with live data and 30s polling

Created `src/lib/actions/templates.ts` with `listTemplateStatusesAction` server action wrapping `compareTemplates(KNOWN_TEMPLATES)` using the same `actionClient` pattern as `listWorkspacesAction`.

Rewrote `src/components/app-sidebar.tsx` to replace the flat `navItems` array with three distinct groups:
1. **Navigation** — Tasks, New Task, Dashboard (external link) as flat items
2. **Workspaces** — Collapsible section with `SidebarMenuSub`/`SidebarMenuSubItem` per workspace showing name and build status via Badge. Default open.
3. **Templates** — Same collapsible pattern showing template name and stale/fresh status via Badge. Default open.

Data fetching uses per-section independent `useState` for data, isLoading, and error. `useEffect` triggers initial fetch on mount. `setInterval` at 30s polls both sections with `useRef` for interval ID to prevent stacking on re-renders from `usePathname()`. Shared `lastRefreshed` timestamp updates on any successful fetch.

## T03: Footer, error states, and test suite

Footer replaced the disabled Settings button with a formatted last-refreshed timestamp and a RefreshCw button (spin animation while loading) that triggers immediate re-fetch of both sections. Inline `Alert` (variant destructive) with retry button renders inside `CollapsibleContent` when a section fetch fails.

Created `src/__tests__/components/app-sidebar.test.tsx` with 8 tests: workspace/template name rendering, error alert with retry for both sections, retry recovery, refresh button presence, timestamp display, and refresh triggering both actions. Uses `vi.useFakeTimers` for polling interval handling.

## Verification

## Verification Results

### Slice-level checks
- **No `<header>` in layout.tsx**: `grep -c '<header' src/app/layout.tsx` → 0 ✅
- **HeaderContent.tsx deleted**: `! test -f src/components/HeaderContent.tsx` ✅
- **Templates action exists**: `grep -q 'listTemplateStatusesAction' src/lib/actions/templates.ts` ✅
- **Collapsible sections**: `grep -q 'Collapsible' src/components/app-sidebar.tsx` ✅
- **30s polling**: `grep -q 'setInterval' src/components/app-sidebar.tsx` ✅
- **Alert error states**: `grep -q 'Alert' src/components/app-sidebar.tsx` ✅
- **Refresh button**: `grep -q 'RefreshCw' src/components/app-sidebar.tsx` ✅

### Test suite
- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — **8/8 tests pass** ✅

### TypeScript
- `pnpm tsc --noEmit` — 20 pre-existing errors in `council-queues.ts`, `task-queue.ts`, and unrelated test files (ioredis version mismatch). **Zero errors in any S01 file.**

### Full test suite
- `pnpm test` — 437 passed, 2 failed. The 2 failures are pre-existing ResizeObserver tests from M006 (`terminal-tab-refit.test.tsx`, `interactive-terminal-integration.test.tsx`). No regressions from S01.

## Requirements Advanced

None.

## Requirements Validated

- R056 — Sidebar renders collapsible Workspaces and Templates sections with SidebarMenuSub tree structure, verified by 8 passing tests and grep checks
- R059 — listWorkspacesAction and listTemplateStatusesAction called on mount and every 30s via setInterval, verified by grep for setInterval and test coverage
- R060 — Footer shows lastRefreshed timestamp and RefreshCw button, verified by test and grep
- R062 — No <header> tag in layout.tsx, HeaderContent.tsx deleted, floating SidebarTrigger is only chrome — verified by grep and file existence check
- R067 — Inline Alert with retry button per section on fetch failure, verified by 3 error-state tests passing

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

Pre-existing TypeScript errors (20) in council-queues.ts and task-queue.ts due to ioredis version mismatch — unrelated to S01. Pre-existing test failures (2) in terminal ResizeObserver tests from M006 — unrelated to S01.

## Follow-ups

S02 will add terminal sessions as nested items under each workspace in the sidebar, reusing the collapsible section pattern established here. S03 will add template detail page navigation and sidebar pin/unpin toggle.

## Files Created/Modified

- `src/app/layout.tsx` — Removed header block, deleted HeaderContent/Separator imports, repositioned SidebarTrigger as fixed floating button
- `src/components/HeaderContent.tsx` — Deleted — breadcrumb component removed per D029/R062
- `src/components/app-sidebar.tsx` — Replaced flat nav with collapsible Workspaces/Templates tree, added polling, error states, footer timestamp/refresh
- `src/lib/actions/templates.ts` — New server action listTemplateStatusesAction wrapping compareTemplates
- `src/__tests__/components/app-sidebar.test.tsx` — New test suite with 8 tests covering collapsible sections, error states, retry, refresh
