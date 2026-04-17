---
id: T02
parent: S01
milestone: M007
key_files:
  - src/components/app-sidebar.tsx
  - src/lib/actions/templates.ts
key_decisions:
  - Used defaultOpen + onOpenChange with useState for Collapsible sections to track open state for chevron rotation
  - Per-section independent error/loading state rather than a single shared state, so one section failing doesn't block the other
  - useRef for interval ID to prevent stacking on re-renders from usePathname()
duration: 
verification_result: passed
completed_at: 2026-04-17T05:03:30.953Z
blocker_discovered: false
---

# T02: Replace flat nav with collapsible Workspaces and Templates tree sections with live Coder API data and 30s polling

**Replace flat nav with collapsible Workspaces and Templates tree sections with live Coder API data and 30s polling**

## What Happened

Created `src/lib/actions/templates.ts` with `listTemplateStatusesAction` server action wrapping `compareTemplates(KNOWN_TEMPLATES)` using the same `actionClient` pattern as `listWorkspacesAction`.

Rewrote `src/components/app-sidebar.tsx` to replace the flat `navItems` array with three distinct sections:
1. **Navigation group** — Tasks, New Task, and Dashboard (external link) as flat `SidebarMenuItem` items.
2. **Workspaces section** — `Collapsible` wrapping `SidebarMenuSub` with `SidebarMenuSubItem`/`SidebarMenuSubButton` per workspace, showing name and build status via `Badge`. Default open.
3. **Templates section** — Same collapsible pattern, showing template name and stale/fresh status via `Badge`. Default open.

Data fetching uses `useState` for per-section `data`, `isLoading`, and `error` state. `useEffect` triggers initial fetch on mount. `setInterval` at 30s polls both sections, with `useRef` for the interval ID to prevent stacking. A shared `lastRefreshed` timestamp updates on any successful fetch.

Each section renders an inline `Alert` with error message and retry button on fetch failure. Footer shows last-refreshed timestamp and a manual refresh button.

## Verification

- `pnpm tsc --noEmit` — no errors in modified files (20 pre-existing errors in unrelated queue/test files)
- `grep -q 'listTemplateStatusesAction' src/lib/actions/templates.ts` — PASS
- `grep -q 'Collapsible' src/components/app-sidebar.tsx` — PASS
- `grep -q 'setInterval' src/components/app-sidebar.tsx` — PASS

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm tsc --noEmit (filtered to app-sidebar/templates)` | 0 | ✅ pass | 8000ms |
| 2 | `grep -q 'listTemplateStatusesAction' src/lib/actions/templates.ts` | 0 | ✅ pass | 10ms |
| 3 | `grep -q 'Collapsible' src/components/app-sidebar.tsx` | 0 | ✅ pass | 10ms |
| 4 | `grep -q 'setInterval' src/components/app-sidebar.tsx` | 0 | ✅ pass | 10ms |

## Deviations

None — implementation followed the task plan exactly.

## Known Issues

20 pre-existing TypeScript errors in src/lib/queue/council-queues.ts, src/lib/queue/task-queue.ts, src/lib/workspace/cleanup.ts, and test files — unrelated to this task.

## Files Created/Modified

- `src/components/app-sidebar.tsx`
- `src/lib/actions/templates.ts`
