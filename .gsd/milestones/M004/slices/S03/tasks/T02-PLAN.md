---
estimated_steps: 22
estimated_files: 3
skills_used: []
---

# T02: Templates page UI with xterm.js terminal panel

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

## Inputs

- `src/app/templates/actions.ts`
- `src/app/api/templates/[name]/push/route.ts`
- `src/app/api/templates/[name]/push/[jobId]/stream/route.ts`

## Expected Output

- `src/app/templates/page.tsx`
- `src/components/templates/TemplatesClient.tsx`
- `src/components/templates/TerminalPanel.tsx`

## Verification

npx vitest run && browser verify: open /templates, see table, push button, xterm panel
