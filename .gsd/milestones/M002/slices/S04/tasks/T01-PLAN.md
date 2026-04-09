---
estimated_steps: 50
estimated_files: 4
skills_used: []
---

# T01: CouncilResultCard component with type wiring and tests

## Description

Create the `CouncilResultCard` component that renders a `CouncilReport` on the task detail page, add the missing `councilReport` and `councilSize` fields to `TaskWithRelations`, and wire the card into `task-detail.tsx` using the `isCouncilReport()` guard. Write component tests proving all rendering paths.

The component mirrors `VerificationReportCard` structure: Card with header, badges for outcome and severity counts, expandable consensus items list, and footer with reviewer completion stats and PR comment link.

## Steps

1. **Extend `TaskWithRelations`** in `src/lib/types/tasks.ts`:
   - Add `councilSize: number;` field
   - Add `councilReport: unknown;` field (Prisma returns `JsonValue`; type guard narrows at render time)
   - Import nothing new — `unknown` is sufficient

2. **Create `src/app/tasks/[id]/council-result-card.tsx`**:
   - Props: `{ report: CouncilReport }`
   - Import `CouncilReport` and `AggregatedFinding` from `@/lib/council/types`
   - Use Card/CardHeader/CardTitle/CardContent from `@/components/ui/card`, Badge from `@/components/ui/badge`, Button from `@/components/ui/button`
   - Render:
     - **Outcome badge** with variant based on outcome (complete=default, partial=secondary, inconclusive=destructive)
     - **Severity count badges**: count findings by severity, show with emoji prefix (🔴 Critical, 🟠 Major, 🟡 Minor, 💬 Nit) — only show badges with count > 0
     - **Consensus items section**: list `report.consensusItems` with file:startLine, issue text, fix text, agreement count badge. Use `useState` for expand/collapse if > 3 items
     - **Footer**: `{reviewersCompleted}/{councilSize} reviewers completed` • link to `postedCommentUrl` if non-null
   - Add `data-testid` attributes: `council-outcome-badge`, `severity-critical`, `severity-major`, `severity-minor`, `severity-nit`, `consensus-item`, `reviewer-count`, `pr-comment-link`

3. **Wire into `task-detail.tsx`**:
   - Import `{ isCouncilReport }` from `@/lib/council/types`
   - Import `{ CouncilResultCard }` from `./council-result-card`
   - Add after the VerificationReportCard block:
     ```tsx
     {isCouncilReport(task.councilReport) && (
       <CouncilResultCard report={task.councilReport} />
     )}
     ```

4. **Write tests** in `src/__tests__/app/tasks/council-result-card.test.ts`:
   - Use `// @vitest-environment jsdom` pragma
   - Mock `next/link` and `next-safe-action/hooks` (same pattern as `task-detail-results.test.ts`)
   - Create `makeCouncilReport()` fixture factory returning a valid `CouncilReport`
   - Tests:
     - Renders outcome badge with correct text
     - Renders severity count badges (only for severities with findings > 0)
     - Renders consensus items with file:line and issue text
     - Shows PR comment link when `postedCommentUrl` is set
     - Hides PR comment link when `postedCommentUrl` is null
     - Shows reviewer completion count (`reviewersCompleted/councilSize`)
     - Handles empty findings gracefully (no severity badges shown)

## Must-Haves

- [ ] `TaskWithRelations` has `councilSize: number` and `councilReport: unknown`
- [ ] `CouncilResultCard` renders outcome, severity counts, consensus items, reviewer stats, PR link
- [ ] Card appears in task-detail.tsx after VerificationReportCard, guarded by `isCouncilReport()`
- [ ] 7+ component tests pass
- [ ] Existing 250 tests still pass
- [ ] ≤23 TS errors

## Verification

- `npx vitest run src/__tests__/app/tasks/council-result-card.test.ts` — all tests pass
- `npx vitest run` — all 250+ tests pass
- `npx tsc --noEmit --skipLibCheck 2>&1 | tail -1` — ≤23 errors

## Inputs

- `src/lib/types/tasks.ts`
- `src/lib/council/types.ts`
- `src/app/tasks/[id]/verification-report-card.tsx`
- `src/app/tasks/[id]/task-detail.tsx`
- `src/__tests__/app/tasks/task-detail-results.test.ts`

## Expected Output

- `src/lib/types/tasks.ts`
- `src/app/tasks/[id]/council-result-card.tsx`
- `src/app/tasks/[id]/task-detail.tsx`
- `src/__tests__/app/tasks/council-result-card.test.ts`

## Verification

npx vitest run src/__tests__/app/tasks/council-result-card.test.ts && npx vitest run
