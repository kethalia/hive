---
estimated_steps: 32
estimated_files: 2
skills_used: []
---

# T02: Build /workspaces page with workspace list, status badges, tmux sessions, and external tool links

This task creates the UI for the workspaces page following the exact pattern of `/templates` — an async server component that fetches initial data, passing it to a client component that handles interaction and polling. The client component renders a workspace list with status badges (colored dots/pills based on workspace build status), click-to-expand panels showing tmux sessions for each workspace, and external tool link buttons.

## Steps

1. Create `src/app/workspaces/page.tsx` — async server component that imports CoderClient, fetches initial workspace list via `listWorkspacesAction`, catches errors and provides empty fallback, renders `<WorkspacesClient initialWorkspaces={workspaces} />`.
2. Create `src/components/workspaces/WorkspacesClient.tsx` — `'use client'` component:
   a. Props: `initialWorkspaces: CoderWorkspace[]`
   b. State: `workspaces` (initialized from props), `selectedWorkspaceId` (null initially), `sessions` (Map<string, TmuxSession[]>), `loadingSessions` (Set<string>), `error` (string | null)
   c. Render workspace list as a card grid or table. Each workspace card shows:
      - Workspace name (bold)
      - Template name (`template_display_name` or `template_name` fallback)
      - Status badge: colored dot + text based on `latest_build.status` (green=running, yellow=starting/stopping, red=failed, gray=stopped/deleted)
      - Last used timestamp (`last_used_at` formatted relative)
      - Owner name
   d. On workspace card click: set as selected, call `getWorkspaceSessionsAction({ workspaceId })` to lazy-load tmux sessions. Show loading spinner during fetch. Display sessions as a sub-list (session name, window count, created time). Show empty state message if no sessions or workspace not running.
   e. External tool links section for selected workspace: three buttons/links — Filebrowser (folder icon), KasmVNC (monitor icon), Coder Dashboard (external-link icon). Use `buildWorkspaceUrls()` from `src/lib/workspaces/urls.ts`. Links open in new tab (`target="_blank"`).
   f. Add a refresh button that re-calls `listWorkspacesAction` and updates the workspace list.
   g. Handle error states: show error banner if workspace list fails to load, show inline error if session fetch fails.
   h. For stopped/failed workspaces: disable session expand, show status-appropriate message.
3. Use existing UI components from `src/components/ui/` (Card, Button, Badge) where available. Use lucide-react icons for status indicators and tool links.
4. Style using Tailwind classes consistent with the existing app design.

## Must-Haves

- [ ] Server component fetches initial workspace data
- [ ] Client component renders workspace list with status badges
- [ ] Click-to-expand shows tmux sessions per workspace
- [ ] External tool links (Filebrowser, KasmVNC, Dashboard) present and correct
- [ ] Stopped/failed workspaces handled gracefully (no session expand)
- [ ] Error states shown for API failures
- [ ] Refresh button updates workspace list

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| listWorkspacesAction | Show error banner, keep stale data if available | safe-action timeout, show error | Empty workspace list with error message |
| getWorkspaceSessionsAction | Show inline error under workspace card | Show timeout message | Empty sessions array |

## Inputs

- ``src/lib/actions/workspaces.ts` — listWorkspacesAction and getWorkspaceSessionsAction server actions`
- ``src/lib/workspaces/urls.ts` — buildWorkspaceUrls utility for external tool links`
- ``src/lib/workspaces/sessions.ts` — TmuxSession type for session display`
- ``src/lib/coder/types.ts` — CoderWorkspace type for props`
- ``src/app/templates/page.tsx` — reference pattern for async server component`
- ``src/components/app-sidebar.tsx` — confirms Workspaces sidebar entry exists`

## Expected Output

- ``src/app/workspaces/page.tsx` — server component that fetches workspaces and renders WorkspacesClient`
- ``src/components/workspaces/WorkspacesClient.tsx` — client component with workspace list, status badges, tmux sessions, and external tool links`

## Verification

pnpm build && test -f src/app/workspaces/page.tsx && test -f src/components/workspaces/WorkspacesClient.tsx && grep -q 'WorkspacesClient' src/app/workspaces/page.tsx
