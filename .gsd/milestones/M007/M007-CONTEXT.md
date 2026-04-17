# M007: Sidebar Navigation Overhaul

**Gathered:** 2026-04-16
**Status:** Ready for planning

## Project Description

Restructure the Hive dashboard from a flat sidebar + dedicated pages model into a directory-tree sidebar that serves as the primary navigation surface. Workspaces and templates become collapsible sidebar sections with nested items. The header and breadcrumbs are removed from all pages. Terminal pages become full-viewport xterm with exclusive keystroke capture. The sidebar supports floating (offcanvas) and docked (pinned) modes with a toggle.

## Why This Milestone

The current UI has a disconnect between navigation and content. Workspace interaction requires navigating to a listing page, then into a workspace, then into a terminal — three clicks deep. The header and breadcrumbs consume vertical space that's valuable for terminal work. The sidebar is a flat nav menu that doesn't reflect the hierarchical relationship between workspaces, sessions, and tools.

This milestone makes the sidebar the workspace browser — eliminating the workspaces listing page and putting workspace actions (external tool links, terminal sessions) directly in the navigation tree. Terminal pages get 100% viewport with zero chrome except a floating sidebar trigger.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open the sidebar and see all workspaces as collapsible items, each showing 3 external-link buttons (Filebrowser, KasmVNC, Code Server) and nested terminal sessions
- Click a terminal session in the sidebar to navigate to a full-viewport terminal page with exclusive keystroke capture
- Create, switch between, and kill terminal sessions from the sidebar
- Open the sidebar and see all Coder templates as collapsible items, clicking one opens a detail page with info and push button
- Toggle the sidebar between floating (overlay) and docked (pinned) mode via a pin/unpin toggle, with preference persisted in localStorage
- See a "last refreshed" timestamp and manual refresh button at the bottom of the sidebar

### Entry point / environment

- Entry point: Browser at the Hive dashboard URL
- Environment: Local dev / browser
- Live dependencies involved: Coder API (workspace listing, template data)

## Completion Class

- Contract complete means: Sidebar renders live workspace/template trees, terminal pages capture all keystrokes, mode toggle persists preference, old pages removed
- Integration complete means: Server actions return real Coder workspace and template data, terminal sessions in sidebar map to real tmux sessions
- Operational complete means: none — no new services or lifecycle concerns

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Navigating from sidebar workspace → terminal session → full-page terminal works end-to-end with real Coder data
- All keystrokes on the terminal page reach xterm (verified by integration test)
- Sidebar mode toggle persists across page navigation and browser refresh
- Old workspaces listing page is gone and its routes return 404

## Architectural Decisions

### Sidebar layout strategy

**Decision:** Use shadcn's `SidebarMenuSub` / `SidebarMenuSubItem` / `SidebarMenuSubButton` primitives with `Collapsible` for the directory-tree structure.

**Rationale:** These primitives are already installed and provide accessible, styled nested navigation out of the box. No custom tree component needed.

**Alternatives Considered:**
- Custom tree component with recursive rendering — over-engineered for 2 levels of nesting
- Radix NavigationMenu — designed for horizontal nav, wrong primitive for sidebar trees

### Sidebar mode (floating vs docked)

**Decision:** shadcn's `SidebarProvider` with `collapsible` prop toggling between `"offcanvas"` (floating/overlay) and `"sidebar"` (docked). Default to offcanvas. Store preference in localStorage. Pin/unpin toggle at bottom of sidebar.

**Rationale:** User wants full terminal width by default (floating) but option to pin for persistent navigation. The `collapsible` prop handles both modes natively. ResizeObserver on terminal containers already handles width changes from mode switches.

**Alternatives Considered:**
- Always floating — removes user choice for workflows where persistent sidebar is preferred
- Always docked — steals ~256px from terminal width permanently

### Header removal

**Decision:** Remove the header bar (`HeaderContent`) from all pages globally. Replace with a floating `SidebarTrigger` button positioned absolute in the top-left corner.

**Rationale:** User explicitly wants zero chrome on all pages, not just terminals. The sidebar trigger is the only UI element needed outside of page content. Floating position keeps it accessible without consuming layout space.

**Alternatives Considered:**
- Conditional header (hide on terminal pages only) — user explicitly said "no header on any page"
- Keep header with just sidebar trigger — still consumes vertical space unnecessarily

### Terminal keystroke capture

**Decision:** Auto-focus xterm on terminal page mount and on any click within the terminal content area. Sidebar interactions don't fight for focus.

**Rationale:** Terminal-first UX — the terminal should always be ready for input without requiring an explicit click into it. Sidebar clicks naturally shift focus to sidebar elements; returning to the terminal area recaptures focus.

**Alternatives Considered:**
- Global keyboard event capture forwarding to xterm — fragile, breaks browser shortcuts
- Click-to-focus only — extra click on every page load and tab switch

### Workspace action buttons in sidebar

**Decision:** Filebrowser, KasmVNC, and Code Server buttons open in new browser tabs (external links). Terminal is a collapsible section with sessions underneath.

**Rationale:** These three tools are full applications that work better in their own tabs. Terminal sessions are the primary in-app navigation target and belong in the sidebar tree.

**Alternatives Considered:**
- All four as in-page navigation — the iframe-embedded tools (M005/S04) work but are secondary to terminal use

### Sidebar data fetching

**Decision:** Sidebar calls server actions (`listWorkspacesAction`, `compareTemplates`) on mount with periodic polling. "Last refreshed" timestamp and manual refresh button at sidebar bottom.

**Rationale:** Sidebar is a client component in the root layout. Server actions are the established data fetching pattern (D005). Periodic polling keeps data fresh without SSE complexity. Manual refresh gives user control.

