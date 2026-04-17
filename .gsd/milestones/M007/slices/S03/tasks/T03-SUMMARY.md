---
id: T03
parent: S03
milestone: M007
key_files:
  - src/__tests__/components/template-detail.test.tsx
  - src/__tests__/components/sidebar-mode-toggle.test.tsx
  - src/__tests__/components/terminal-breadcrumbs.test.tsx
  - src/__tests__/components/app-sidebar.test.tsx
key_decisions:
  - Fixed app-sidebar.test.tsx lucide-react mock to include Pin/PinOff — this was broken by T02 and would have failed independently
duration: 
verification_result: passed
completed_at: 2026-04-17T05:38:28.460Z
blocker_discovered: false
---

# T03: Add test suites for template detail page, sidebar mode toggle, and update breadcrumb link expectation to /tasks

**Add test suites for template detail page, sidebar mode toggle, and update breadcrumb link expectation to /tasks**

## What Happened

Created two new test suites and updated one existing test file:

1. **`template-detail.test.tsx`** (12 tests): Covers TemplateDetailClient rendering — template name, staleness/Current/Unknown badges, lastPushed/hashes/activeVersionId display, push button triggering POST to correct endpoint, error states (non-ok response and network error), back link to /templates, Pushing… badge during push, and dash for missing lastPushed. Mocks `next/dynamic` for TerminalPanel, `fetch` for push API, and `EventSource` for SSE.

2. **`sidebar-mode-toggle.test.tsx`** (11 tests): Split into two describe blocks. First tests `useSidebarMode` hook directly via `renderHook` — default offcanvas when localStorage empty, reads icon mode from storage, toggle changes mode both directions, persists to localStorage, treats unknown values as offcanvas. Second tests the AppSidebar mode toggle button integration — renders toggle in footer, shows PinOff icon in default offcanvas mode, clicking switches to Pin icon, persists to localStorage, double-click returns to offcanvas.

3. **`terminal-breadcrumbs.test.tsx`**: Updated the "Workspaces link" test to expect `/tasks` instead of `/workspaces`, matching the T02 change to TerminalBreadcrumbs.

4. **`app-sidebar.test.tsx`**: Added missing `Pin` and `PinOff` exports to the lucide-react mock, fixing 17 pre-existing failures caused by the T02 pin/unpin feature addition.

## Verification

Ran `pnpm vitest run` on all 4 test files — 49 tests pass (12 + 11 + 9 + 17). Full suite run confirms the only failures are 2 pre-existing ResizeObserver tests unrelated to this slice.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/template-detail.test.tsx src/__tests__/components/sidebar-mode-toggle.test.tsx src/__tests__/components/terminal-breadcrumbs.test.tsx src/__tests__/components/app-sidebar.test.tsx` | 0 | ✅ pass | 1660ms |

## Deviations

Fixed app-sidebar.test.tsx lucide-react mock (adding Pin/PinOff) which was not in the task plan but was necessary to prevent 17 test regressions from T02 changes

## Known Issues

2 pre-existing ResizeObserver test failures in terminal-tab-refit.test.tsx and interactive-terminal-integration.test.tsx — unrelated to this slice

## Files Created/Modified

- `src/__tests__/components/template-detail.test.tsx`
- `src/__tests__/components/sidebar-mode-toggle.test.tsx`
- `src/__tests__/components/terminal-breadcrumbs.test.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`
