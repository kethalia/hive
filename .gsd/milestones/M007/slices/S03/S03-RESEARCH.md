## Summary

S03 covers four requirements: sidebar mode toggle (R061), template detail page (R064), removing the workspaces listing page (R065), and mobile-responsive sidebar (R066). Research shows the shadcn sidebar primitives already support all needed behaviors — the `Sidebar` component accepts a `collapsible` prop ("offcanvas" | "icon" | "none") and mobile is handled automatically via a Sheet overlay when `useIsMobile()` returns true. The template detail page is a new route (`/templates/[name]`) that can reuse the push logic and TerminalPanel from `TemplatesClient.tsx`. The workspaces listing page is a thin wrapper that can be safely removed since the sidebar already serves as the workspace browser.

## Recommendation

Build in three steps: (1) template detail page, (2) sidebar mode toggle with localStorage persistence, (3) remove workspaces listing page. Mobile responsiveness (R066) is largely already handled by the shadcn Sidebar primitive — it renders as a Sheet overlay on viewports below 768px. Minor polish may be needed to ensure the SidebarTrigger is accessible on mobile.

## Implementation Landscape

### Key Files

**Existing files to modify:**
- `src/app/layout.tsx` — Pass `collapsible` prop to `<Sidebar>` based on localStorage preference; currently uses `<SidebarProvider>` with no collapsible configuration, defaulting to "offcanvas"
- `src/components/app-sidebar.tsx` — Add pin/unpin toggle button in SidebarFooter; template links already point to `/templates/${tpl.name}` (the detail route we need to create)
- `src/components/ui/sidebar.tsx` — No changes needed; already supports `collapsible` prop on `<Sidebar>` ("offcanvas" | "icon" | "none") and mobile Sheet overlay via `useIsMobile()`

**New files to create:**
- `src/app/templates/[name]/page.tsx` — Template detail page (server component, fetches single template status)
- `src/components/templates/TemplateDetailClient.tsx` — Client component for template detail: shows template info fields (name, staleness badge, lastPushed, localHash, remoteHash, activeVersionId) and a Push button with TerminalPanel (reuse push logic from `TemplatesClient.tsx`)

**Files to remove:**
- `src/app/workspaces/page.tsx` — Workspaces listing page (R065 says sidebar is the workspace browser)
- `src/components/workspaces/WorkspacesClient.tsx` — Client component for removed listing page (check if anything else imports it first)

**Files to keep (workspace detail still needed):**
- `src/app/workspaces/[id]/page.tsx` — Redirects to terminal, still valid
- `src/app/workspaces/[id]/terminal/page.tsx` — Terminal page, still valid

### Existing Patterns to Reuse

1. **Push flow** from `TemplatesClient.tsx` (lines 115-195): `POST /api/templates/${name}/push`, then SSE stream via `/api/templates/${name}/push/${jobId}/stream`. Extract into a shared hook or duplicate for the detail page.
2. **TerminalPanel** dynamic import pattern (line 20-23): `dynamic(() => import("./TerminalPanel"), { ssr: false })`
3. **StatusBadge** component (lines 322-360): Reuse for template detail page header
4. **TemplateStatus interface**: `{ name, stale, lastPushed, activeVersionId, localHash, remoteHash }`
5. **`compareTemplates`** from `src/lib/templates/staleness.ts`: Can be called with a single template name for the detail page

### Sidebar Mode Toggle Design (R061, D028)

The shadcn `<Sidebar>` component already accepts `collapsible` with values:
- `"offcanvas"` — sidebar slides off-screen when collapsed (current default, maps to "floating" in D028)
- `"icon"` — sidebar collapses to icon-only rail (maps to "docked/pinned" in D028)
- `"none"` — always visible, no collapse

Implementation approach:
1. Create a `useSidebarMode()` hook that reads/writes `localStorage` key (e.g. `"sidebar_mode"`) with values `"offcanvas"` or `"icon"`
2. In `app-sidebar.tsx`, read the mode and pass it as the `collapsible` prop to `<Sidebar collapsible={mode}>`
3. Add a Pin/Unpin toggle button in `SidebarFooter` (next to Settings) using `PinIcon`/`PinOffIcon` from lucide-react
4. Default to `"offcanvas"` per D028

### Mobile Responsiveness (R066)

Already handled by shadcn primitives:
- `useIsMobile()` in `src/hooks/use-mobile.ts` triggers at 768px breakpoint
- When `isMobile` is true, the `Sidebar` component renders inside a `<Sheet>` (overlay mode) automatically
- `SidebarProvider.toggleSidebar()` calls `setOpenMobile()` on mobile
- The `SidebarTrigger` (currently `fixed top-3 left-3 z-50` in layout.tsx) is visible on mobile

Only polish needed: verify that the trigger button doesn't overlap content on small screens, and that the Sheet closes on route navigation (sidebar links already use Next.js `<Link>`).

### Build Order

1. **Template detail page (R064)** — Create `/templates/[name]/page.tsx` + `TemplateDetailClient.tsx`. Extract or duplicate push flow from `TemplatesClient.tsx`. Show: template name as heading, staleness badge, last pushed date, hash comparison, Push button with inline TerminalPanel. This unblocks sidebar template links that already point to `/templates/${tpl.name}`.

2. **Sidebar mode toggle (R061)** — Add `useSidebarMode` hook, wire `collapsible` prop on `<Sidebar>`, add Pin/Unpin button in footer. Persist to localStorage.

3. **Remove workspaces listing (R065)** — Delete `src/app/workspaces/page.tsx`. Either redirect `/workspaces` to `/tasks` or remove the route entirely. Verify no other code links to `/workspaces` (sidebar links go to `/workspaces/${ws.id}` which is kept).

4. **Mobile polish (R066)** — Verify Sheet overlay behavior, test SidebarTrigger positioning, ensure route changes close mobile sidebar. Mostly verification since primitives already handle it.

### Verification Approach

- **R064**: Navigate to `/templates/hive` — see template info fields and Push button. Click Push, verify terminal output streams. Verify sidebar link highlights active template.
- **R061**: Click pin button — sidebar stays visible and collapses to icon rail. Click unpin — sidebar returns to offcanvas mode. Refresh page — preference persists.
- **R065**: Navigate to `/workspaces` — should redirect (not show old listing). Sidebar workspace links still work.
- **R066**: Resize browser below 768px — sidebar becomes Sheet overlay. Trigger button opens/closes it. Clicking a link closes the overlay.