**Alternatives Considered:**
- Server layout data fetching with props — causes re-fetch on every page navigation
- SSE/WebSocket for real-time updates — over-engineered for workspace/template list data that changes infrequently

## Error Handling Strategy

- **Sidebar fetch failures:** Inline error with retry button per collapsible section ("Failed to load workspaces — Retry"). Last known state preserved between poll failures.
- **Terminal focus loss:** Auto-refocus xterm on any click within the terminal content area. Sidebar interactions don't fight for focus. No aggressive recapture on tab switch.
- **Stale sidebar data:** When clicking a stale workspace/template entry leads to a 404 or connection failure, show error on the page and force-refresh the sidebar to remove the stale entry.
- **Sidebar mode toggle:** Preference stored in localStorage. If localStorage is unavailable, default to floating mode silently.

## Risks and Unknowns

- Removing the header globally may break existing page layouts that depend on header height — need to audit all pages
- Terminal keystroke capture must not break browser keyboard shortcuts (Cmd+T, Cmd+W, etc.)
- Session management in sidebar must stay in sync with tmux sessions on the workspace — stale session list after external tmux kill

## Existing Codebase / Prior Art

- `src/components/app-sidebar.tsx` — current flat sidebar, uses shadcn SidebarMenu primitives
- `src/components/HeaderContent.tsx` — header bar to be removed
- `src/components/workspaces/TerminalBreadcrumbs.tsx` — breadcrumbs to be removed
- `src/components/workspaces/WorkspacesClient.tsx` — workspace listing client component, data fetching patterns to reuse
- `src/components/workspaces/TerminalTabManager.tsx` — current tab management, session switching moves to sidebar
- `src/components/workspaces/InteractiveTerminal.tsx` — xterm component, focus management changes here
- `src/lib/actions/workspaces.ts` — server actions for workspace/session operations
- `src/app/workspaces/page.tsx` — workspaces listing page to be removed
- `src/app/workspaces/[id]/page.tsx` — workspace detail page (tool panel) to be removed
- `src/app/templates/page.tsx` — templates page, becomes sidebar-driven
- `src/components/templates/TemplatesClient.tsx` — template listing, patterns to reuse
- `src/hooks/use-mobile.ts` — mobile detection hook, already wired

## Relevant Requirements

- R056 — Directory-tree sidebar with collapsible Workspaces and Templates sections
- R057 — Workspace sidebar items show 3 external-link buttons and nested terminal sessions
- R058 — Terminal sessions manageable from sidebar
- R059 — Sidebar fetches live data via server actions with periodic polling
- R060 — Last-refreshed timestamp and manual refresh button at sidebar bottom
- R061 — Sidebar mode toggle: floating vs docked, persisted in localStorage
- R062 — Header and breadcrumbs removed from all pages
- R063 — Terminal pages are full-viewport xterm with exclusive keystroke capture
- R064 — Template detail page showing template info and push button
- R065 — Workspaces listing page removed
- R066 — Mobile-responsive sidebar
- R067 — Sidebar fetch failures show inline error with retry
- R068 — Stale sidebar entry click triggers page error + sidebar force-refresh
- R069 — Integration test for terminal keystroke exclusivity

## Scope

### In Scope

- Sidebar restructuring to directory-tree layout
- Workspace collapsible items with external links and terminal sessions
- Terminal session management (create, switch, kill) from sidebar
- Template collapsible items linking to detail pages
- Per-template detail page (minimal: info + push)
- Header and breadcrumbs removal from all pages
- Floating sidebar trigger
- Sidebar mode toggle (floating/docked)
- Full-viewport terminal pages with keystroke capture
- Periodic polling with last-refreshed and refresh button
- Mobile responsive sidebar
- Error handling for fetch failures and stale data
- Removal of workspaces listing page

### Out of Scope / Non-Goals

- Tasks section migration to tree-style (deferred, user will migrate later)
- Full template file tree with inline file viewing (deferred)
- Real-time WebSocket updates for sidebar data
- Workspace creation/deletion from sidebar (permanent exclusion per D021)

## Technical Constraints

- Must use existing shadcn sidebar primitives (`SidebarMenuSub`, `Collapsible`, `SidebarTrigger`)
- Must preserve existing terminal functionality (WebSocket, tmux, scrollback, keep-alive)
- Server actions are the data fetching pattern (D005)
- ResizeObserver-based terminal refit must work with sidebar mode changes

## Integration Points

- Coder API — workspace listing and template data via existing server actions
- Terminal WebSocket proxy — unchanged, terminal pages just become full-viewport
- tmux sessions — session list in sidebar must reflect actual tmux sessions on workspace

## Testing Requirements

- Integration test verifying terminal keystroke exclusivity after mount and after sidebar toggle
- Component tests for sidebar tree rendering with mock workspace/template data
- Component tests for sidebar mode toggle and localStorage persistence
- Mobile viewport testing for sidebar overlay behavior
- Existing terminal tests must continue passing (no regressions)

## Acceptance Criteria

**S01 (Sidebar tree and layout):**
- Sidebar shows collapsible Workspaces and Templates sections
- Header removed from all pages, floating sidebar trigger visible
- Sidebar fetches live data from server actions
- Last-refreshed timestamp and refresh button at sidebar bottom
- Fetch failure shows inline error with retry

**S02 (Terminal integration and sessions):**
- Terminal sessions listed under each workspace in sidebar
- Clicking a session navigates to full-page terminal
- All keystrokes captured by xterm (verified by test)
- Session create/kill/switch from sidebar
- Stale entry click triggers error + sidebar refresh

**S03 (Template detail and polish):**
- Template detail page with info + push button
- Sidebar mode toggle (pin/unpin) with localStorage persistence
- Mobile responsive sidebar
- Old workspaces page removed

## Open Questions

- None — all gray areas resolved during discussion
