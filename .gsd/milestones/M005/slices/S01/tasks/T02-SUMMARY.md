---
id: T02
parent: S01
milestone: M005
key_files:
  - src/app/workspaces/page.tsx
  - src/components/workspaces/WorkspacesClient.tsx
  - src/app/tasks/page.tsx
key_decisions:
  - Used custom status badge spans instead of Badge component to avoid variant color conflicts with dynamic status colors
  - Added force-dynamic to /tasks page to fix unrelated build failure from Prisma DB unavailability at build time
  - Tool links use NEXT_PUBLIC_CODER_URL env var on client side with hardcoded agent name 'main' since agent discovery requires server action
duration: 
verification_result: passed
completed_at: 2026-04-14T10:54:06.173Z
blocker_discovered: false
---

# T02: Build /workspaces page with workspace list, status badges, tmux sessions, and external tool links

**Build /workspaces page with workspace list, status badges, tmux sessions, and external tool links**

## What Happened

Created the /workspaces page following the templates page pattern — async server component fetching initial data, passing to a client component for interaction.

**Server component** (`src/app/workspaces/page.tsx`): Calls `listWorkspacesAction()` with error handling (catches and logs, falls back to empty array). Uses `force-dynamic` to skip prerendering since it depends on the Coder API.

**Client component** (`src/components/workspaces/WorkspacesClient.tsx`): Renders workspace cards in a grid with:
- Status badges: colored dot + label mapped from `latest_build.status` (green=running, yellow=starting/stopping, red=failed, gray=stopped/deleted/canceled)
- Workspace metadata: template name, owner, relative last-used time
- Click-to-expand tmux sessions: lazy-loads via `getWorkspaceSessionsAction`, shows session name, window count, creation time. Only expandable for running/starting workspaces.
- External tool links: Filebrowser, KasmVNC, Coder Dashboard buttons (visible for running workspaces, open in new tab)
- Refresh button to re-fetch workspace list
- Error handling: error banner for list failures, inline error for session fetch failures, empty state for no workspaces

**Build fix**: Added `export const dynamic = "force-dynamic"` to `/tasks` page to prevent prerender failure when Prisma DB is unreachable at build time.

## Verification

- `pnpm build` passes successfully with /workspaces route listed as dynamic
- `test -f src/app/workspaces/page.tsx` confirms page file exists
- `test -f src/components/workspaces/WorkspacesClient.tsx` confirms client component exists
- `grep -q 'WorkspacesClient' src/app/workspaces/page.tsx` confirms proper import/usage

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm build` | 0 | ✅ pass | 12000ms |
| 2 | `test -f src/app/workspaces/page.tsx` | 0 | ✅ pass | 10ms |
| 3 | `test -f src/components/workspaces/WorkspacesClient.tsx` | 0 | ✅ pass | 10ms |
| 4 | `grep -q 'WorkspacesClient' src/app/workspaces/page.tsx` | 0 | ✅ pass | 10ms |

## Deviations

Added `export const dynamic = 'force-dynamic'` to src/app/tasks/page.tsx — this was not in the task plan but was required to fix the build, which was failing due to Prisma DB being unreachable during static prerendering of /tasks.

## Known Issues

External tool links use hardcoded agent name 'main' — a future enhancement could fetch the actual agent name via server action. Tool links only appear when NEXT_PUBLIC_CODER_URL is set.

## Files Created/Modified

- `src/app/workspaces/page.tsx`
- `src/components/workspaces/WorkspacesClient.tsx`
- `src/app/tasks/page.tsx`
