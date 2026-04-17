---
estimated_steps: 16
estimated_files: 2
skills_used: []
---

# T03: Add footer timestamp and refresh button, inline error states with retry, and sidebar tests

**1. Footer: last-refreshed timestamp + refresh button.** Replace the disabled Settings button in `SidebarFooter` with:
- A formatted last-refreshed timestamp (e.g. "Updated 2m ago" or "Updated just now") using relative time formatting. The `lastRefreshed` state from T02 drives this.
- A refresh `Button` (variant ghost, size sm) with `RefreshCw` icon from lucide-react that calls both `listWorkspacesAction` and `listTemplateStatusesAction` immediately and updates `lastRefreshed`. Disable while loading. Show spin animation on the icon while refreshing (`animate-spin` class).

**2. Inline error states with retry.** When a section's fetch fails, render an `Alert` (variant destructive) inside the `CollapsibleContent` with:
- The error message text
- A retry `Button` (variant outline, size sm) that re-triggers the fetch for that section
- Import `Alert`, `AlertDescription` from `@/components/ui/alert` and `AlertCircle` from lucide-react

**3. Tests.** Create `src/__tests__/components/app-sidebar.test.tsx` with vitest + @testing-library/react:
- Test that collapsible Workspaces section renders workspace names when data loads
- Test that collapsible Templates section renders template names when data loads
- Test that error state renders Alert with retry button
- Test that refresh button exists in footer
- Mock `listWorkspacesAction` and `listTemplateStatusesAction` using `vi.mock`
- Mock `next/navigation` usePathname to return '/tasks'
- Use the existing test patterns from `src/__tests__/components/workspaces-client.test.tsx` as reference for component testing conventions

R060: last-refreshed timestamp and manual refresh button. R067: fetch failures show inline error with retry.

## Inputs

- ``src/components/app-sidebar.tsx` — sidebar from T02 with collapsible sections, data fetching, lastRefreshed/error state`
- ``src/components/ui/alert.tsx` — Alert, AlertDescription components for error display`
- ``src/__tests__/components/workspaces-client.test.tsx` — reference for component testing patterns in this codebase`
- ``src/lib/actions/templates.ts` — listTemplateStatusesAction from T02 (to mock in tests)`
- ``src/lib/actions/workspaces.ts` — listWorkspacesAction (to mock in tests)`

## Expected Output

- ``src/components/app-sidebar.tsx` — SidebarFooter with formatted last-refreshed timestamp and refresh button with spin animation; inline Alert with retry button per section on fetch failure`
- ``src/__tests__/components/app-sidebar.test.tsx` — new test file with tests for collapsible sections rendering, error state with retry, and refresh button`

## Verification

pnpm tsc --noEmit && pnpm vitest run src/__tests__/components/app-sidebar.test.tsx && grep -q 'Alert' src/components/app-sidebar.tsx && grep -q 'RefreshCw' src/components/app-sidebar.tsx
