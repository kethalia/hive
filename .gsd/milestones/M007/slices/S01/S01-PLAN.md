# S01: Sidebar Tree Structure & Layout Overhaul

**Goal:** Sidebar shows collapsible Workspaces and Templates sections with live data from Coder API. Header removed from all pages. Floating sidebar trigger visible. Last-refreshed timestamp and refresh button at sidebar bottom. Fetch failures show inline error with retry.
**Demo:** Sidebar shows collapsible Workspaces and Templates sections with live data from Coder API. Header removed from all pages. Floating sidebar trigger visible. Last-refreshed timestamp and refresh button at sidebar bottom. Fetch failures show inline error with retry.

## Must-Haves

- `pnpm tsc --noEmit` passes with zero errors
- `pnpm test` passes with no regressions
- `src/__tests__/components/app-sidebar.test.tsx` exists and passes — tests collapsible sections render, error state renders retry button, refresh button triggers re-fetch
- No `<header>` element in `layout.tsx` — floating `SidebarTrigger` is the only chrome
- Sidebar renders two collapsible sections (Workspaces, Templates) with live data
- Footer shows last-refreshed timestamp and manual refresh button
- Fetch failure shows inline Alert with retry button per section

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes
- Human/UAT required: yes — visual verification of sidebar layout, floating trigger positioning, and error states

## Integration Closure

- Upstream surfaces consumed: `listWorkspacesAction` from `src/lib/actions/workspaces.ts`, `compareTemplates` from `src/lib/templates/staleness.ts` (via new server action wrapper), `SidebarMenuSub`/`Collapsible` primitives from `src/components/ui/sidebar.tsx` and `src/components/ui/collapsible.tsx`
- New wiring introduced in this slice: `listTemplateStatusesAction` server action, collapsible sidebar sections replacing flat nav, floating SidebarTrigger replacing header
- What remains before the milestone is truly usable end-to-end: S02 (workspace tool buttons + terminal sessions in sidebar), S03 (workspace listing page removal + route redirects)

## Verification

- Runtime signals: console.error on fetch failures, polling interval lifecycle in useEffect cleanup
- Inspection surfaces: React DevTools state for lastRefreshed/error/isLoading per section; browser Network tab for polling requests
- Failure visibility: inline Alert component with error message and retry button per sidebar section
- Redaction constraints: none — no secrets in sidebar data

## Tasks

- [x] **T01: Remove header and position floating sidebar trigger** `est:30m`
  Remove the `<header>` block from `layout.tsx` (lines 38-44) which contains SidebarTrigger, Separator, and HeaderContent. Reposition `SidebarTrigger` as a fixed floating button in the top-left corner (e.g. `fixed top-3 left-3 z-50`) outside the SidebarInset, so it's always visible regardless of sidebar state. Delete `HeaderContent.tsx` entirely — it renders breadcrumbs that are being removed per D029. Remove the `HeaderContent` and `Separator` imports from layout.tsx. Adjust `<main>` padding-top if needed so content doesn't sit under the floating trigger.

The SidebarTrigger must remain inside the SidebarProvider so it can toggle the sidebar. Place it as a sibling of SidebarInset, after AppSidebar.

R062 requires header and breadcrumbs removed from ALL pages with only the floating trigger remaining.
  - Files: `src/app/layout.tsx`, `src/components/HeaderContent.tsx`
  - Verify: grep -qv '<header' src/app/layout.tsx && ! test -f src/components/HeaderContent.tsx && pnpm tsc --noEmit

- [ ] **T02: Replace flat nav with collapsible Workspaces and Templates tree sections with live data** `est:1h30m`
  This is the core structural and data-wiring task. Three sub-parts:

**1. Create template status server action.** `compareTemplates()` in `src/lib/templates/staleness.ts` is a regular async function, not a server action. Create `src/lib/actions/templates.ts` with a `listTemplateStatusesAction` server action that wraps `compareTemplates(KNOWN_TEMPLATES)` using the same `actionClient` pattern as `listWorkspacesAction`.

**2. Replace flat nav with collapsible tree.** In `app-sidebar.tsx`, remove the `navItems` array and its rendering loop. Replace with two collapsible `SidebarGroup` sections:
- **Workspaces** section: uses `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent` wrapping `SidebarMenuSub` with `SidebarMenuSubItem`/`SidebarMenuSubButton` for each workspace. Show workspace name and status. Default open.
- **Templates** section: same pattern, showing template name and stale/fresh status.
- Keep Tasks and New Task as flat `SidebarMenuItem` items in a separate Navigation group.
- Keep the Dashboard external link if `coderUrl` is set.

**3. Wire data fetching with 30s polling.** Convert `AppSidebar` to use `useState` for workspaces, templates, loading states, and error states (per section). Use `useEffect` for initial fetch on mount. Set up `setInterval` at 30s for polling — use a `useRef` for the interval ID to prevent stacking on re-renders from `usePathname()`. Each section tracks its own `isLoading`, `error`, and `data` state independently. Call `listWorkspacesAction()` and `listTemplateStatusesAction()` for data. Track a shared `lastRefreshed: Date | null` state updated on successful fetch of either section.

The `Collapsible` component requires explicit `open`/`onOpenChange` state — use `useState(true)` for default-open sections.

Import icons: `ChevronRight` for collapse toggle, `Monitor` for workspaces section, `LayoutTemplate` for templates section.
  - Files: `src/components/app-sidebar.tsx`, `src/lib/actions/templates.ts`
  - Verify: pnpm tsc --noEmit && grep -q 'listTemplateStatusesAction' src/lib/actions/templates.ts && grep -q 'Collapsible' src/components/app-sidebar.tsx && grep -q 'setInterval' src/components/app-sidebar.tsx

- [ ] **T03: Add footer timestamp and refresh button, inline error states with retry, and sidebar tests** `est:1h`
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
  - Files: `src/components/app-sidebar.tsx`, `src/__tests__/components/app-sidebar.test.tsx`
  - Verify: pnpm tsc --noEmit && pnpm vitest run src/__tests__/components/app-sidebar.test.tsx && grep -q 'Alert' src/components/app-sidebar.tsx && grep -q 'RefreshCw' src/components/app-sidebar.tsx

## Files Likely Touched

- src/app/layout.tsx
- src/components/HeaderContent.tsx
- src/components/app-sidebar.tsx
- src/lib/actions/templates.ts
- src/__tests__/components/app-sidebar.test.tsx
