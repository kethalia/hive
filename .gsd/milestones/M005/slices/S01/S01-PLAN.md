# S01: Workspace Discovery & Listing

**Goal:** User opens /workspaces, sees all their Coder workspaces with live status badges, clicks into one and sees its tmux sessions listed, with external tool links (Filebrowser, KasmVNC, Coder dashboard) for each workspace.
**Demo:** User opens /workspaces, sees all their Coder workspaces with live status badges, clicks into one and sees its tmux sessions listed

## Must-Haves

- `pnpm build` passes with no type errors
- `pnpm vitest run src/__tests__/lib/workspaces/` — all new tests pass
- `pnpm vitest run` — no regressions in existing tests
- Navigate to `/workspaces` — workspace list renders with status badges
- Click a workspace — tmux sessions load (or empty state for stopped workspaces)
- External tool links (Filebrowser, KasmVNC, Dashboard) are present and correctly constructed
- Sidebar shows "Workspaces" nav entry linking to `/workspaces`

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (Coder API must be reachable for live data)
- Human/UAT required: yes (visual verification of workspace list and interaction)

## Integration Closure

- Upstream surfaces consumed: `src/lib/coder/client.ts` (CoderClient.listWorkspaces, getWorkspaceResources, getWorkspaceAgentName), `src/lib/coder/types.ts` (CoderWorkspace, WorkspaceAgent), `src/lib/workspace/exec.ts` (execInWorkspace for tmux listing), `src/lib/safe-action.ts` (actionClient)
- New wiring introduced in this slice: `/workspaces` route, server actions for workspace listing and tmux session discovery, sidebar nav entry
- What remains before the milestone is truly usable end-to-end: S02 (interactive terminal sessions via PTY WebSocket), S03+ (workspace detail page with embedded tools)

## Verification

- Runtime signals: console.log from CoderClient on API errors, server action errors surfaced via next-safe-action error handler
- Inspection surfaces: `/workspaces` page shows workspace count and statuses; server action errors visible in Next.js server logs
- Failure visibility: API connection failures show error state in UI; tmux exec failures show empty session list with logged stderr
- Redaction constraints: CODER_SESSION_TOKEN must never reach the browser — server actions only

## Tasks

- [x] **T01: Extend Coder types, build server actions, add sidebar entry and URL utilities** `est:45m`
  This task sets up the entire data layer for the workspaces page. It extends the CoderWorkspace and WorkspaceAgent types with fields needed for status badges and display (template_display_name, template_icon, last_used_at, health). It creates server actions using the established next-safe-action pattern: listWorkspacesAction (wraps CoderClient.listWorkspaces with owner:me filter) and getWorkspaceSessionsAction (resolves workspace agent name via CoderClient, then runs `tmux list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'` via execInWorkspace). It adds a workspace URL builder utility that constructs external tool URLs (Filebrowser, KasmVNC, Coder dashboard) from CODER_URL and workspace metadata. Finally, it adds the 'Workspaces' entry to the sidebar navItems array.

## Steps

1. Extend `CoderWorkspace` interface in `src/lib/coder/types.ts`: add `template_name?: string`, `template_display_name?: string`, `template_icon?: string`, `last_used_at?: string`, `health?: { healthy: boolean; failing_agents: string[] }`. Make them optional so existing code isn't broken.
2. Refine `WorkspaceAgent.status` from `string` to the union type `'connected' | 'connecting' | 'disconnected' | 'timeout' | 'lifecycle_ready' | 'starting' | 'start_error' | 'shutting_down' | 'shutdown_error' | 'off'` (the actual Coder agent lifecycle statuses).
3. Create `src/lib/workspaces/urls.ts` — export `buildWorkspaceUrls(workspace, agentName, coderUrl)` that returns `{ filebrowser: string, kasmvnc: string, dashboard: string }`. Parse the base domain from `CODER_URL` (strip protocol, use as coder_host). Filebrowser: `https://filebrowser--{agent}--{workspace}--{owner}.{coder_host}`. KasmVNC: same pattern with `kasmvnc` slug. Dashboard: `{CODER_URL}/@{owner}/{workspace}`.
4. Create `src/lib/workspaces/sessions.ts` — export `parseTmuxSessions(stdout: string): TmuxSession[]` that parses the `tmux list-sessions -F` output format. Export the `TmuxSession` type: `{ name: string; created: number; windows: number }`.
5. Create `src/lib/actions/workspaces.ts` — two server actions using actionClient from safe-action:
   - `listWorkspacesAction`: no input schema needed, calls `new CoderClient({baseUrl: process.env.CODER_URL!, sessionToken: process.env.CODER_SESSION_TOKEN!}).listWorkspaces({owner: 'me'})`, returns the workspaces array.
   - `getWorkspaceSessionsAction`: input schema `{ workspaceId: string }`, calls `getWorkspaceResources` to find agent, then `execInWorkspace` with `tmux list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'`, parses output with `parseTmuxSessions`, returns sessions array. Handles stopped workspace (agent not running) gracefully by returning empty array.
