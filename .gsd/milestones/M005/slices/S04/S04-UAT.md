# S04: External Tool Integration — UAT

**Milestone:** M005
**Written:** 2026-04-14T11:47:33.540Z

# S04 UAT: External Tool Integration

## Preconditions
- Hive dashboard running (`tsx watch server.ts`)
- At least one Coder workspace exists (running and stopped states needed)
- Coder workspace has Filebrowser and KasmVNC apps configured
- Browser with dev tools available

## Test Cases

### TC1: Navigate to workspace detail page from list
1. Open `/workspaces` in browser
2. Click on a workspace **name** (not the card body)
3. **Expected:** Browser navigates to `/workspaces/{id}` showing WorkspaceToolPanel
4. **Expected:** Breadcrumb shows "Workspaces / {workspace name}" with link back to /workspaces
5. Click the "Workspaces" breadcrumb link
6. **Expected:** Returns to workspace list page

### TC2: Filebrowser iframe loads by default
1. Navigate to `/workspaces/{id}` for a **running** workspace
2. **Expected:** Filebrowser tab is active (visually distinct styling)
3. **Expected:** Iframe loads with Filebrowser URL
4. **Expected:** KasmVNC tab shows outline/inactive styling

### TC3: Tab switching between Filebrowser and KasmVNC
1. On workspace detail page with Filebrowser active
2. Click KasmVNC tab
3. **Expected:** KasmVNC tab becomes active, iframe src changes to KasmVNC URL
4. Click Filebrowser tab
5. **Expected:** Filebrowser tab becomes active, iframe src changes back

### TC4: Pop Out button opens tool in new tab
1. With Filebrowser tab active, click "Pop Out" button
2. **Expected:** New browser tab/window opens with Filebrowser URL
3. Switch to KasmVNC tab, click "Pop Out"
4. **Expected:** New browser tab/window opens with KasmVNC URL

### TC5: Coder Dashboard link-out
1. On workspace detail page, locate Coder Dashboard button/link
2. Click it
3. **Expected:** Opens Coder dashboard in new tab (`target="_blank"`)
4. **Expected:** URL points to workspace's Coder dashboard page

### TC6: Disabled state for stopped workspace
1. Navigate to `/workspaces/{id}` for a **stopped** workspace
2. **Expected:** No iframe rendered
3. **Expected:** Message explaining workspace must be running
4. **Expected:** Tab buttons are visually disabled/grayed out
5. **Expected:** Coder Dashboard link still accessible (not disabled)

### TC7: Error fallback when iframe blocked
1. Navigate to a running workspace detail page
2. If iframe is blocked by X-Frame-Options or CSP headers:
3. **Expected:** After ~4 seconds, iframe is replaced with fallback UI
4. **Expected:** Fallback shows direct link buttons for both Filebrowser and KasmVNC
5. **Expected:** Clicking fallback links opens tools in new tabs

### TC8: Workspace list page preserves existing behavior
1. Open `/workspaces`
2. Click on workspace card body (not the name)
3. **Expected:** Card expands showing tmux sessions (existing behavior preserved)
4. **Expected:** All existing tool link buttons (Filebrowser, KasmVNC, Dashboard, Terminal) still visible
5. Click workspace name
6. **Expected:** Navigates to detail page (does NOT expand card)

### TC9: Error state for invalid workspace ID
1. Navigate to `/workspaces/invalid-uuid-here`
2. **Expected:** Error page renders with "Workspace not found" message
3. **Expected:** Back link to /workspaces is present

## Edge Cases
- Rapidly switching tabs should not cause iframe rendering issues
- Opening multiple Pop Out windows should each get the correct URL
- Network interruption during iframe load should trigger error fallback
