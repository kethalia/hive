---
id: T02
parent: S04
milestone: M002
key_files:
  - src/lib/actions/tasks.ts
  - src/lib/api/tasks.ts
  - src/app/tasks/new/page.tsx
  - src/__tests__/app/tasks/tasks-pages.test.ts
key_decisions:
  - Exported createTaskSchema (const → export const) to enable direct schema unit tests without coupling to the action layer
  - Used z.coerce.number() for councilSize so HTML form string inputs are auto-converted
duration: 
verification_result: passed
completed_at: 2026-04-09T11:37:57.402Z
blocker_discovered: false
---

# T02: Added councilSize field (1–7, default 3) to task creation form, wired through Zod schema and server action to DB; 6 new tests pass alongside all 268 existing tests

**Added councilSize field (1–7, default 3) to task creation form, wired through Zod schema and server action to DB; 6 new tests pass alongside all 268 existing tests**

## What Happened

Extended createTaskSchema with councilSize z.coerce.number().int().min(1).max(7).default(3) (exported for testability) and threaded it through createTaskAction to createTask(). Extended the createTask() input type with councilSize?: number and passed councilSize ?? 3 into db.task.create. Added the councilSize numeric Input field to the new-task form and extracted it in handleSubmit. Wrote 6 new tests: 2 API-level (passes value, defaults to 3) and 4 schema-level (rejects 0, rejects 8, accepts 5, defaults to 3).

## Verification

npx vitest run src/__tests__/app/tasks/tasks-pages.test.ts → 8/8 pass (2 existing + 6 new); npx vitest run → 268/268 pass (37 test files); npx tsc --noEmit --skipLibCheck → 18 errors (all pre-existing, threshold ≤23)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/app/tasks/tasks-pages.test.ts` | 0 | ✅ pass | 3100ms |
| 2 | `npx vitest run` | 0 | ✅ pass | 2100ms |
| 3 | `npx tsc --noEmit --skipLibCheck 2>&1 | grep '^src/' | wc -l` | 0 | ✅ pass | 5000ms |

## Deviations

Exported createTaskSchema (changed from const to export const) to allow direct schema unit tests — minor addition not in the original plan but consistent with good testability patterns.

## Known Issues

None.

## Files Created/Modified

- `src/lib/actions/tasks.ts`
- `src/lib/api/tasks.ts`
- `src/app/tasks/new/page.tsx`
- `src/__tests__/app/tasks/tasks-pages.test.ts`
