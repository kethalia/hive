# S04: Council Dashboard — Research

**Slice:** Council Dashboard
**Risk:** Low
**Calibration:** Light research — well-understood UI work following established patterns already in the codebase.

---

## Summary

S04 is pure frontend work: (1) add a `CouncilResultCard` component to the task detail page after `VerificationReportCard`, and (2) add a `councilSize` numeric field (1–7, default 3) to the task submission form. All backend plumbing (types, DB columns, BullMQ processors) is complete from S03. This is straightforward wiring of existing APIs to existing UI patterns.

---

## Recommendation

Follow the `VerificationReportCard` pattern exactly. Minimal risk. Two independent units:
- **T01:** `CouncilResultCard` component + render in `task-detail.tsx`
- **T02:** `councilSize` field on `tasks/new/page.tsx` + `createTaskAction` + `createTask` API

---

## Implementation Landscape

### What exists (complete, don't change)

| File | What it provides |
|------|-----------------|
| `src/lib/council/types.ts` | `CouncilReport`, `AggregatedFinding`, `isCouncilReport()` type guard — exactly what the card needs |
| `src/lib/council/formatter.ts` | `formatCouncilComment()` — markdown formatter (for reference, card renders data directly) |
| `prisma/schema.prisma` | `councilSize Int @default(3)` and `councilReport Json?` already on Task model |
| `src/app/tasks/[id]/verification-report-card.tsx` | The exact component pattern to mirror |
| `src/app/tasks/[id]/task-detail.tsx` | Imports/renders VerificationReportCard — add CouncilResultCard below it |
| `src/lib/types/tasks.ts` | `TaskWithRelations` — needs `councilReport` and `councilSize` fields added |
| `src/lib/api/tasks.ts` | `createTask()` — needs `councilSize` param threaded through |
| `src/lib/actions/tasks.ts` | `createTaskAction` / `createTaskSchema` — needs `councilSize` in schema |
| `src/components/ui/` | `badge`, `card`, `button` all available; no new UI primitives needed |

### CouncilResultCard: what to render

From `CouncilReport` type (all fields available):
- **Outcome badge** (`complete`/`partial`/`inconclusive`) + severity counts (critical/major/minor/nit) from `findings`
- **Consensus items** — `consensusItems` array, grouped/highlighted
- **Footer** — `reviewersCompleted / councilSize`, `postedCommentUrl` link if present

Severity emoji mapping already in `formatter.ts` (copy: 🔴 Critical, 🟠 Major, 🟡 Minor, 💬 Nit).

Card should mirror `VerificationReportCard` structure:
```tsx
<Card>
  <CardHeader><CardTitle>Council Review</CardTitle></CardHeader>
  <CardContent>
    {/* outcome badge + severity count badges */}
    {/* consensus items list — expandable */}
    {/* footer: reviewer completion + PR comment link */}
  </CardContent>
</Card>
```

Use `isCouncilReport()` guard (same pattern as `isVerificationReport()`) — already exported from `types.ts`.

### councilSize field: what to wire

1. `tasks/new/page.tsx` — add `<Input type="number" name="councilSize" min={1} max={7} defaultValue={3} />` in the form
2. `createTaskSchema` in `actions/tasks.ts` — add `councilSize: z.number().int().min(1).max(7).default(3)`
3. `createTask()` in `api/tasks.ts` — thread `councilSize` to `db.task.create()`
4. `TaskWithRelations` in `types/tasks.ts` — add `councilSize: number` and `councilReport: unknown` (use `isCouncilReport()` at render time)

### Task polling / refresh

`task-detail.tsx` already polls `getTaskAction` every 5s when task is active. `getTask()` in `api/tasks.ts` uses `db.task.findUnique({ include: { workspaces, logs } })` — need to verify it selects `councilReport` and `councilSize`. Quick check needed when implementing.

### Type guard integration

`task-detail.tsx` pattern:
```tsx
import { isCouncilReport } from "@/lib/council/types";
// ...
{isCouncilReport(task.councilReport) && (
  <CouncilResultCard report={task.councilReport} />
)}
```

### TS error budget

Currently at 23 errors (exact budget). S04 must not add new TS errors. Add `councilReport` to `TaskWithRelations` as `unknown` (matching how `verificationReport` is typed — `VerificationReport | null` after guard). Check: `verificationReport` in `TaskWithRelations` is `VerificationReport | null`, but the actual Prisma type is `JsonValue`. The type guard handles the conversion at render time.

### Testing

S04 acceptance: "Component tests for CouncilResultCard. Form field test for councilSize. No E2E."

Tests needed:
- `src/__tests__/app/tasks/council-result-card.test.tsx` — render with a mock CouncilReport; verify severity counts render, consensus items show, PR link shows/hides
- `src/__tests__/app/tasks/new/council-size-field.test.tsx` (or add to existing form tests if any) — field presence, default value 3, min/max constraints

No existing `.test.tsx` files in `src/__tests__` — this will be the first. Need to check vitest config for JSX/React support.

### Vitest config check

```bash
cat vitest.config.ts
```
(Should confirm if React Testing Library + jsdom are already configured — if not, may need setup. Worth checking before planning tasks.)

---

## Natural Seams (task decomposition)

**T01: CouncilResultCard component + task-detail integration**
- Files: `src/app/tasks/[id]/council-result-card.tsx` (new), `src/app/tasks/[id]/task-detail.tsx`, `src/lib/types/tasks.ts`
- Verify: component renders correctly for all outcomes; `isCouncilReport` guard tested

**T02: councilSize form field + action + API wiring**
- Files: `src/app/tasks/new/page.tsx`, `src/lib/actions/tasks.ts`, `src/lib/api/tasks.ts`
- Verify: form submits councilSize=5, task created with correct councilSize in DB

These are independent — T01 can be done before or after T02.

---

## Pre-implementation checks for planner

1. Run `cat vitest.config.ts` — confirm JSX transform and test environment (jsdom?) configured before planning component tests
2. Run `grep -n "councilReport\|councilSize" src/lib/api/tasks.ts` to confirm `getTask()` select includes these fields
3. Check if `TaskWithRelations` already has `councilSize` — it currently does NOT (only has `verificationReport: VerificationReport | null`)
