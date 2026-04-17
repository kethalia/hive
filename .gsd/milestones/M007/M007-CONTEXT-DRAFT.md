# M007: App Structure Redesign — Context Draft

**Gathered:** 2026-04-16
**Status:** Draft — depth verified, pre-requirements

## Project Description

Restructure the Hive dashboard from flat sidebar navigation + dedicated listing pages into a directory-tree-style sidebar that IS the navigation surface. Terminal-first focus: full-viewport terminals, exclusive keystroke capture, no header chrome.

## Implementation Decisions

### Sidebar Structure
- Directory-tree layout with collapsible sections: Workspaces, Templates
- Tasks section stays flat (migration deferred)
- Each workspace is a collapsible item showing: 3 external-link buttons (Filebrowser, KasmVNC, Code Server) + terminal sessions collapsible with + button
- Templates section lists templates, clicking opens detail page
- "Last refreshed" timestamp + refresh button at sidebar bottom
- Sidebar mode toggle: floating (offcanvas) vs docked (pinned), stored in localStorage, default floating

### Terminal Pages
- Full viewport — no header, no breadcrumbs on ANY page
- Only chrome: floating sidebar trigger button (absolute positioned, semi-transparent)
- Tab bar removed from terminal page — sidebar is the only session switcher
- All keystrokes on terminal page go to xterm (auto-refocus on click in terminal area)

### Template Detail Page
- Minimal: template info + push button
- No full file browser for now

### Data Fetching
- Server actions for workspace list and template list called from sidebar
- Periodic polling for live data
- Sidebar shows connection/status badges per workspace

### Error Handling
- Sidebar fetch failures: inline error with retry button per section
- Terminal focus: auto-refocus on click within terminal content area
- Stale data: error on page + force-refresh sidebar on 404/connection failure
- Sidebar mode toggle: localStorage persistence, terminal auto-refits via ResizeObserver

### Quality Bar
- Integration test for terminal keystroke exclusivity
- Mobile responsive sidebar
- Definition of done: old workspaces page removed, header removed everywhere, sidebar tree with live data, full-page terminal, template detail page, sidebar mode toggle

## Existing Codebase References
- `src/components/app-sidebar.tsx` — current flat sidebar (to be replaced)
- `src/app/layout.tsx` — root layout with SidebarProvider, header, breadcrumbs
- `src/components/HeaderContent.tsx` — header content (to be removed)
- `src/components/workspaces/TerminalTabManager.tsx` — tab management (moving to sidebar)
- `src/components/workspaces/InteractiveTerminal.tsx` — terminal with ResizeObserver
- `src/components/workspaces/WorkspacesClient.tsx` — workspace fetching patterns
- `src/components/templates/TemplatesClient.tsx` — template status/push patterns
- `src/lib/actions/workspaces.ts` — workspace server actions (reusable)
- shadcn sidebar primitives: SidebarMenuSub, SidebarMenuSubItem, collapsible="offcanvas"

## Agent's Discretion
- Terminal session naming and max session limits — sensible defaults
- Exact floating toggle button positioning and styling
- Polling interval for sidebar data refresh
