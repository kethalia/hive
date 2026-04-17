---
id: M007
title: "Sidebar Navigation Overhaul"
status: complete
completed_at: 2026-04-17T05:45:24.305Z
key_decisions:
  - D027: shadcn SidebarMenuSub/Collapsible primitives for nested tree structure — no custom recursive tree needed for two nesting levels
  - D028: SidebarProvider collapsible prop toggles offcanvas/sidebar modes with localStorage persistence and Pin/PinOff toggle
  - D029: Header/breadcrumbs removed globally, replaced with floating SidebarTrigger — zero chrome on all pages per user directive
  - D030: Terminal keystroke capture via auto-focus on mount + click-to-refocus, not global keyboard forwarding
  - D031: Workspace tool buttons (Filebrowser, KasmVNC, Code Server) open in new tabs — supersedes iframe-embed from M005
key_files:
  - src/components/app-sidebar.tsx — Central sidebar component with collapsible tree, session nesting, polling, error states, mode toggle, and refresh
  - src/app/templates/[name]/page.tsx — Template detail route server component
  - src/components/templates/TemplateDetailClient.tsx — Template detail client with push flow
  - src/hooks/use-sidebar-mode.ts — localStorage-backed sidebar mode preference hook
  - src/app/workspaces/[id]/terminal/terminal-client.tsx — Full-viewport terminal with keystroke exclusivity
  - src/app/workspaces/[id]/terminal/stale-entry-alert.tsx — CustomEvent bridge for stale entry recovery
  - src/components/workspaces/InteractiveTerminal.tsx — Auto-focus and click-to-refocus additions
  - src/lib/actions/templates.ts — listTemplateStatusesAction server action
  - src/app/layout.tsx — Header removed, floating SidebarTrigger repositioned
lessons_learned:
  - CustomEvent on window is an effective cross-component-tree communication pattern when React context can't span route boundaries — used for sidebar-terminal refresh bridge
  - Negative margin cancellation (-m-6 -mt-14) is a clean pattern for full-viewport pages within padded layouts — avoids layout prop drilling or conditional padding
  - Per-section independent state management (data/loading/error per section) prevents one failing API from blocking the entire sidebar
  - useRef for setInterval IDs prevents polling stacking caused by re-renders from usePathname() — important when components subscribe to route changes
  - Kill buttons placed outside SidebarMenuSubButton to avoid nested button HTML violations — a recurring accessibility concern with interactive list items
  - When deleting a component, also delete its test file to avoid test suite failures from missing imports
---

# M007: Sidebar Navigation Overhaul

**Restructured the Hive dashboard from flat sidebar + dedicated pages into a directory-tree sidebar with collapsible workspace/template sections, full-viewport terminal with keystroke exclusivity, and sidebar pin/unpin modes.**

## What Happened

M007 replaced the flat navigation sidebar and dedicated listing pages with a hierarchical directory-tree sidebar that serves as the single navigation and control surface for the Hive dashboard.

**S01 — Sidebar Tree Structure & Layout Overhaul** established the foundation: collapsible Workspaces and Templates sections using shadcn SidebarMenuSub/Collapsible primitives, fed by live Coder API data with 30-second polling. The global header and breadcrumbs were removed (HeaderContent.tsx deleted), replaced by a floating SidebarTrigger button. A footer with last-refreshed timestamp and manual refresh button was added. Per-section independent error states with inline Alert and retry buttons ensure one section failing doesn't block the other. 8 tests covered the new sidebar behavior.

**S02 — Terminal Integration & Session Management** nested terminal sessions under each workspace in the sidebar. Each workspace became a collapsible node containing: three external-link buttons (Filebrowser, KasmVNC, Code Server) using buildWorkspaceUrls() with lazy-fetched agent info, terminal sessions with 30s polling scoped to expanded workspaces, create (+) and kill (x) buttons for session CRUD, and navigation to the terminal page on session click. The terminal page was made full-viewport via negative margin cancellation (-m-6 -mt-14), with exclusive keystroke capture (stopPropagation on keydown, auto-focus on mount, click-to-refocus). A CustomEvent bridge (hive:sidebar-refresh) was created for cross-component-tree communication between terminal pages and sidebar for stale entry recovery. 10 new tests (7 sidebar + 3 integration) were added.

**S03 — Template Detail Page & Sidebar Polish** added the /templates/[name] detail page with template info display, staleness badge, and SSE push flow with TerminalPanel output streaming. The sidebar pin/unpin mode toggle was implemented via useSidebarMode hook with localStorage persistence and SSR safety. The old workspaces listing page was removed (page.tsx and WorkspacesClient.tsx deleted), and breadcrumb links updated to /tasks. Mobile responsive sidebar was confirmed working via shadcn's built-in useIsMobile() hook. 23 new tests were added across 2 new test suites.

