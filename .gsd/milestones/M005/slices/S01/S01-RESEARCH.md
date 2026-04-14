# S01 — Workspace Discovery & Listing — Research

**Date:** 2026-04-14
**Depth:** Light research — straightforward CRUD page using established patterns and an existing API client.

## Summary

This slice adds a `/workspaces` page that lists all Coder workspaces with live status badges, lets the user click into a workspace to see its tmux sessions (lazy-loaded), and renders external tool links (Filebrowser, KasmVNC, Coder dashboard) for each workspace. The codebase already has a fully functional `CoderClient` with a `listWorkspaces()` method, typed response interfaces, and env vars (`CODER_URL`, `CODER_SESSION_TOKEN`) wired through docker-compose. The page follows the exact same pattern as `/templates` — async server component fetches initial data, passes it to a `"use client"` component that handles polling and interaction.

The only new ground is: (1) extending the `CoderWorkspace` type to include fields needed for status badges and agent info in the list view, (2) constructing external tool URLs from the Coder subdomain proxy pattern, and (3) a server action or API route to lazy-fetch tmux sessions for a selected workspace (which will call `getWorkspaceResources` to find the agent ID, then needs a mechanism to run `tmux list-sessions` — but the actual PTY/exec for tmux is S02's concern; S01 can stub this or use the existing `exec.ts` utility).

## Recommendation

Follow the `/templates` page pattern exactly. Create `/workspaces/page.tsx` (server component) + `WorkspacesClient.tsx` (client component). Use the existing `CoderClient.listWorkspaces()` for initial data. Add a server action for refreshing workspace list. For tmux session listing, use the existing `src/lib/workspace/exec.ts` pattern to run `tmux list-sessions -F '#{session_name}:#{session_created}'` on the workspace agent. Construct external tool URLs from the `VSCODE_PROXY_URI` subdomain pattern observed in the environment.

## Implementation Landscape

### Key Files

- `src/lib/coder/client.ts` — `CoderClient` class with `listWorkspaces()`, `getWorkspace()`, `getWorkspaceResources()`, `getWorkspaceAgentName()`. All methods needed for workspace listing already exist. May need to expose `baseUrl` for constructing subdomain URLs.
- `src/lib/coder/types.ts` — `CoderWorkspace`, `ListWorkspacesResponse`, `WorkspaceAgent`, `WorkspaceResource`. The `CoderWorkspace` type is minimal — needs extension for template name display (Coder API returns `template_display_name`, `template_name`, `template_icon` fields not currently typed). `WorkspaceAgent` needs `status` typed more precisely for status badges.
- `src/components/app-sidebar.tsx` — Add `{ title: "Workspaces", href: "/workspaces", icon: Monitor }` to `navItems` array (line 19-23). Use `Monitor` or `Server` from lucide-react.
- `src/app/templates/page.tsx` — Reference pattern: async server component that fetches data and renders a client component.
- `src/app/templates/layout.tsx` — Reference pattern for page layout.
- `src/lib/workspace/exec.ts` — Existing utility for running commands inside workspaces. Can be used to run `tmux list-sessions` for lazy session loading.
- `docker-compose.yml` — `CODER_URL` and `CODER_SESSION_TOKEN` already wired (lines 16-17).

### New Files to Create

- `src/app/workspaces/page.tsx` — Server component, fetches initial workspace list via `CoderClient`
- `src/app/workspaces/layout.tsx` — Minimal layout (may not need one if no global CSS required)
- `src/components/workspaces/WorkspacesClient.tsx` — Main client component: workspace list with status badges, click-to-expand for tmux sessions, external tool links
- `src/lib/actions/workspaces.ts` — Server actions: `listWorkspaces()`, `getWorkspaceSessions(workspaceId)` (tmux list)
- `src/__tests__/app/api/workspaces/` — Tests for workspace listing logic

### External Tool URL Pattern

The Coder subdomain proxy pattern (from `VSCODE_PROXY_URI` env var):
```
https://{slug}--{agent}--{workspace}--{owner}.{coder_host}
```
Observed: `https://{{port}}--main--ai-dev-01--b00ste-lyx.coder.local.kethalia.com`

For named apps (Filebrowser, KasmVNC), the slug is the `coder_app` slug, not a port:
- Filebrowser: `https://filebrowser--{agent}--{workspace}--{owner}.{coder_host}`
- KasmVNC: `https://kasmvnc--{agent}--{workspace}--{owner}.{coder_host}`
- Coder dashboard: `{CODER_URL}/@{owner}/{workspace}` (direct link, not subdomain)

These URLs can be constructed from `CoderWorkspace.name`, `CoderWorkspace.owner_name`, the agent name (from resources), and `CODER_URL`.

### CoderWorkspace Type Extension

The Coder API `/api/v2/workspaces` returns more fields than currently typed. For S01 status badges and display, add:
- `template_name: string` — template identifier
- `template_display_name: string` — human-readable template name
- `template_icon: string` — icon URL
- `last_used_at: string` — for "last active" display
- `health: { healthy: boolean; failing_agents: string[] }` — workspace health

### Build Order

1. **Extend types** (`types.ts`) — add missing fields to `CoderWorkspace` and type `WorkspaceAgent.status` as a union. No risk, no dependencies.
2. **Server actions** (`actions/workspaces.ts`) — `listWorkspaces` action wrapping `CoderClient`, `getWorkspaceSessions` action for tmux listing. Follows `actions/tasks.ts` pattern.
3. **Sidebar entry** (`app-sidebar.tsx`) — one-line addition to `navItems`.
4. **Page + client component** — `/workspaces/page.tsx` + `WorkspacesClient.tsx`. This is the bulk of the work. Workspace list with status badges → click to expand → show tmux sessions + external tool links.
5. **Tests** — unit tests for the server actions and component rendering.

### Verification Approach

- `pnpm vitest run` — all existing + new tests pass
- `pnpm build` — no type errors
- Manual: navigate to `/workspaces`, see workspace list with status badges, click a workspace, see tmux sessions (or empty state), see external tool links
- Verify external tool links open correctly (Filebrowser, KasmVNC, Coder dashboard)

## Constraints

- No auth on pages — Hive is a solo-operator tool, no middleware needed
- `CODER_URL` and `CODER_SESSION_TOKEN` must be set in env — server-side only, never exposed to browser
- Vitest config uses `environment: "node"` — React component tests need `@testing-library/react` with jsdom or similar, or test only the server action / data layer
- The existing test infrastructure tests server-side logic only (no component tests exist in the codebase)

## Common Pitfalls

- **Coder API pagination** — `listWorkspaces()` currently doesn't handle pagination. The Coder API defaults to 26 results per page. If the user has many workspaces, need to pass `limit=0` or paginate. For a solo operator this is unlikely to matter, but worth noting.
- **Subdomain URL construction** — The `VSCODE_PROXY_URI` pattern includes the current workspace's agent/name. For other workspaces, construct URLs from their own agent name and workspace name, not from the env var template. Parse `CODER_URL` for the base domain instead.
- **tmux session listing requires a running workspace** — `tmux list-sessions` can only work on running workspaces. The UI must handle stopped/failed workspaces gracefully (disable session listing, show status).

## Sources

- Coder subdomain proxy pattern derived from `VSCODE_PROXY_URI` environment variable: `https://{{port}}--main--ai-dev-01--b00ste-lyx.coder.local.kethalia.com`
- Coder app slugs from `templates/ai-dev/main.tf` and `templates/hive/main.tf` — filebrowser module (slug: `filebrowser`), kasmvnc module (slug: `kasmvnc`)
