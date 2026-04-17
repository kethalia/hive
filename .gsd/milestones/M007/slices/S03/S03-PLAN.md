# S03: Template Detail Page & Sidebar Polish

**Goal:** Clicking a template in the sidebar opens a detail page with template info and push button. Sidebar supports pin/unpin mode toggle persisted in localStorage. Old workspaces listing page removed. Mobile-responsive sidebar verified.
**Demo:** Clicking a template in sidebar opens detail page with info and push button. Sidebar mode toggle (pin/unpin) with localStorage persistence. Mobile responsive sidebar. Old workspaces page removed.

## Must-Haves

- ## Must-Haves
- Template detail page at `/templates/[name]` shows template name, staleness badge, last pushed date, hash comparison, and Push button with inline TerminalPanel (R064)
- Sidebar mode toggle between offcanvas (floating) and icon (pinned) modes, persisted in localStorage (R061)
- Workspaces listing page (`/workspaces`) removed; breadcrumb links updated to point to `/tasks` instead (R065)
- Mobile sidebar renders as Sheet overlay on viewports below 768px; SidebarTrigger accessible on mobile (R066)
- ## Verification
- `pnpm vitest run src/__tests__/components/template-detail.test.tsx` — tests pass for template info rendering, push flow, and error states
- `pnpm vitest run src/__tests__/components/sidebar-mode-toggle.test.tsx` — tests pass for pin/unpin toggle and localStorage persistence
- `! test -f src/app/workspaces/page.tsx` — workspaces listing page deleted
- `pnpm tsc --noEmit 2>&1 | grep -c 'src/app/templates\|src/components/app-sidebar\|src/app/layout'` returns 0 — no type errors in changed files
- `pnpm vitest run` — no regressions in existing test suite

## Proof Level

- This slice proves: - This slice proves: integration (sidebar navigation → detail page → push action)
- Real runtime required: yes (push flow uses SSE streaming)
- Human/UAT required: yes (visual verification of sidebar modes and mobile overlay)

## Integration Closure

- Upstream surfaces consumed: `src/components/app-sidebar.tsx` (S01 sidebar structure), `src/components/templates/TemplatesClient.tsx` (push flow pattern), `src/components/ui/sidebar.tsx` (collapsible prop)
- New wiring introduced: `/templates/[name]` route, sidebar collapsible prop driven by localStorage, breadcrumb links updated from `/workspaces` to `/tasks`
- What remains before milestone is truly usable end-to-end: nothing — S03 completes the sidebar+navigation UX

## Verification

- Not provided.

## Tasks

- [x] **T01: Create template detail page with push flow** `est:45m`
  Create the `/templates/[name]` route that the sidebar template links already point to. The page shows template info (name, staleness badge, last pushed date, local/remote hash comparison, active version ID) and a Push button that triggers the same SSE push flow used in TemplatesClient.tsx. The push flow streams output into a TerminalPanel.

**Why:** R064 — sidebar template links currently 404. This is the core deliverable of the slice.

**Do:**
1. Create `src/app/templates/[name]/page.tsx` as a server component that calls `compareTemplates([params.name])` to get a single TemplateStatus, then renders `TemplateDetailClient`.
2. Create `src/components/templates/TemplateDetailClient.tsx` as a client component that:
   - Shows template name as h1, StatusBadge (stale/fresh), formatted lastPushed date, localHash, remoteHash, activeVersionId
   - Has a Push button that POSTs to `/api/templates/${name}/push`, gets jobId, opens EventSource at `/api/templates/${name}/push/${jobId}/stream`
   - Streams output lines into a dynamically imported TerminalPanel (ssr: false)
   - Shows push result (success/failure) with appropriate styling
   - Reuse the `formatDate` utility and `PushState` interface pattern from TemplatesClient.tsx
3. Use shadcn Card, Badge, Button components per project convention.
4. The `TemplateStatus` type from `src/lib/templates/staleness.ts` is the data contract.

**Done when:** Navigating to `/templates/hive` shows template info fields and a Push button. Clicking Push streams terminal output via SSE.
  - Files: `src/app/templates/[name]/page.tsx`, `src/components/templates/TemplateDetailClient.tsx`, `src/components/templates/TemplatesClient.tsx`, `src/lib/templates/staleness.ts`
  - Verify: pnpm tsc --noEmit 2>&1 | grep -c 'src/app/templates\|src/components/templates/TemplateDetail' | grep -q '^0$' && echo 'PASS: no type errors'

- [ ] **T02: Add sidebar mode toggle, remove workspaces listing, verify mobile** `est:35m`
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
  - Files: `src/hooks/use-sidebar-mode.ts`, `src/components/app-sidebar.tsx`, `src/app/workspaces/page.tsx`, `src/components/workspaces/WorkspacesClient.tsx`, `src/components/workspaces/TerminalBreadcrumbs.tsx`, `src/components/workspaces/WorkspaceToolPanel.tsx`
  - Verify: ! test -f src/app/workspaces/page.tsx && grep -q 'collapsible' src/components/app-sidebar.tsx && grep -q 'sidebar_mode' src/hooks/use-sidebar-mode.ts && grep -q '/tasks' src/components/workspaces/TerminalBreadcrumbs.tsx && echo 'PASS'

- [ ] **T03: Add test suites for template detail page and sidebar mode toggle** `est:30m`
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
  - Files: `src/__tests__/components/template-detail.test.tsx`, `src/__tests__/components/sidebar-mode-toggle.test.tsx`, `src/__tests__/components/terminal-breadcrumbs.test.tsx`
  - Verify: pnpm vitest run src/__tests__/components/template-detail.test.tsx src/__tests__/components/sidebar-mode-toggle.test.tsx src/__tests__/components/terminal-breadcrumbs.test.tsx

## Files Likely Touched

- src/app/templates/[name]/page.tsx
- src/components/templates/TemplateDetailClient.tsx
- src/components/templates/TemplatesClient.tsx
- src/lib/templates/staleness.ts
- src/hooks/use-sidebar-mode.ts
- src/components/app-sidebar.tsx
- src/app/workspaces/page.tsx
- src/components/workspaces/WorkspacesClient.tsx
- src/components/workspaces/TerminalBreadcrumbs.tsx
- src/components/workspaces/WorkspaceToolPanel.tsx
- src/__tests__/components/template-detail.test.tsx
- src/__tests__/components/sidebar-mode-toggle.test.tsx
- src/__tests__/components/terminal-breadcrumbs.test.tsx
