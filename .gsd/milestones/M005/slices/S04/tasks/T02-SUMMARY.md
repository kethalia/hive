---
id: T02
parent: S04
milestone: M005
key_files:
  - src/app/workspaces/[id]/page.tsx
  - src/components/workspaces/WorkspacesClient.tsx
key_decisions:
  - Used breadcrumb-style navigation (Workspaces / Name) instead of a standalone back button for better UX context
  - Wrapped workspace name in Link with stopPropagation rather than making the entire card a link, preserving the existing expand/collapse behavior
duration: 
verification_result: passed
completed_at: 2026-04-14T11:42:43.346Z
blocker_discovered: false
---

# T02: Create workspace detail page route at /workspaces/[id] with WorkspaceToolPanel and wire list page navigation via Link on workspace names

**Create workspace detail page route at /workspaces/[id] with WorkspaceToolPanel and wire list page navigation via Link on workspace names**

## What Happened

Created the `/workspaces/[id]/page.tsx` async server component following the established pattern from the terminal page. The page awaits params, fetches workspace data and agent info in parallel via `Promise.all([getWorkspaceAction, getWorkspaceAgentAction])`, renders an error state if the workspace isn't found (with a back-link), and falls back to agent name `'main'` if no agent is discovered. The page passes workspace, agentName, and coderUrl to WorkspaceToolPanel from T01. A breadcrumb-style back-link to `/workspaces` sits at the top.

Updated `WorkspacesClient.tsx` to import `Link` from `next/link` and wrapped the workspace name text in a `<Link href={/workspaces/${ws.id}}>` with `e.stopPropagation()` to prevent the card's expand/collapse handler from intercepting the click. All existing tool link buttons (Filebrowser, KasmVNC, Dashboard, Terminal) remain as quick-access shortcuts on the list page.

## Verification

All four verification checks passed: detail page file exists, uses WorkspaceToolPanel component, list page contains link to detail route, and `pnpm build` succeeds with `/workspaces/[id]` listed as a dynamic route.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `test -f src/app/workspaces/[id]/page.tsx` | 0 | ✅ pass | 10ms |
| 2 | `grep -q 'WorkspaceToolPanel' src/app/workspaces/[id]/page.tsx` | 0 | ✅ pass | 10ms |
| 3 | `grep -q '/workspaces/' src/components/workspaces/WorkspacesClient.tsx` | 0 | ✅ pass | 10ms |
| 4 | `pnpm build` | 0 | ✅ pass | 12000ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/app/workspaces/[id]/page.tsx`
- `src/components/workspaces/WorkspacesClient.tsx`
