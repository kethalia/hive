---
estimated_steps: 12
estimated_files: 6
skills_used: []
---

# T02: Add sidebar mode toggle, remove workspaces listing, verify mobile

Wire the shadcn Sidebar `collapsible` prop to a localStorage-backed preference, add pin/unpin toggle in sidebar footer, remove the old workspaces listing page, and update breadcrumb links.

**Why:** R061 (sidebar mode toggle), R065 (remove workspaces listing), R066 (mobile responsive sidebar).

**Do:**
1. Create `src/hooks/use-sidebar-mode.ts` — a hook that reads/writes localStorage key `sidebar_mode` with values `"offcanvas"` (default) or `"icon"`. Returns `[mode, toggleMode]`. Must handle SSR (default to offcanvas when window is undefined).
2. In `src/components/app-sidebar.tsx`:
   - Import `useSidebarMode` and pass `mode` as `collapsible` prop to `<Sidebar>`
   - Add a Pin/Unpin toggle button in SidebarFooter using `Pin`/`PinOff` icons from lucide-react, placed next to the refresh button
   - The button calls `toggleMode()` on click
3. Delete `src/app/workspaces/page.tsx` and `src/components/workspaces/WorkspacesClient.tsx`.
4. Update breadcrumb links in `src/components/workspaces/TerminalBreadcrumbs.tsx` and `src/components/workspaces/WorkspaceToolPanel.tsx` — change `/workspaces` href to `/tasks`.
5. R066 verification: the shadcn Sidebar already renders as Sheet overlay when `useIsMobile()` returns true. The floating SidebarTrigger is already accessible. No code changes needed for mobile — just verify in tests.

**Done when:** Pin button toggles sidebar between offcanvas and icon modes, preference persists across page reloads. `/workspaces` route no longer exists. Breadcrumbs link to `/tasks`.

## Inputs

- ``src/components/app-sidebar.tsx` — current sidebar with footer (S01 output, needs pin/unpin button and collapsible prop)`
- ``src/components/ui/sidebar.tsx` — Sidebar component accepts collapsible prop ('offcanvas' | 'icon' | 'none')`
- ``src/hooks/use-mobile.ts` — pattern reference for window-based hook with SSR safety`
- ``src/app/workspaces/page.tsx` — file to delete`
- ``src/components/workspaces/WorkspacesClient.tsx` — file to delete`
- ``src/components/workspaces/TerminalBreadcrumbs.tsx` — breadcrumb link to update from /workspaces to /tasks`
- ``src/components/workspaces/WorkspaceToolPanel.tsx` — breadcrumb link to update from /workspaces to /tasks`

## Expected Output

- ``src/hooks/use-sidebar-mode.ts` — new hook for localStorage-backed sidebar mode preference`
- ``src/components/app-sidebar.tsx` — modified with collapsible prop and pin/unpin toggle button`
- ``src/components/workspaces/TerminalBreadcrumbs.tsx` — breadcrumb link updated to /tasks`
- ``src/components/workspaces/WorkspaceToolPanel.tsx` — breadcrumb link updated to /tasks`

## Verification

! test -f src/app/workspaces/page.tsx && grep -q 'collapsible' src/components/app-sidebar.tsx && grep -q 'sidebar_mode' src/hooks/use-sidebar-mode.ts && grep -q '/tasks' src/components/workspaces/TerminalBreadcrumbs.tsx && echo 'PASS'
