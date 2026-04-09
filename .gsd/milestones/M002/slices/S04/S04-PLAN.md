# S04: Council Dashboard

**Goal:** Task detail page shows CouncilResultCard with severity badge counts and consensus items. Task submission form accepts councilSize (1–7, default 3).
**Demo:** Task detail page shows CouncilResultCard after VerificationReportCard, with severity badge counts (critical/major/minor/nit) and highlighted consensus items. Task submission form has a council size numeric field (default 3, 1-7).

## Must-Haves

- CouncilResultCard renders outcome badge, severity counts, consensus items, reviewer completion, and PR comment link
- councilSize field on new task form with min=1 max=7 default=3 wired through action and API to DB
- All existing 250 tests still pass; new component/unit tests pass; ≤23 TS errors

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: CouncilResultCard component with type wiring and tests** `est:45m`
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
  - Files: `src/lib/types/tasks.ts`, `src/app/tasks/[id]/council-result-card.tsx`, `src/app/tasks/[id]/task-detail.tsx`, `src/__tests__/app/tasks/council-result-card.test.ts`
  - Verify: npx vitest run src/__tests__/app/tasks/council-result-card.test.ts && npx vitest run

- [x] **T02: councilSize form field with action/API wiring and tests** `est:30m`
  ## Description

Add a `councilSize` numeric input (1–7, default 3) to the task creation form, wire it through the Zod schema and server action to the `createTask` API so it persists to the database. Write tests proving the wiring works.

## Steps

1. **Add `councilSize` to `createTaskSchema`** in `src/lib/actions/tasks.ts`:
   - Add to schema: `councilSize: z.coerce.number().int().min(1).max(7).default(3)`
   - Use `z.coerce.number()` because HTML form data arrives as string
   - Thread `parsedInput.councilSize` into the `createTask()` call

2. **Add `councilSize` param to `createTask()`** in `src/lib/api/tasks.ts`:
   - Extend the `input` parameter type: add `councilSize?: number`
   - Pass `councilSize: input.councilSize ?? 3` into `db.task.create({ data: { ... } })`

3. **Add form field** in `src/app/tasks/new/page.tsx`:
   - Add a new `<Field>` block between Repository URL and File Attachments:
     ```tsx
     <Field>
       <FieldLabel htmlFor="councilSize">Council Size</FieldLabel>
       <Input
         id="councilSize"
         name="councilSize"
         type="number"
         min={1}
         max={7}
         defaultValue={3}
       />
       <FieldDescription>
         Number of independent reviewers (1–7).
       </FieldDescription>
     </Field>
     ```
   - In `handleSubmit`, extract `councilSize` from formData and pass to `execute()`:
     ```tsx
     const councilSize = parseInt(formData.get("councilSize") as string, 10) || 3;
     execute({ prompt, repoUrl, attachments, councilSize });
     ```

4. **Write/extend tests** in `src/__tests__/app/tasks/tasks-pages.test.ts`:
   - Add a test: `createTask passes councilSize to prisma create` — mock DB, call `createTask({ prompt, repoUrl, councilSize: 5 })`, assert `db.task.create` was called with `data` containing `councilSize: 5`
   - Add a test: `createTask defaults councilSize to 3` — call without councilSize, assert create data has `councilSize: 3`
   - Add a test: `createTaskSchema validates councilSize bounds` — parse with councilSize=0 (fails), councilSize=8 (fails), councilSize=5 (passes)

## Must-Haves

- [ ] `councilSize` field in form with min=1 max=7 default=3
- [ ] `createTaskSchema` includes councilSize with coercion and validation
- [ ] `createTask()` persists councilSize to DB
- [ ] 3+ new tests pass
- [ ] Existing 250 tests still pass
- [ ] ≤23 TS errors

## Verification

- `npx vitest run src/__tests__/app/tasks/tasks-pages.test.ts` — all tests pass (existing + new)
- `npx vitest run` — all 250+ tests pass
- `npx tsc --noEmit --skipLibCheck 2>&1 | tail -1` — ≤23 errors
  - Files: `src/lib/actions/tasks.ts`, `src/lib/api/tasks.ts`, `src/app/tasks/new/page.tsx`, `src/__tests__/app/tasks/tasks-pages.test.ts`
  - Verify: npx vitest run src/__tests__/app/tasks/tasks-pages.test.ts && npx vitest run

## Files Likely Touched

- src/lib/types/tasks.ts
- src/app/tasks/[id]/council-result-card.tsx
- src/app/tasks/[id]/task-detail.tsx
- src/__tests__/app/tasks/council-result-card.test.ts
- src/lib/actions/tasks.ts
- src/lib/api/tasks.ts
- src/app/tasks/new/page.tsx
- src/__tests__/app/tasks/tasks-pages.test.ts
