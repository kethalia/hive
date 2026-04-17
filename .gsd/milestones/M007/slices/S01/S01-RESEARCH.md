# S01 — Sidebar Tree Structure & Layout Overhaul — Research

**Date:** 2026-04-17
**Depth:** Light — well-understood work using established shadcn sidebar primitives already in the codebase

## Summary

S01 restructures the flat sidebar into a directory-tree with collapsible Workspaces and Templates sections, removes the header/breadcrumbs from all pages, adds a floating sidebar trigger, wires live data fetching with polling, and adds a last-refreshed timestamp with refresh button and inline error handling.

The codebase is well-prepared for this. All required shadcn primitives (`SidebarMenuSub`, `SidebarMenuSubItem`, `SidebarMenuSubButton`, `Collapsible`) are already exported from `src/components/ui/sidebar.tsx` (lines 715-717) and `src/components/ui/collapsible.tsx` — they're just not used yet. The `SidebarProvider` already handles mobile/desktop modes, cookie persistence, and keyboard shortcuts. Server actions for workspace listing (`listWorkspacesAction`) and template comparison (`compareTemplates`) exist and return the data the sidebar needs. The main work is replacing the flat `navItems` array in `AppSidebar` with two collapsible sections that fetch and render live data, removing the `<header>` block from `layout.tsx`, and positioning the `SidebarTrigger` as a floating element.

## Recommendation

Build bottom-up: first remove the header from layout.tsx and position the floating trigger (smallest blast radius, immediately testable). Then replace the flat sidebar nav with collapsible Workspaces and Templates sections using the existing sub-menu primitives. Finally wire data fetching, polling, timestamps, and error handling. This order means each step is independently verifiable and the hardest integration (data fetching + error states) comes last when the structural shell is already working.

## Implementation Landscape

### Key Files

- **`src/app/layout.tsx`** (54 lines) — Root layout. Contains the `<header>` block (lines 38-44) wrapping `SidebarTrigger`, `Separator`, and `HeaderContent`. The header must be removed entirely. The `SidebarTrigger` needs to be repositioned as a floating absolute element outside the header. The `<main>` tag (line 45) currently has `p-6` padding which may need adjustment for full-viewport terminal pages (S02 concern, but worth noting). `SidebarProvider` on line 35 has no `collapsible` prop — defaults are fine for S01.

- **`src/components/app-sidebar.tsx`** (95 lines) — Current flat sidebar. The entire `navItems` array (lines 27-32) and its rendering loop (lines 50-61) get replaced with two collapsible sections: Workspaces and Templates. The Tasks/New Task items stay as flat nav items. The `coderUrl` prop is used for a Dashboard external link (lines 62-77) — this stays but moves into context or becomes a workspace-level link. The component needs to become a data-fetching client component with `useState` for workspace/template data, polling via `useEffect`/`setInterval`, and error state per section. The `SidebarFooter` (lines 83-92) gets the last-refreshed timestamp and refresh button instead of the disabled Settings button.

- **`src/components/HeaderContent.tsx`** (40 lines) — Renders breadcrumbs based on route. Will be removed entirely (along with its import in layout.tsx). `TerminalBreadcrumbs` import inside it also becomes unused.

- **`src/components/ui/sidebar.tsx`** (723 lines) — No changes needed. Already exports all required primitives: `SidebarMenuSub` (line 638), `SidebarMenuSubItem` (line 652), `SidebarMenuSubButton` (line 666). The `SidebarTrigger` component (around line 580) renders a `Button` with `PanelLeftIcon` — can be used as-is with added absolute positioning classes.

- **`src/components/ui/collapsible.tsx`** (21 lines) — Wraps Base UI's `Collapsible` primitive. Exports `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent`. Used to wrap each sidebar section (Workspaces, Templates) for expand/collapse behavior.

- **`src/lib/actions/workspaces.ts`** (183 lines) — Server actions. `listWorkspacesAction` (line 17) returns `CoderWorkspace[]` with id, name, template_name, status, owner_name. This is the data source for the Workspaces sidebar section.

- **`src/lib/templates/staleness.ts`** (228 lines) — `compareTemplates(names)` returns `TemplateStatus[]` with name, stale flag, lastPushed date. `KNOWN_TEMPLATES` = ["hive", "ai-dev"]. This is the data source for the Templates sidebar section.

- **`src/lib/coder/types.ts`** (60+ lines) — `CoderWorkspace` interface with id, name, template_name, latest_build.status, owner_name, last_used_at. These fields drive what the sidebar workspace items display.

- **`src/components/workspaces/WorkspacesClient.tsx`** (259 lines) — Contains workspace URL construction pattern for Filebrowser/KasmVNC/Code Server (external links). The URL pattern and status badge mapping should be extracted or reused in the sidebar component. Also contains `formatRelativeTime()` utility.

