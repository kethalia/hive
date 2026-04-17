# S03: Template Detail Page & Sidebar Polish — UAT

**Milestone:** M007
**Written:** 2026-04-17T05:40:14.135Z

# S03 UAT: Template Detail Page & Sidebar Polish

## Preconditions
- Hive dashboard running locally (`pnpm dev`)
- At least one template configured in KNOWN_TEMPLATES (e.g., "hive")
- Browser with DevTools open (Network tab)

---

## Test Case 1: Template Detail Page — Basic Rendering
1. Open sidebar and expand the Templates section
2. Click a template name (e.g., "hive")
3. **Expected:** Navigates to `/templates/hive`
4. **Expected:** Page shows template name as heading, a staleness badge (Stale/Current/Unknown), a Card with lastPushed date, localHash, remoteHash, and activeVersionId
5. **Expected:** A "Push" button is visible
6. **Expected:** A "Back to Templates" link is visible

## Test Case 2: Template Detail Page — Push Flow
1. On the template detail page, click the "Push" button
2. **Expected:** Button text changes to "Pushing…" and badge shows "Pushing…"
3. **Expected:** Network tab shows POST to `/api/templates/hive/push` followed by EventSource connection to the stream endpoint
4. **Expected:** TerminalPanel appears below the button showing streaming output lines
5. **Expected:** On completion, badge updates to reflect new status and success/failure message appears

## Test Case 3: Template Detail Page — Push Error
1. Disconnect network or stop the API server
2. Click the "Push" button on a template detail page
3. **Expected:** Error message appears (e.g., "Push failed" or network error text)
4. **Expected:** Badge returns to previous state, not stuck on "Pushing…"

## Test Case 4: Template Detail Page — Unknown Template
1. Navigate directly to `/templates/nonexistent`
2. **Expected:** 404 page is shown (notFound() called by server component)

## Test Case 5: Sidebar Mode Toggle — Default (Offcanvas)
1. Clear localStorage (`localStorage.removeItem('sidebar_mode')`)
2. Reload the page
3. **Expected:** Sidebar appears in offcanvas (floating) mode — full-width overlay that can be dismissed
4. **Expected:** SidebarFooter shows a PinOff icon button (indicating "click to pin")

## Test Case 6: Sidebar Mode Toggle — Pin
1. Click the PinOff toggle button in sidebar footer
2. **Expected:** Sidebar switches to icon (pinned/docked) mode — collapsed to icons only
3. **Expected:** Toggle button now shows Pin icon
4. **Expected:** `localStorage.getItem('sidebar_mode')` returns `"icon"`

## Test Case 7: Sidebar Mode Toggle — Unpin
1. With sidebar in icon mode, click the Pin toggle button
2. **Expected:** Sidebar switches back to offcanvas (floating) mode
3. **Expected:** Toggle button shows PinOff icon again
4. **Expected:** `localStorage.getItem('sidebar_mode')` returns `"offcanvas"`

## Test Case 8: Sidebar Mode Toggle — Persistence
1. Set sidebar to icon mode (pinned)
2. Reload the page
3. **Expected:** Sidebar starts in icon (pinned) mode — preference persisted

## Test Case 9: Workspaces Page Removed
1. Navigate directly to `/workspaces`
2. **Expected:** 404 page (route no longer exists)

## Test Case 10: Breadcrumb Links Updated
1. Navigate to a terminal session page (e.g., `/workspaces/my-workspace/terminal/session-id`)
2. **Expected:** Breadcrumb "home" link points to `/tasks`, not `/workspaces`
3. Click the breadcrumb link
4. **Expected:** Navigates to `/tasks`

## Test Case 11: Mobile Responsive Sidebar
1. Resize browser viewport below 768px width (or use DevTools device emulation)
2. Open the sidebar via SidebarTrigger
3. **Expected:** Sidebar renders as a Sheet overlay (full-height modal from left)
4. **Expected:** All sidebar sections (Workspaces, Templates) visible and functional
5. Tap outside the sidebar or use the close mechanism
6. **Expected:** Sidebar dismisses cleanly

---

## Edge Cases
- Template with no lastPushed date: should show "—" instead of formatted date
- Template with matching local/remote hashes: badge should show "Current"
- Rapidly clicking Push button: should not trigger multiple concurrent push requests (button disabled during push)
- Setting `sidebar_mode` to an invalid value in localStorage: should default to offcanvas
