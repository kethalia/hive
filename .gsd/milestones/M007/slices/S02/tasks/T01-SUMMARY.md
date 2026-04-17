---
id: T01
parent: S02
milestone: M007
key_files:
  - src/components/app-sidebar.tsx
  - src/__tests__/components/app-sidebar.test.tsx
key_decisions:
  - Moved kill-session button outside SidebarMenuSubButton to avoid nested button HTML violation
  - Agent info cached in component state keyed by workspace ID — fetched once on first expand, not re-fetched
  - Session polling uses per-workspace intervals tracked in a ref map, cleared on collapse
duration: 
verification_result: passed
completed_at: 2026-04-17T05:19:11.711Z
blocker_discovered: false
---

# T01: Nest terminal sessions and external-link buttons under each workspace in sidebar with lazy fetch, polling, and CRUD

**Nest terminal sessions and external-link buttons under each workspace in sidebar with lazy fetch, polling, and CRUD**

## What Happened

Transformed each workspace in the sidebar from a flat `SidebarMenuSubItem` into a nested `Collapsible` containing:

1. **Workspace trigger** — name + status badge as the collapsible trigger with chevron rotation.
2. **External links row** — three icon buttons (Filebrowser, KasmVNC, Code Server) rendered only when agent info is available and `coderUrl` is provided. Uses `buildWorkspaceUrls()` with lazy-fetched agent name.
3. **Session list** — terminal sessions fetched via `getWorkspaceSessionsAction` on first expand, displayed as `SidebarMenuSubItem` entries linking to `/workspaces/[id]/terminal?session=<name>`. Each session has a kill button (X icon) that calls `killSessionAction`.
4. **Create session button** — "+" button at bottom calls `createSessionAction` and navigates to the terminal page.
5. **Error handling** — inline Alert with retry button for session fetch failures; agent fetch failures hide external links gracefully.
6. **Polling** — 30s interval per expanded workspace, cleared on collapse or unmount.

State management uses three `Record`-keyed state maps: `expandedWorkspaces`, `workspaceAgents` (cached), and `workspaceSessions` (with loading/error states). The kill button was moved outside `SidebarMenuSubButton` to avoid nested `<button>` HTML violation.

Extended test suite with 7 new tests covering: expand triggers fetch, sessions render, external links render with correct hrefs, create session calls action + navigates, kill session calls action, session fetch error shows alert, and agent fetch failure hides external links.

## Verification

Ran `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — all 15 tests pass (8 existing + 7 new). Verified grep checks for all four required imports (getWorkspaceSessionsAction, buildWorkspaceUrls, createSessionAction, killSessionAction) in app-sidebar.tsx.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` | 0 | ✅ pass | 1330ms |
| 2 | `grep -q 'getWorkspaceSessionsAction' src/components/app-sidebar.tsx` | 0 | ✅ pass | 5ms |
| 3 | `grep -q 'buildWorkspaceUrls' src/components/app-sidebar.tsx` | 0 | ✅ pass | 5ms |
| 4 | `grep -q 'createSessionAction' src/components/app-sidebar.tsx` | 0 | ✅ pass | 5ms |
| 5 | `grep -q 'killSessionAction' src/components/app-sidebar.tsx` | 0 | ✅ pass | 5ms |

## Deviations

Moved kill button outside SidebarMenuSubButton into a sibling div to avoid nested button elements (React warning). This is a minor structural change from the plan's inline placement.

## Known Issues

None

## Files Created/Modified

- `src/components/app-sidebar.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`
