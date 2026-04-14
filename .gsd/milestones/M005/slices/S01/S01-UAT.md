# S01: Workspace Discovery & Listing — UAT

**Milestone:** M005
**Written:** 2026-04-14T10:57:16.420Z

# S01 UAT: Workspace Discovery & Listing

## Preconditions
- Hive dashboard running (`pnpm dev`)
- `CODER_URL` and `CODER_SESSION_TOKEN` environment variables set with valid Coder credentials
- At least one Coder workspace exists for the authenticated user
- `NEXT_PUBLIC_CODER_URL` set for client-side tool link construction

## Test Cases

### TC1: Sidebar Navigation
1. Open the Hive dashboard at `/`
2. Look at the left sidebar
3. **Expected:** "Workspaces" entry appears after "Templates" with a Monitor icon
4. Click "Workspaces"
5. **Expected:** Navigates to `/workspaces`

### TC2: Workspace List Renders
1. Navigate to `/workspaces`
2. **Expected:** Page title "Workspaces" is visible
3. **Expected:** All workspaces owned by the authenticated user are listed as cards
4. **Expected:** Each card shows workspace name, template name, owner, and last-used time

### TC3: Status Badges
1. On `/workspaces`, observe workspace cards
2. **Expected:** Running workspaces show green dot + "Running" label
3. **Expected:** Stopped workspaces show gray dot + "Stopped" label
4. **Expected:** Starting workspaces show yellow dot + "Starting" label
5. **Expected:** Failed workspaces show red dot + "Failed" label

### TC4: Tmux Session Expansion (Running Workspace)
1. Click on a running workspace card
2. **Expected:** Loading spinner appears briefly
3. **Expected:** Tmux sessions list appears showing session name, window count, and created time
4. If no tmux sessions exist: **Expected:** "No active tmux sessions" message

### TC5: Tmux Session Expansion (Stopped Workspace)
1. Click on a stopped workspace card
2. **Expected:** Message indicating workspace is not running, no session fetch attempted

### TC6: External Tool Links
1. Click on a running workspace to expand it
2. **Expected:** Three tool link buttons appear: Filebrowser, KasmVNC, Coder Dashboard
3. Click Filebrowser link
4. **Expected:** Opens `https://filebrowser--main--{workspace}--{owner}.{coder_host}` in new tab
5. Click KasmVNC link
6. **Expected:** Opens `https://kasmvnc--main--{workspace}--{owner}.{coder_host}` in new tab
7. Click Coder Dashboard link
8. **Expected:** Opens `{CODER_URL}/@{owner}/{workspace}` in new tab

### TC7: Refresh Button
1. On `/workspaces`, click the Refresh button
2. **Expected:** Workspace list re-fetches and updates (loading state visible during fetch)

### TC8: Empty State
1. If user has no workspaces (or Coder API returns empty)
2. **Expected:** Empty state message displayed instead of cards

### TC9: Error Handling
1. Stop the Coder server or invalidate CODER_SESSION_TOKEN
2. Navigate to `/workspaces`
3. **Expected:** Error banner displayed, page does not crash

## Edge Cases
- Workspace with very long name: should not break card layout
- Multiple workspaces with same template: each renders independently
- Rapid clicking between workspaces: session loading should not race/corrupt
