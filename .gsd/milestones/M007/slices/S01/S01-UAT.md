# S01: Sidebar Tree Structure & Layout Overhaul — UAT

**Milestone:** M007
**Written:** 2026-04-17T05:07:36.636Z

# S01 UAT: Sidebar Tree Structure & Layout Overhaul

## Preconditions
- Hive dev server running (`pnpm dev`)
- Coder instance accessible with at least one workspace and template configured
- Browser open to Hive dashboard

## Test Cases

### TC1: Header removed globally
1. Navigate to any page (Tasks, New Task, Terminal)
2. **Expected**: No `<header>` bar visible at top of page. No breadcrumbs anywhere.
3. **Expected**: Only chrome visible is the floating sidebar trigger button in top-left corner (hamburger icon)

### TC2: Floating sidebar trigger
1. Observe the top-left corner of the page
2. **Expected**: Small trigger button visible at `top-3 left-3` position, overlaid on content
3. Click the trigger button
4. **Expected**: Sidebar opens/closes on toggle
5. Navigate to different pages — trigger remains visible on all pages

### TC3: Collapsible Workspaces section
1. Open sidebar
2. **Expected**: "Workspaces" section with Monitor icon visible, default expanded
3. **Expected**: Each workspace listed as a sub-item showing workspace name and build status badge
4. Click the "Workspaces" chevron to collapse
5. **Expected**: Section collapses, chevron rotates from down to right
6. Click again to expand
7. **Expected**: Section expands, workspaces visible again

### TC4: Collapsible Templates section
1. Open sidebar
2. **Expected**: "Templates" section with LayoutTemplate icon visible, default expanded
3. **Expected**: Each template listed with name and stale/fresh badge
4. Toggle collapse/expand — same behavior as Workspaces section

### TC5: Navigation items preserved
1. Open sidebar
2. **Expected**: Tasks and New Task items visible in a Navigation group above the tree sections
3. **Expected**: Dashboard external link visible if CODER_URL is set
4. Click Tasks — navigates to /tasks
5. Click New Task — navigates to /tasks/new

### TC6: 30s polling
1. Open sidebar and observe workspace/template data
2. Open browser Network tab, filter for server action requests
3. Wait 30+ seconds
4. **Expected**: New fetch requests appear for both workspaces and templates data
5. **Expected**: Data refreshes without user interaction

### TC7: Footer timestamp and refresh
1. Open sidebar, scroll to footer area
2. **Expected**: "Updated just now" or "Updated Xm ago" timestamp visible
3. **Expected**: Refresh button with RefreshCw icon visible
4. Click refresh button
5. **Expected**: Icon spins while loading, timestamp updates to "Updated just now" after completion

### TC8: Error state — workspace fetch failure
1. Simulate network failure (disconnect from Coder, or use DevTools to block the workspace action)
2. Wait for next poll or click refresh
3. **Expected**: Workspaces section shows destructive Alert with error message
4. **Expected**: Retry button visible inside the alert
5. Click retry button
6. **Expected**: Re-fetches workspace data; if network restored, data appears and alert disappears

### TC9: Error state — template fetch failure
1. Same as TC8 but for templates section
2. **Expected**: Templates section shows its own independent error alert
3. **Expected**: Workspaces section unaffected (independent error state)

### TC10: Content not obscured by floating trigger
1. Navigate to any page with content near the top
2. **Expected**: Page content has sufficient top padding (pt-14) so nothing is hidden behind the floating trigger button

## Edge Cases
- **No workspaces**: Workspaces section should be empty but still collapsible
- **No templates**: Templates section should be empty but still collapsible
- **Both sections fail**: Both show independent error alerts with independent retry buttons
- **Rapid refresh clicks**: Button should be disabled while loading, preventing request stacking