6. Add sidebar entry in `src/components/app-sidebar.tsx`: import `Monitor` from lucide-react, add `{ title: 'Workspaces', href: '/workspaces', icon: Monitor }` to navItems array after 'Templates'.

## Must-Haves

- [ ] CoderWorkspace type extended with optional display fields
- [ ] WorkspaceAgent.status typed as union, not bare string
- [ ] URL builder correctly constructs Filebrowser, KasmVNC, and dashboard URLs
- [ ] tmux session parser handles empty output, single session, multiple sessions
- [ ] Server actions use actionClient pattern from safe-action
- [ ] CODER_SESSION_TOKEN never appears in client-accessible code
- [ ] Sidebar shows Workspaces link

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder API (listWorkspaces) | Return error via safe-action handler | CoderClient throws after fetch timeout | JSON parse fails, error propagated |
| execInWorkspace (tmux) | Return empty sessions array | ExecResult with exitCode 124, return empty | parseTmuxSessions returns empty for unparseable lines |

## Negative Tests

- Malformed inputs: empty workspaceId for sessions action
- Error paths: Coder API unreachable, workspace has no agents, tmux not running (exit code 1)
- Boundary conditions: zero workspaces, workspace with no agents, empty tmux output
  - Files: `src/lib/coder/types.ts`, `src/lib/workspaces/urls.ts`, `src/lib/workspaces/sessions.ts`, `src/lib/actions/workspaces.ts`, `src/components/app-sidebar.tsx`
  - Verify: pnpm build && grep -q 'Workspaces' src/components/app-sidebar.tsx && test -f src/lib/actions/workspaces.ts && test -f src/lib/workspaces/urls.ts && test -f src/lib/workspaces/sessions.ts

- [x] **T02: Build /workspaces page with workspace list, status badges, tmux sessions, and external tool links** `est:1h`
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
  - Files: `src/app/workspaces/page.tsx`, `src/components/workspaces/WorkspacesClient.tsx`
  - Verify: pnpm build && test -f src/app/workspaces/page.tsx && test -f src/components/workspaces/WorkspacesClient.tsx && grep -q 'WorkspacesClient' src/app/workspaces/page.tsx

- [ ] **T03: Add tests for workspace URL builder, tmux session parser, and server actions** `est:30m`
  This task adds unit tests covering the data layer introduced in T01. Tests follow the existing pattern in `src/__tests__/lib/coder/client.test.ts` — using vitest with vi.fn() for fetch mocking. The tests cover the URL builder, tmux session parser, and server action error handling.

## Steps

1. Create `src/__tests__/lib/workspaces/urls.test.ts`:
   - Test `buildWorkspaceUrls` with standard inputs: workspace name, owner, agent name, CODER_URL
   - Test URL construction for each tool: filebrowser follows `https://filebrowser--{agent}--{workspace}--{owner}.{coder_host}` pattern
   - Test with CODER_URL that has trailing slash
   - Test with CODER_URL that has path prefix
   - Test dashboard URL is `{CODER_URL}/@{owner}/{workspace}`

2. Create `src/__tests__/lib/workspaces/sessions.test.ts`:
   - Test `parseTmuxSessions` with single session line: `main:1712345678:3` → `{ name: 'main', created: 1712345678, windows: 3 }`
   - Test with multiple sessions (multi-line input)
   - Test with empty string input → empty array
   - Test with malformed lines (missing fields, non-numeric) → skipped gracefully
   - Test with trailing newline

3. Create `src/__tests__/lib/workspaces/actions.test.ts`:
   - Mock CoderClient and execInWorkspace
   - Test listWorkspacesAction returns workspace list from CoderClient
   - Test getWorkspaceSessionsAction with running workspace returns parsed sessions
   - Test getWorkspaceSessionsAction with workspace that has no agents returns empty array
   - Test getWorkspaceSessionsAction when tmux returns exit code 1 (no sessions) returns empty array

## Must-Haves

- [ ] URL builder tests cover all three tool URL patterns
- [ ] Session parser tests cover empty, single, multiple, and malformed inputs
- [ ] Action tests cover happy path and error paths
- [ ] All tests pass with `pnpm vitest run src/__tests__/lib/workspaces/`
  - Files: `src/__tests__/lib/workspaces/urls.test.ts`, `src/__tests__/lib/workspaces/sessions.test.ts`, `src/__tests__/lib/workspaces/actions.test.ts`
  - Verify: pnpm vitest run src/__tests__/lib/workspaces/ && pnpm vitest run

## Files Likely Touched

- src/lib/coder/types.ts
- src/lib/workspaces/urls.ts
- src/lib/workspaces/sessions.ts
- src/lib/actions/workspaces.ts
- src/components/app-sidebar.tsx
- src/app/workspaces/page.tsx
- src/components/workspaces/WorkspacesClient.tsx
- src/__tests__/lib/workspaces/urls.test.ts
- src/__tests__/lib/workspaces/sessions.test.ts
- src/__tests__/lib/workspaces/actions.test.ts
