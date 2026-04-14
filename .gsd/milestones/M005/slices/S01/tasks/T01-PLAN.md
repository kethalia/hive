---
estimated_steps: 27
estimated_files: 5
skills_used: []
---

# T01: Extend Coder types, build server actions, add sidebar entry and URL utilities

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

## Inputs

- ``src/lib/coder/types.ts` — existing CoderWorkspace and WorkspaceAgent types to extend`
- ``src/lib/coder/client.ts` — CoderClient class with listWorkspaces, getWorkspace, getWorkspaceResources, getWorkspaceAgentName methods`
- ``src/lib/workspace/exec.ts` — execInWorkspace function for running commands in workspaces`
- ``src/lib/safe-action.ts` — actionClient for creating server actions`
- ``src/lib/actions/tasks.ts` — reference pattern for server actions`
- ``src/components/app-sidebar.tsx` — sidebar component to add nav entry to`

## Expected Output

- ``src/lib/coder/types.ts` — extended with template_display_name, template_icon, last_used_at, health fields and WorkspaceAgent status union`
- ``src/lib/workspaces/urls.ts` — buildWorkspaceUrls utility function`
- ``src/lib/workspaces/sessions.ts` — parseTmuxSessions parser and TmuxSession type`
- ``src/lib/actions/workspaces.ts` — listWorkspacesAction and getWorkspaceSessionsAction server actions`
- ``src/components/app-sidebar.tsx` — Workspaces nav entry added`

## Verification

pnpm build && grep -q 'Workspaces' src/components/app-sidebar.tsx && test -f src/lib/actions/workspaces.ts && test -f src/lib/workspaces/urls.ts && test -f src/lib/workspaces/sessions.ts