Total: 21 files changed, 2045 insertions, 614 deletions, 462 passing tests (2 pre-existing failures unrelated to M007).

## Success Criteria Results

**All success criteria from the roadmap vision are met:**

1. **Directory-tree sidebar with collapsible sections** — ✅ Workspaces and Templates render as collapsible sections with SidebarMenuSub tree structure. Terminal sessions nested under workspaces. Verified by grep and 17 sidebar tests.

2. **Header and breadcrumbs removed from all pages** — ✅ No `<header>` tag in layout.tsx (grep returns 0). HeaderContent.tsx deleted. Floating SidebarTrigger is the only chrome.

3. **Terminal pages are full-viewport xterm with exclusive keystroke capture** — ✅ Negative margin cancellation for full-viewport sizing. stopPropagation on keydown. term.focus() on mount. Click-to-refocus. 3 integration tests verify.

4. **Sidebar supports floating (offcanvas) and docked (pinned) modes with toggle** — ✅ useSidebarMode hook with localStorage persistence. Pin/PinOff toggle in sidebar footer. 11 tests cover default mode, toggle, persistence, and SSR safety.

5. **Live data from Coder API with polling** — ✅ listWorkspacesAction and listTemplateStatusesAction called on mount and every 30s. Per-workspace session polling on expand.

6. **Session create/kill/switch from sidebar** — ✅ createSessionAction, killSessionAction, getWorkspaceSessionsAction all wired. Kill button outside SidebarMenuSubButton to avoid nested button violation.

7. **Stale entry recovery** — ✅ hive:sidebar-refresh CustomEvent dispatched on stale entry detection. Sidebar listens and re-fetches. Error Alert shown with back link.

8. **Template detail page** — ✅ /templates/[name] route with template info, staleness badge, and SSE push flow. 12 tests pass.

9. **Old workspaces page removed** — ✅ page.tsx and WorkspacesClient.tsx deleted. Breadcrumbs updated to /tasks. No remaining imports.

10. **Mobile responsive sidebar** — ✅ shadcn Sidebar renders as Sheet overlay via useIsMobile(). SidebarTrigger accessible on mobile.

## Definition of Done Results

- **All slices complete**: ✅ S01, S02, S03 all marked complete in DB with 10/10 tasks done
- **All slice summaries exist**: ✅ S01-SUMMARY.md, S02-SUMMARY.md, S03-SUMMARY.md all present
- **Cross-slice integration**: ✅ S02 reused S01's collapsible section pattern for workspace nesting. S03 reused S01's sidebar structure for mode toggle wiring. hive:sidebar-refresh event bridge works across S02 terminal pages and S01 sidebar listener. S03 template detail page navigable from S01's template section links.
- **Test suite passes**: ✅ 462 tests pass. 2 pre-existing failures (ResizeObserver in terminal-tab-refit and interactive-terminal-integration) documented in all 3 slice summaries as unrelated to M007.
- **No new TypeScript errors**: ✅ 0 errors in any M007 file (pre-existing errors in council-queues.ts, task-queue.ts unrelated)

## Requirement Outcomes

All 14 requirements owned by M007 are now validated:

| Req | Description | Status | Evidence |
|-----|-------------|--------|----------|
| R056 | Directory-tree sidebar with collapsible sections | validated | 8 tests, grep checks |
| R057 | External link buttons per workspace | validated → this milestone | grep + 17 sidebar tests |
| R058 | Session CRUD from sidebar | validated → this milestone | grep + 17 sidebar tests |
| R059 | Live data polling | validated | grep for setInterval + tests |
| R060 | Refresh timestamp and button | validated | test + grep |
| R061 | Sidebar mode toggle | validated | 11 tests in sidebar-mode-toggle.test.tsx |
| R062 | Header/breadcrumbs removed | validated | grep + file existence |
| R063 | Full-viewport terminal with keystroke exclusivity | validated → this milestone | 3 integration tests |
| R064 | Template detail page | validated | 12 tests in template-detail.test.tsx |
| R065 | Workspaces page removed | validated | file deletion + grep |
| R066 | Mobile responsive sidebar | validated | shadcn useIsMobile() built-in |
| R067 | Fetch failure inline errors | validated | 3 error-state tests |
| R068 | Stale entry recovery | validated → this milestone | 2 event bridge tests |
| R069 | Keystroke exclusivity integration tests | validated → this milestone | 3 integration tests |

## Deviations

StaleEntryAlert was extracted as a co-located client component instead of being inline in page.tsx (server components cannot use useEffect). Workspaces-client.test.tsx was deleted (not in original plan) because its test subject was removed. lucide-react mock in app-sidebar.test.tsx was updated (not in plan) to prevent 17 test regressions from Pin/PinOff icon additions. Link wrapping Button used for back navigation instead of asChild prop — project Button component doesn't support Radix asChild composition.

## Follow-ups

None.
