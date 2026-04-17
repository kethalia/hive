---
id: T01
parent: S03
milestone: M007
key_files:
  - src/app/templates/[name]/page.tsx
  - src/components/templates/TemplateDetailClient.tsx
key_decisions:
  - Used Link wrapping Button for back navigation instead of asChild prop — project Button component doesn't support Radix asChild composition
duration: 
verification_result: passed
completed_at: 2026-04-17T05:33:21.443Z
blocker_discovered: false
---

# T01: Create /templates/[name] detail page with template info display and SSE push flow streaming into TerminalPanel

**Create /templates/[name] detail page with template info display and SSE push flow streaming into TerminalPanel**

## What Happened

Created two new files to implement the template detail page route that sidebar template links point to.

`src/app/templates/[name]/page.tsx` is a server component that validates the template name against KNOWN_TEMPLATES (returning 404 for unknown names), calls `compareTemplates([name])` to fetch the single TemplateStatus, and renders TemplateDetailClient.

`src/components/templates/TemplateDetailClient.tsx` is a client component that displays:
- Template name as h1 with mono font
- StatusBadge showing stale/fresh/unknown/pushing state (reuses exact badge styling from TemplatesClient)
- Card with template details: lastPushed (formatted with relative time), activeVersionId, localHash, remoteHash
- Push button that POSTs to `/api/templates/${name}/push`, gets jobId, opens EventSource at the stream endpoint
- Terminal output via dynamically imported TerminalPanel (ssr: false) with line history replay on mount
- Push result feedback (success/failure icons and text)
- Back navigation link to /templates

The push flow, PushState interface, formatDate utility, line history pattern, and terminal ready callback are all reused from TemplatesClient.tsx. One deviation: used Link wrapping Button instead of asChild prop since the project's Button component doesn't support asChild.

## Verification

Ran `pnpm tsc --noEmit` — zero type errors in either new file. Ran the task plan's verification command which confirmed PASS.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm tsc --noEmit 2>&1 | grep -c 'src/app/templates\|src/components/templates/TemplateDetail' | grep -q '^0$' && echo 'PASS: no type errors'` | 0 | ✅ pass | 12000ms |

## Deviations

Used Link wrapping Button instead of Button with asChild prop for back navigation — the project's Button component does not support the asChild prop (no Radix Slot integration). Functionally equivalent.

## Known Issues

None

## Files Created/Modified

- `src/app/templates/[name]/page.tsx`
- `src/components/templates/TemplateDetailClient.tsx`
