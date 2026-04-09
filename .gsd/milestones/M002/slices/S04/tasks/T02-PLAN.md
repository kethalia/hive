---
estimated_steps: 48
estimated_files: 4
skills_used: []
---

# T02: councilSize form field with action/API wiring and tests

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

## Inputs

- `src/lib/actions/tasks.ts`
- `src/lib/api/tasks.ts`
- `src/app/tasks/new/page.tsx`
- `src/__tests__/app/tasks/tasks-pages.test.ts`

## Expected Output

- `src/lib/actions/tasks.ts`
- `src/lib/api/tasks.ts`
- `src/app/tasks/new/page.tsx`
- `src/__tests__/app/tasks/tasks-pages.test.ts`

## Verification

npx vitest run src/__tests__/app/tasks/tasks-pages.test.ts && npx vitest run
