# S03: Templates Dashboard Page with xterm.js

**Goal:** Templates dashboard page at /templates with stale/current badges, Push buttons, and inline xterm.js terminal panels that stream live push output via SSE.
**Demo:** Open /templates, see stale badge on ai-dev, click Push, watch coder output stream in xterm.js terminal, badge flips to current.

## Must-Haves

- Page shows correct stale/current status. Push opens xterm.js panel with live ANSI output. Badge flips to current on success. 263 vitest tests pass.

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: Server action and data fetching for templates page** `est:20min`
  Create src/app/templates/actions.ts:
- getTemplateStatuses(): calls compareTemplates() for all 2 known template names, returns TemplateStatus[]
- Server action: revalidates /templates page cache after successful push

Create src/app/api/templates/status/route.ts (GET):
- Returns JSON array of TemplateStatus for all 2 templates
- Used by the frontend to poll staleness every 30s
  - Files: `src/app/templates/actions.ts`, `src/app/api/templates/status/route.ts`
  - Verify: npx vitest run src/__tests__/app/api/templates/status.test.ts

- [x] **T02: Templates page UI with xterm.js terminal panel** `est:90min`
  Install xterm and @xterm/addon-fit packages.

Create src/app/templates/page.tsx (server component):
- Fetches initial template statuses server-side
- Renders <TemplatesClient> with initial data

Create src/components/templates/TemplatesClient.tsx (client component):
- Table with columns: Name, Last Pushed, Status, Actions
- Status badge: green 'Current' or amber 'Stale'
- Push button per row (disabled while push in progress)
- Polls /api/templates/status every 30s to refresh badges
- On Push click:
  1. POST /api/templates/<name>/push → gets jobId
  2. Opens inline terminal panel below the row
  3. Creates xterm.js Terminal instance with ANSI support
  4. Connects EventSource to /api/templates/<name>/push/<jobId>/stream
  5. Writes each SSE data line to terminal via terminal.write()
  6. On 'status' event: shows success (green) or failure (red) indicator, closes EventSource
  7. On success: refreshes staleness for that template row

Create src/components/templates/TerminalPanel.tsx:
- Wrapper around xterm.js Terminal
- Uses @xterm/addon-fit for responsive sizing
- Dark background, monospace font, 80col min width
- Close button to dismiss
  - Files: `src/app/templates/page.tsx`, `src/components/templates/TemplatesClient.tsx`, `src/components/templates/TerminalPanel.tsx`
  - Verify: npx vitest run && browser verify: open /templates, see table, push button, xterm panel

- [x] **T03: Add Templates link to dashboard nav and vitest regression** `est:20min`
  1. Add 'Templates' link to the dashboard navigation (wherever the existing nav is defined)
2. Run full vitest suite — confirm 263+ tests pass
3. Browser verify end-to-end: open /templates, see all 2 templates with stale/current badges, click Push on ai-dev, watch xterm.js terminal render coder output with ANSI colors, confirm badge flips to Current on success
  - Files: `src/components/app-sidebar.tsx`
  - Verify: npx vitest run (263+ tests pass)

## Files Likely Touched

- src/app/templates/actions.ts
- src/app/api/templates/status/route.ts
- src/app/templates/page.tsx
- src/components/templates/TemplatesClient.tsx
- src/components/templates/TerminalPanel.tsx
- src/components/app-sidebar.tsx
