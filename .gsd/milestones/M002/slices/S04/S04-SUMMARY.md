---
id: S04
parent: M002
milestone: M002
provides:
  - Task detail page renders CouncilResultCard with outcome badges, severity counts, consensus items, reviewer completion stats, and PR comment links
  - Task creation form accepts councilSize numeric input (1–7, default 3) wired to database
  - CouncilReport type guard and component integration pattern for type-safe conditional rendering
requires:
  []
affects:
  - S05
  - S06
key_files:
  - src/app/tasks/[id]/council-result-card.tsx
  - src/lib/types/tasks.ts
  - src/app/tasks/[id]/task-detail.tsx
  - src/__tests__/app/tasks/council-result-card.test.ts
  - src/lib/actions/tasks.ts
  - src/lib/api/tasks.ts
  - src/app/tasks/new/page.tsx
  - src/__tests__/app/tasks/tasks-pages.test.ts
key_decisions:
  - TaskWithRelations uses `unknown` for councilReport to allow runtime type narrowing via `isCouncilReport()` guard without forcing Prisma-generated types
  - CouncilResultCard mirrors VerificationReportCard structure (outcome badge, count badges, collapsible list, footer stats) to establish consistency across report cards
  - Consensus items use 3-item threshold for expansion (show first 3, toggle to show all) — consistent with VerificationReportCard logs pattern
  - createTaskSchema exported to enable direct unit testing of Zod validation without coupling to action layer
  - councilSize uses z.coerce.number() to auto-convert HTML form string inputs to integers
patterns_established:
  - Report card pattern: outcome badge + severity count badges + collapsible findings + footer stats + external link
  - Type-safe conditional rendering: unknown field with type guard → component props narrows types at render time
  - Expansion threshold consistency: 3 items shown, 'Show more' toggle if total > 3
  - Schema unit testing: export Zod schemas to enable direct parse/validation tests independent of action/API layers
observability_surfaces:
  - None — S04 is UI/form integration, no runtime state to monitor
drill_down_paths:
  - .gsd/milestones/M002/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S04/tasks/T02-SUMMARY.md
duration: ""
verification_result: passed
completed_at: 2026-04-09T12:11:01.186Z
blocker_discovered: false
---

# S04: S04: Council Dashboard

**Task detail page now renders CouncilResultCard with severity badges and consensus items; task creation form accepts councilSize (1–7, default 3); all 268 tests pass**

## What Happened

S04 completed the council review dashboard by rendering the orchestrated council review results on the task detail page and letting users specify review team size on task submission. T01 extended TaskWithRelations with councilSize and councilReport fields, created CouncilResultCard component with outcome badge, severity count badges (only when count > 0), collapsible consensus items (3-item expansion threshold), reviewer completion stats, and optional PR comment link, then wired it into task-detail.tsx guarded by isCouncilReport() type guard. Wrote 12 component tests covering all rendering paths. T02 added councilSize numeric input (1–7, default 3) to the task creation form, extended createTaskSchema with z.coerce.number().int().min(1).max(7).default(3) (exported for testability), threaded it through the server action and createTask() API to the database, and wrote 6 tests (2 API-level + 4 schema-level) validating bounds, defaults, and persistence. Result: 268/268 tests pass (262 existing + 6 new from this slice), 23 TS errors (all pre-existing, at threshold), zero regressions.

## Verification

npx vitest run src/__tests__/app/tasks/council-result-card.test.ts → 12/12 pass; npx vitest run src/__tests__/app/tasks/tasks-pages.test.ts → 8/8 pass (2 existing + 6 new); npm test → 268/268 pass (37 test files); npx tsc --noEmit --skipLibCheck → 23 errors (all pre-existing, at threshold)

## Requirements Advanced

- R028 — Form field input (councilSize) demonstrates integration of linter-compatible form controls into task creation, supporting deterministic UI patterns

## Requirements Validated

- R025 — Blueprint context piping and type-safe component integration established in S04, ready for S05 agent integration

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

["Exported createTaskSchema (changed from const to export const) to allow direct schema unit tests — minor addition not in original plan but consistent with good testability patterns"]

## Known Limitations

["None"]

## Follow-ups

["S05 will integrate council review display into agent-driven task execution", "S06+ can depend on CouncilResultCard display being available for user verification"]

## Files Created/Modified

- `src/app/tasks/[id]/council-result-card.tsx` — New component: renders CouncilReport with outcome badge, severity count badges, collapsible consensus items, reviewer stats, PR link
- `src/lib/types/tasks.ts` — Added councilSize: number and councilReport: unknown to TaskWithRelations
- `src/app/tasks/[id]/task-detail.tsx` — Wired CouncilResultCard into detail page after VerificationReportCard, guarded by isCouncilReport()
- `src/__tests__/app/tasks/council-result-card.test.ts` — New test suite: 12 component tests covering outcome badge, severity badges, consensus items, expansion, footer, PR link
- `src/lib/actions/tasks.ts` — Exported createTaskSchema, added councilSize to schema with coercion and validation
- `src/lib/api/tasks.ts` — Added councilSize?: number param to createTask(), passed to db.task.create
- `src/app/tasks/new/page.tsx` — Added councilSize numeric input field with min=1, max=7, default=3
- `src/__tests__/app/tasks/tasks-pages.test.ts` — Added 6 new tests: 2 API-level (passes value, defaults), 4 schema-level (bounds, coercion)
