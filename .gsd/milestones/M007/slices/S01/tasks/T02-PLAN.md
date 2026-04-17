---
estimated_steps: 10
estimated_files: 2
skills_used: []
---

# T02: Replace flat nav with collapsible Workspaces and Templates tree sections with live data

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

## Inputs

- ``src/components/app-sidebar.tsx` — current flat sidebar with navItems array (lines 27-32) and rendering loop (lines 50-61)`
- ``src/lib/actions/workspaces.ts` — existing `listWorkspacesAction` server action pattern to follow`
- ``src/lib/templates/staleness.ts` — `compareTemplates` function and `KNOWN_TEMPLATES` constant to wrap`
- ``src/components/ui/sidebar.tsx` — SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton exports (lines 638-717)`
- ``src/components/ui/collapsible.tsx` — Collapsible, CollapsibleTrigger, CollapsibleContent exports`
- ``src/lib/coder/types.ts` — CoderWorkspace interface for typing workspace data`

## Expected Output

- ``src/components/app-sidebar.tsx` — flat nav replaced with collapsible Workspaces and Templates sections, useState/useEffect/setInterval for data fetching and 30s polling, per-section loading/error state, lastRefreshed timestamp tracking`
- ``src/lib/actions/templates.ts` — new server action file with `listTemplateStatusesAction` wrapping `compareTemplates(KNOWN_TEMPLATES)``

## Verification

pnpm tsc --noEmit && grep -q 'listTemplateStatusesAction' src/lib/actions/templates.ts && grep -q 'Collapsible' src/components/app-sidebar.tsx && grep -q 'setInterval' src/components/app-sidebar.tsx
