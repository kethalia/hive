---
estimated_steps: 17
estimated_files: 3
skills_used: []
---

# T03: Add test suites for template detail page and sidebar mode toggle

Write integration tests covering the template detail page rendering and push flow, sidebar mode toggle with localStorage persistence, and verify workspaces page removal and mobile sidebar behavior.

**Why:** Slice verification requires test suites that prove R061, R064, R065, R066 are met.

**Do:**
1. Create `src/__tests__/components/template-detail.test.tsx`:
   - Test that TemplateDetailClient renders template name, staleness badge, lastPushed, hashes
   - Test push button triggers POST to correct API endpoint
   - Test push error state renders error message
   - Mock TerminalPanel (dynamic import) and fetch API
2. Create `src/__tests__/components/sidebar-mode-toggle.test.tsx`:
   - Test default mode is offcanvas when localStorage is empty
   - Test clicking pin button changes mode to icon
   - Test clicking unpin button changes mode back to offcanvas
   - Test mode persists in localStorage
   - Test breadcrumb links point to /tasks (not /workspaces)
3. Update existing `src/__tests__/components/terminal-breadcrumbs.test.tsx` — change expected href from `/workspaces` to `/tasks`.
4. Run `pnpm vitest run` to confirm no regressions.

**Done when:** All new tests pass, existing tests pass (minus pre-existing failures), no type errors in test files.

## Inputs

- ``src/components/templates/TemplateDetailClient.tsx` — component under test (T01 output)`
- ``src/components/app-sidebar.tsx` — sidebar with pin/unpin toggle (T02 output)`
- ``src/hooks/use-sidebar-mode.ts` — hook under test (T02 output)`
- ``src/components/workspaces/TerminalBreadcrumbs.tsx` — breadcrumb with updated link (T02 output)`
- ``src/__tests__/components/terminal-breadcrumbs.test.tsx` — existing test to update`
- ``src/__tests__/components/app-sidebar.test.tsx` — reference for sidebar test mock patterns (vi.mock for shadcn UI, next/navigation, server actions)`

## Expected Output

- ``src/__tests__/components/template-detail.test.tsx` — new test suite for template detail page`
- ``src/__tests__/components/sidebar-mode-toggle.test.tsx` — new test suite for sidebar mode toggle and localStorage persistence`
- ``src/__tests__/components/terminal-breadcrumbs.test.tsx` — updated test with /tasks href expectation`

## Verification

pnpm vitest run src/__tests__/components/template-detail.test.tsx src/__tests__/components/sidebar-mode-toggle.test.tsx src/__tests__/components/terminal-breadcrumbs.test.tsx