- **`src/components/templates/TemplatesClient.tsx`** (360 lines) — Contains 30-second polling pattern via `setInterval` + `refreshStatuses()`. This polling pattern should be replicated in the sidebar. Also has the template status badge mapping.

### Build Order

1. **Header removal + floating trigger** — Edit `layout.tsx` to remove the `<header>` block and position `SidebarTrigger` as a floating absolute element (e.g., `fixed top-3 left-3 z-50`). Delete or orphan `HeaderContent.tsx`. This is the smallest change with the clearest verification (visual: no header, trigger floats). Unblocks all downstream work by establishing the new layout contract.

2. **Sidebar tree structure** — Replace the flat nav in `app-sidebar.tsx` with two collapsible `SidebarGroup` sections (Workspaces, Templates) using `Collapsible` + `SidebarMenuSub` + `SidebarMenuSubItem` + `SidebarMenuSubButton`. Keep Tasks/New Task as flat items. Use static mock data first to validate the tree renders correctly. This proves the component structure before wiring data.

3. **Data fetching + polling** — Wire `listWorkspacesAction` and `compareTemplates` into the sidebar with `useState` + `useEffect` for initial fetch and `setInterval` for periodic refresh (30s matches existing template polling). Track `lastRefreshed` timestamp and `isLoading`/`error` state per section.

4. **Footer: timestamp + refresh + error states** — Add last-refreshed display and manual refresh button to `SidebarFooter`. Add inline error with retry button per collapsible section when fetch fails. Use `Alert` component from shadcn for error display.

### Verification Approach

- **Visual:** Dev server (`pnpm dev`) — verify header is gone on all routes (/tasks, /templates, /workspaces, /workspaces/[id]/terminal/*), floating trigger is visible and toggles sidebar.
- **Tree rendering:** Sidebar shows collapsible Workspaces and Templates sections. Clicking chevron expands/collapses. Sub-items render with correct names.
- **Data freshness:** Timestamp updates on mount and every 30s. Manual refresh button triggers immediate re-fetch and updates timestamp.
- **Error handling:** Kill the Coder API connection and verify inline error appears with retry button. Click retry and verify recovery when API is back.
- **Type check:** `pnpm tsc --noEmit` passes.
- **Existing tests:** `pnpm test` — no regressions.

## Constraints

- `AppSidebar` receives `coderUrl` as a prop from the server layout — server actions can be called from client components but `compareTemplates` is a regular async function, not a server action. It needs a server action wrapper or the sidebar needs initial data passed as props from the layout.
- `SidebarMenuSub` is hidden when sidebar is in icon-collapsed mode (`group-data-[collapsible=icon]:hidden`) — this is correct behavior but means collapsed sidebar shows no workspace/template items. Only the top-level section icons are visible.
- The `Collapsible` component from `@base-ui/react` requires explicit open state management — it doesn't auto-integrate with `SidebarProvider` state. Each section needs its own `open` state.

## Common Pitfalls

- **`compareTemplates` is not a server action** — It's a regular async function in `src/lib/templates/staleness.ts`, not marked with `"use server"`. The sidebar (a client component) cannot call it directly. Need to create a `listTemplateStatusesAction` server action wrapper, or pass initial template data as a prop from the server layout. The workspace actions already follow the server action pattern and work fine.
- **Sidebar re-renders on every route change** — `usePathname()` in `AppSidebar` causes re-render on navigation. Data fetching with `useState` will survive these re-renders (state persists), but polling intervals must be set up with proper cleanup to avoid stacking intervals on re-renders. Use a `useRef` for the interval ID.
- **Header removal breaks terminal breadcrumbs** — `TerminalBreadcrumbs` is currently rendered inside `HeaderContent` for terminal routes. With header removal, terminal routes lose their breadcrumbs. This is intentional (D029) but verify no other component depends on `HeaderContent` being present.

## Requirements Targeted

| Req | Description | How S01 Delivers |
|-----|-------------|-----------------|
| R056 | Directory-tree sidebar with collapsible sections | Collapsible Workspaces + Templates groups using SidebarMenuSub primitives |
| R059 | Sidebar fetches live data via server actions with polling | listWorkspacesAction + new template status action, 30s setInterval |
| R060 | Last-refreshed timestamp and manual refresh button | SidebarFooter with formatted timestamp + refresh button |
| R062 | Header and breadcrumbs removed, floating trigger only | Remove header block from layout.tsx, position SidebarTrigger as fixed/absolute |
| R067 | Fetch failures show inline error with retry | Per-section error state with Alert + retry button |

## Skills Discovered

No external skills needed — this slice uses only shadcn primitives and Next.js patterns already established in the codebase.
