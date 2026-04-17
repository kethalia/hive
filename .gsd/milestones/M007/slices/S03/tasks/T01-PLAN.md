---
estimated_steps: 13
estimated_files: 4
skills_used: []
---

# T01: Create template detail page with push flow

Create the `/templates/[name]` route that the sidebar template links already point to. The page shows template info (name, staleness badge, last pushed date, local/remote hash comparison, active version ID) and a Push button that triggers the same SSE push flow used in TemplatesClient.tsx. The push flow streams output into a TerminalPanel.

**Why:** R064 — sidebar template links currently 404. This is the core deliverable of the slice.

**Do:**
1. Create `src/app/templates/[name]/page.tsx` as a server component that calls `compareTemplates([params.name])` to get a single TemplateStatus, then renders `TemplateDetailClient`.
2. Create `src/components/templates/TemplateDetailClient.tsx` as a client component that:
   - Shows template name as h1, StatusBadge (stale/fresh), formatted lastPushed date, localHash, remoteHash, activeVersionId
   - Has a Push button that POSTs to `/api/templates/${name}/push`, gets jobId, opens EventSource at `/api/templates/${name}/push/${jobId}/stream`
   - Streams output lines into a dynamically imported TerminalPanel (ssr: false)
   - Shows push result (success/failure) with appropriate styling
   - Reuse the `formatDate` utility and `PushState` interface pattern from TemplatesClient.tsx
3. Use shadcn Card, Badge, Button components per project convention.
4. The `TemplateStatus` type from `src/lib/templates/staleness.ts` is the data contract.

**Done when:** Navigating to `/templates/hive` shows template info fields and a Push button. Clicking Push streams terminal output via SSE.

## Inputs

- ``src/components/templates/TemplatesClient.tsx` — push flow pattern (handlePush, EventSource streaming, PushState interface, formatDate utility, TerminalPanel dynamic import)`
- ``src/lib/templates/staleness.ts` — TemplateStatus type and compareTemplates function`
- ``src/components/templates/TerminalPanel.tsx` — terminal panel component for push output`
- ``src/components/ui/badge.tsx` — Badge component for staleness status`
- ``src/components/ui/card.tsx` — Card component for layout`

## Expected Output

- ``src/app/templates/[name]/page.tsx` — server component that fetches single template status and renders TemplateDetailClient`
- ``src/components/templates/TemplateDetailClient.tsx` — client component showing template info fields and push flow with TerminalPanel`

## Verification

pnpm tsc --noEmit 2>&1 | grep -c 'src/app/templates\|src/components/templates/TemplateDetail' | grep -q '^0$' && echo 'PASS: no type errors'
