---
estimated_steps: 45
estimated_files: 5
skills_used: []
---

# T02: Create workspace detail page route and wire list page navigation

## Description

Connects T01's components into the app — creates the `/workspaces/[id]` server route and adds navigation from the workspace list page. Without this, the panel component has no page to live on and users can't reach it.

### What to build

**1. `/workspaces/[id]/page.tsx`** — async server component:
- Follow the exact pattern from `src/app/workspaces/[id]/terminal/page.tsx`
- Interface: `{ params: Promise<{ id: string }> }`
- Await params to get workspace ID
- Call `getWorkspaceAction({ workspaceId })` and `getWorkspaceAgentAction({ workspaceId })` in parallel via `Promise.all`
- Handle error: if `getWorkspaceAction` fails, show "Workspace not found" error page (same style as terminal page's "No agent found" error)
- If agent not found, still render the panel but with a fallback agent name of `'main'` (the convention from S01)
- Pass workspace data, agent name (from agent result or fallback 'main'), and `process.env.CODER_URL ?? ''` to `WorkspaceToolPanel`
- Add a back-link to `/workspaces` at the top of the page

**2. Update `WorkspacesClient.tsx`** — add navigation:
- Import `Link` from `next/link`
- Make the workspace name text a `<Link href={`/workspaces/${ws.id}`}>` so clicking the name navigates to the detail page
- Keep all existing tool link buttons (Filebrowser, KasmVNC, Dashboard, Terminal) as-is — they remain as quick-access shortcuts on the list page
- The workspace card click-to-expand behavior should still work (clicking the card row expands sessions, clicking the name navigates)
- To avoid the card click handler intercepting the link click, add `e.stopPropagation()` on the Link's click event

## Steps

1. Read `src/app/workspaces/[id]/terminal/page.tsx` for the exact server component pattern to follow
2. Read T01's outputs: `src/components/workspaces/WorkspaceToolPanel.tsx` and verify `getWorkspaceAction` in `src/lib/actions/workspaces.ts`
3. Create `src/app/workspaces/[id]/page.tsx` with the server component
4. Read `src/components/workspaces/WorkspacesClient.tsx` and add Link-based navigation on workspace names
5. Run `pnpm build` to verify the route compiles and is listed

## Must-Haves

- [ ] `/workspaces/[id]/page.tsx` exists as async server component
- [ ] Page fetches workspace data and agent info in parallel
- [ ] Error state renders when workspace not found
- [ ] WorkspaceToolPanel receives correct props (workspace, agentName, coderUrl)
- [ ] Workspace name in list page is a Link to `/workspaces/[id]`
- [ ] Back-link to /workspaces on detail page
- [ ] `pnpm build` succeeds

## Verification

- `test -f src/app/workspaces/\[id\]/page.tsx` — detail page exists
- `grep -q 'WorkspaceToolPanel' src/app/workspaces/\[id\]/page.tsx` — uses panel component
- `grep -q '/workspaces/' src/components/workspaces/WorkspacesClient.tsx` — link to detail page
- `pnpm build` — builds successfully

## Inputs

- `src/components/workspaces/WorkspaceToolPanel.tsx` — T01 output, the panel component to render
- `src/lib/actions/workspaces.ts` — T01 output with getWorkspaceAction
- `src/app/workspaces/[id]/terminal/page.tsx` — pattern reference for server component structure
- `src/components/workspaces/WorkspacesClient.tsx` — list page to add navigation links

## Expected Output

- `src/app/workspaces/[id]/page.tsx` — new server component for workspace detail route
- `src/components/workspaces/WorkspacesClient.tsx` — modified with Link navigation to detail page

## Inputs

- `src/components/workspaces/WorkspaceToolPanel.tsx`
- `src/lib/actions/workspaces.ts`
- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/components/workspaces/WorkspacesClient.tsx`

## Expected Output

- `src/app/workspaces/[id]/page.tsx`
- `src/components/workspaces/WorkspacesClient.tsx`

## Verification

test -f src/app/workspaces/\[id\]/page.tsx && grep -q 'WorkspaceToolPanel' src/app/workspaces/\[id\]/page.tsx && pnpm build
