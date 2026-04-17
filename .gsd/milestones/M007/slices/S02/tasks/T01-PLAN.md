---
estimated_steps: 84
estimated_files: 2
skills_used: []
---

# T01: Nest terminal sessions and external-link buttons under each workspace in sidebar

---
estimated_steps: 6
estimated_files: 5
skills_used: []
---

# T01: Nest terminal sessions and external-link buttons under each workspace in sidebar

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

Make each workspace in the sidebar a nested Collapsible that shows terminal sessions and external-link buttons. This delivers R057 (external links for Filebrowser, KasmVNC, Code Server) and R058 (session list/create/kill from sidebar).

Currently each workspace is a flat `SidebarMenuSubItem` with just a name and status badge. It needs to become a nested `Collapsible` containing: (1) the workspace name + badge as the trigger, (2) three external-link icon buttons, (3) a list of terminal sessions fetched via `getWorkspaceSessionsAction`, (4) a "+" button to create sessions, and (5) an "x" button per session to kill it.

**Agent name challenge:** `buildWorkspaceUrls()` requires `agentName` which is not on `CoderWorkspace`. Use `getWorkspaceAgentAction` to lazy-fetch agent info when a workspace collapsible is first expanded. Cache the result in component state keyed by workspace ID.

**Session polling:** Fetch sessions per-workspace when expanded, not globally. Use 30s polling scoped to expanded workspaces only, matching the S01 pattern.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| `getWorkspaceAgentAction` | Show inline error in workspace collapsible, disable external links | Same as error — agent info unavailable | Return null, skip external links |
| `getWorkspaceSessionsAction` | Show inline "Failed to load sessions" with retry | Same as error | Return empty array |
| `createSessionAction` | Show toast/alert, don't navigate | Same as error | Don't navigate |
| `killSessionAction` | Show toast/alert, don't remove from list | Same as error | Don't remove from list |

## Negative Tests

- **Malformed inputs**: Workspace with no agent (agent fetch returns error) — external links hidden, sessions show error
- **Error paths**: Session fetch failure — inline error with retry button, doesn't affect other workspaces
- **Boundary conditions**: Zero sessions — show only "+" button, no session list. Workspace stopped/offline — external links still render (URLs are valid, target app may be down)

## Steps

1. Add imports to `app-sidebar.tsx`: `useRouter` from `next/navigation`, `getWorkspaceAgentAction`, `getWorkspaceSessionsAction`, `createSessionAction`, `killSessionAction` from `@/lib/actions/workspaces`, `buildWorkspaceUrls` from `@/lib/workspaces/urls`, `TmuxSession` from `@/lib/workspaces/sessions`, and new lucide icons (`Terminal`, `Plus`, `X`, `FolderOpen`, `Monitor as ScreenIcon`, `Code`). Add `ExternalLink` icon for the link buttons.

2. Add state management for per-workspace expansion and data:
   - `expandedWorkspaces: Record<string, boolean>` — tracks which workspaces are expanded
   - `workspaceAgents: Record<string, { agentId: string; agentName: string } | null>` — cached agent info per workspace
   - `workspaceSessions: Record<string, { data: TmuxSession[]; isLoading: boolean; error: string | null }>` — sessions per workspace
   - `fetchAgentInfo(workspaceId: string)` — calls `getWorkspaceAgentAction`, caches result
   - `fetchSessions(workspaceId: string)` — calls `getWorkspaceSessionsAction`, updates state
   - `handleWorkspaceExpand(workspaceId: string, open: boolean)` — on first expand, fetch agent + sessions

3. Add per-workspace session polling: `useEffect` that sets up 30s intervals for each expanded workspace. Use a ref map to track interval IDs. Clear intervals when workspaces collapse or component unmounts.

4. Replace the flat workspace list with nested Collapsibles. Each workspace becomes:
   ```
   Collapsible (onOpenChange → handleWorkspaceExpand)
     CollapsibleTrigger: workspace name + status badge
     CollapsibleContent:
       - External links row: 3 icon buttons (Filebrowser, KasmVNC, Code Server) — each `<a href={url} target="_blank">`
       - SidebarMenuSub with sessions:
         - Each session: SidebarMenuSubItem linking to `/workspaces/[id]/terminal?session=<name>` with "x" kill button
         - "+" button at bottom to create new session
       - Error state: Alert with retry if session fetch failed
       - Loading state: "Loading sessions..." text
   ```

5. Implement create session handler: call `createSessionAction({ workspaceId })`, then `router.push(`/workspaces/${workspaceId}/terminal?session=${result.data.name}`)`. Re-fetch sessions after creation.

6. Implement kill session handler: call `killSessionAction({ workspaceId, sessionName })`, then remove from local state. Re-fetch sessions to confirm.

7. Extend `app-sidebar.test.tsx` with new tests:
   - Mock `getWorkspaceAgentAction`, `getWorkspaceSessionsAction`, `createSessionAction`, `killSessionAction`
   - Test: expanding a workspace triggers agent + session fetch
   - Test: sessions render as sub-items under workspace
   - Test: external link buttons render with correct href targets
   - Test: "+" button calls createSessionAction
   - Test: "x" button calls killSessionAction
   - Test: session fetch error shows inline alert with retry

## Must-Haves

- [ ] Each workspace is a Collapsible with nested sessions
- [ ] Three external-link buttons per workspace (Filebrowser, KasmVNC, Code Server)
- [ ] Sessions fetched lazily on workspace expand
- [ ] "+" creates session and navigates to terminal page
- [ ] "x" kills session and removes from list
- [ ] Session items link to `/workspaces/[id]/terminal?session=<name>`
- [ ] Agent info lazy-fetched and cached per workspace
- [ ] 30s polling for sessions of expanded workspaces
- [ ] Error state with retry for failed session fetches
- [ ] All existing sidebar tests still pass
- [ ] New tests cover session nesting, external links, create/kill

## Verification

- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — all tests pass (existing + new)
- `grep -q 'getWorkspaceSessionsAction' src/components/app-sidebar.tsx`
- `grep -q 'buildWorkspaceUrls' src/components/app-sidebar.tsx`
- `grep -q 'createSessionAction' src/components/app-sidebar.tsx`
- `grep -q 'killSessionAction' src/components/app-sidebar.tsx`

## Inputs

- `src/components/app-sidebar.tsx` — S01 sidebar with flat workspace list to extend
- `src/__tests__/components/app-sidebar.test.tsx` — existing test suite to extend
- `src/lib/actions/workspaces.ts` — server actions for session CRUD (getWorkspaceAgentAction, getWorkspaceSessionsAction, createSessionAction, killSessionAction)
- `src/lib/workspaces/urls.ts` — buildWorkspaceUrls function for external link URLs
- `src/lib/workspaces/sessions.ts` — TmuxSession type
- `src/lib/coder/types.ts` — CoderWorkspace type (has owner_name field)

## Expected Output

- `src/components/app-sidebar.tsx` — workspace items now Collapsible with nested sessions, external links, create/kill buttons
- `src/__tests__/components/app-sidebar.test.tsx` — extended with 6+ new tests for session nesting, external links, CRUD

## Inputs

- `src/components/app-sidebar.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`
- `src/lib/actions/workspaces.ts`
- `src/lib/workspaces/urls.ts`
- `src/lib/workspaces/sessions.ts`
- `src/lib/coder/types.ts`

## Expected Output

- `src/components/app-sidebar.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`

## Verification

pnpm vitest run src/__tests__/components/app-sidebar.test.tsx
