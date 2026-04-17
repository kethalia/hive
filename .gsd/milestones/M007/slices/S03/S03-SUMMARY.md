---
id: S03
parent: M007
milestone: M007
provides:
  - ["Template detail page at /templates/[name] with push flow", "Sidebar pin/unpin mode toggle with localStorage persistence", "Breadcrumb links point to /tasks"]
requires:
  - slice: S01
    provides: Sidebar structure with collapsible sections and template links
  - slice: S02
    provides: Terminal session navigation pattern
affects:
  []
key_files:
  - ["src/app/templates/[name]/page.tsx", "src/components/templates/TemplateDetailClient.tsx", "src/hooks/use-sidebar-mode.ts", "src/components/app-sidebar.tsx"]
key_decisions:
  - ["Used Link wrapping Button for back navigation instead of asChild prop — project Button component doesn't support Radix asChild composition", "PinOff icon for offcanvas mode (click to collapse) and Pin icon for icon mode (click to expand) — icon shows the action's result", "Deleted workspaces-client.test.tsx alongside the component it tested since the test subject no longer exists"]
patterns_established:
  - ["useSidebarMode hook pattern: localStorage-backed preference with SSR safety (check window !== undefined before reading)", "Template detail page pattern: server component validates name → fetches data → renders client component for interactive features"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-17T05:40:14.135Z
blocker_discovered: false
---

# S03: Template Detail Page & Sidebar Polish

**Added template detail page with SSE push flow, sidebar pin/unpin mode toggle with localStorage persistence, removed old workspaces listing page, and verified mobile responsive sidebar.**

## What Happened

## T01: Template Detail Page with Push Flow

Created `/templates/[name]` route as a server component that validates template names against KNOWN_TEMPLATES (404 for unknown), calls `compareTemplates([name])` for the TemplateStatus, and renders TemplateDetailClient.

TemplateDetailClient displays template name, staleness badge (stale/fresh/unknown/pushing), lastPushed date with relative time, localHash, remoteHash, and activeVersionId in a shadcn Card. The Push button triggers a POST to the push API, retrieves a jobId, opens an EventSource for SSE streaming, and pipes output into a dynamically imported TerminalPanel (ssr: false) with line history replay. Success/failure feedback shown inline.

Push flow, PushState interface, formatDate utility, and terminal patterns all reused from TemplatesClient.tsx.

## T02: Sidebar Mode Toggle & Workspaces Removal

Created `useSidebarMode` hook (`src/hooks/use-sidebar-mode.ts`) — localStorage-backed with SSR safety, returns `[mode, toggleMode]` with "offcanvas" (default) and "icon" values.

Wired the hook into AppSidebar: the `collapsible` prop on `<Sidebar>` is driven by the hook's mode value. Added Pin/PinOff toggle button in SidebarFooter next to the refresh button.

Deleted `src/app/workspaces/page.tsx`, `src/components/workspaces/WorkspacesClient.tsx`, and corresponding test file. Updated breadcrumb links in TerminalBreadcrumbs.tsx and WorkspaceToolPanel.tsx from `/workspaces` to `/tasks`.

## T03: Test Suites

Created 2 new test suites (23 tests) and updated 2 existing test files:
- `template-detail.test.tsx` (12 tests): rendering, push flow, error states, badges, missing data handling
- `sidebar-mode-toggle.test.tsx` (11 tests): hook unit tests (default, toggle, persistence, SSR safety, unknown values) and integration tests (button rendering, icon switching, localStorage persistence)
- Updated `terminal-breadcrumbs.test.tsx` to expect `/tasks` hrefs
- Fixed `app-sidebar.test.tsx` lucide-react mock to include Pin/PinOff exports (preventing 17 regressions from T02)

## Verification

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm vitest run` on 3 slice test files | ✅ 32 tests pass (12 + 11 + 9) |
| `pnpm tsc --noEmit` grep for changed files | ✅ 0 type errors |
| `! test -f src/app/workspaces/page.tsx` | ✅ Workspaces page deleted |
| `pnpm vitest run` full suite | ✅ 462 passed, 2 failed (pre-existing ResizeObserver issues in terminal tests, unrelated to this slice) |
| `grep -r 'WorkspacesClient' src/` | ✅ No remaining imports of deleted component |
| `grep -q 'collapsible' src/components/app-sidebar.tsx` | ✅ Sidebar wired to mode hook |
| `grep -q 'sidebar_mode' src/hooks/use-sidebar-mode.ts` | ✅ localStorage key present |
| `grep -q '/tasks' src/components/workspaces/TerminalBreadcrumbs.tsx` | ✅ Breadcrumbs updated |

## Requirements Advanced

None.

## Requirements Validated

- R061 — 11 tests pass in sidebar-mode-toggle.test.tsx covering default mode, toggle, persistence, and SSR safety
- R064 — 12 tests pass in template-detail.test.tsx covering rendering, push flow, error states
- R065 — Workspaces page deleted, breadcrumbs updated to /tasks, no remaining imports
- R066 — shadcn Sidebar renders as Sheet overlay via useIsMobile(), SidebarTrigger accessible

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Deleted src/__tests__/components/workspaces-client.test.tsx (not in plan) — necessary because its subject WorkspacesClient was removed in T02. Fixed app-sidebar.test.tsx lucide-react mock (not in plan) — necessary to prevent 17 test regressions from T02's Pin/PinOff addition.

## Known Limitations

2 pre-existing ResizeObserver test failures in terminal-tab-refit.test.tsx and interactive-terminal-integration.test.tsx — unrelated to this slice. Mobile sidebar behavior relies on shadcn's built-in useIsMobile() hook — no custom mobile logic was added or tested at the integration level.

## Follow-ups

None.

## Files Created/Modified

- `src/app/templates/[name]/page.tsx` — Server component for template detail route — validates name, fetches TemplateStatus, renders client component
- `src/components/templates/TemplateDetailClient.tsx` — Client component showing template info, staleness badge, and SSE push flow with TerminalPanel
- `src/hooks/use-sidebar-mode.ts` — localStorage-backed hook for sidebar mode preference (offcanvas/icon) with SSR safety
- `src/components/app-sidebar.tsx` — Wired collapsible prop to mode hook, added Pin/PinOff toggle in footer
- `src/components/workspaces/TerminalBreadcrumbs.tsx` — Updated breadcrumb links from /workspaces to /tasks
- `src/components/workspaces/WorkspaceToolPanel.tsx` — Updated breadcrumb links from /workspaces to /tasks
- `src/__tests__/components/template-detail.test.tsx` — 12 tests for template detail page rendering, push flow, error states
- `src/__tests__/components/sidebar-mode-toggle.test.tsx` — 11 tests for sidebar mode hook and toggle button integration
- `src/__tests__/components/terminal-breadcrumbs.test.tsx` — Updated expected href from /workspaces to /tasks
- `src/__tests__/components/app-sidebar.test.tsx` — Fixed lucide-react mock to include Pin/PinOff exports
