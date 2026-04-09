---
estimated_steps: 5
estimated_files: 5
---

# T02: Add verification report card and complete task results display

**Slice:** S06 — Live Agent Streaming & Dashboard Results
**Milestone:** M001

## Description

Completed tasks need to show the verification report (strategy, outcome, logs, duration) and ensure the PR link display is complete. The data already exists in the DB (`task.verificationReport` is a `Json?` field in Prisma, populated by the worker pipeline in S05). This task adds the `verificationReport` field to the client-side `TaskWithRelations` type, builds a `VerificationReportCard` component, and wires it into the task detail page.

This task has no dependency on T01 — it's pure UI rendering using existing data.

## Steps

1. **Update `src/lib/types/tasks.ts`** — Add `verificationReport` field to the `TaskWithRelations` interface. Type it as `{ strategy: string; outcome: string; logs: string; durationMs: number; timestamp: string } | null`. Also export a `VerificationReportData` type alias for this shape. The Prisma query in `getTask()` already includes `verificationReport` (it's a top-level Task field), so no API changes needed.

2. **Add outcome variant mapping to `src/lib/helpers/format.ts`** — Add `outcomeVariant` mapping: `pass` → `"default"` (green badge), `fail` → `"destructive"`, `inconclusive` → `"secondary"`. Also add `formatDuration(ms: number): string` helper that formats milliseconds as "Xs" or "Xm Ys".

3. **Create `src/app/tasks/[id]/verification-report-card.tsx`** — Client component that receives `report: VerificationReportData` prop and renders:
   - Strategy badge (e.g., "test-suite", "web-app", "static-site", "none")
   - Outcome badge with color-coded variant (pass=green, fail=red, inconclusive=yellow/secondary)
   - Duration display (e.g., "Duration: 12s")
   - Timestamp
   - Expandable/collapsible logs section — use a `<details>` element or a simple toggle button + conditional render. Logs displayed in a `<pre>` block with monospace font, max-height with scroll. Default collapsed to avoid overwhelming the page.

4. **Wire into `src/app/tasks/[id]/task-detail.tsx`** — Import and render `VerificationReportCard` below the PR link section. Show it when `task.verificationReport` is truthy. Place it after the Task Info card and before the Workspaces card.

5. **Create `src/__tests__/app/tasks/task-detail-results.test.ts`** — Test the `VerificationReportCard` component in isolation:
   - Renders pass outcome with correct badge variant
   - Renders fail outcome with destructive badge
   - Renders inconclusive outcome with secondary badge
   - Renders strategy badge text
   - Renders duration formatted correctly
   - Renders collapsible logs section
   - Component handles missing/null report gracefully (if rendered conditionally, test that the parent doesn't crash)
   
   Use vitest + React Testing Library (`@testing-library/react`). Check if `@testing-library/react` is already a devDependency — if not, install it. Mock any Next.js imports as needed.

## Must-Haves

- [ ] `TaskWithRelations` includes `verificationReport` field with proper type
- [ ] `VerificationReportCard` renders strategy, outcome badge, duration, and logs
- [ ] Outcome badge uses correct color variant (pass=green, fail=red, inconclusive=secondary)
- [ ] Logs section is collapsible (not shown by default for long output)
- [ ] Card integrated into task detail page, shown only when report exists
- [ ] Tests cover all three outcome states

## Verification

- `npx vitest run src/__tests__/app/tasks/task-detail-results.test.ts` — all report card tests pass
- `npx vitest run` — zero regressions

## Inputs

- `src/lib/verification/report.ts` — `VerificationReport` type with `strategy`, `outcome`, `logs`, `durationMs`, `timestamp` fields
- `src/app/tasks/[id]/task-detail.tsx` — Existing task detail page to integrate the card into
- `src/lib/types/tasks.ts` — Current `TaskWithRelations` type (missing `verificationReport`)
- `src/lib/helpers/format.ts` — Existing format helpers and `statusVariant` mapping pattern

## Expected Output

- `src/lib/types/tasks.ts` — Updated with `verificationReport` field and `VerificationReportData` type
- `src/lib/helpers/format.ts` — Added `outcomeVariant` mapping and `formatDuration()` helper
- `src/app/tasks/[id]/verification-report-card.tsx` — New component rendering verification report
- `src/app/tasks/[id]/task-detail.tsx` — Modified to render `VerificationReportCard`
- `src/__tests__/app/tasks/task-detail-results.test.ts` — 5-7 rendering tests
