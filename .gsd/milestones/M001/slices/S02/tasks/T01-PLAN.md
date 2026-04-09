---
estimated_steps: 8
estimated_files: 7
---

# T01: Activate Tailwind v4, build layout shell, and extend schema/API for file attachments

**Slice:** S02 — Task Dashboard — Submit & Monitor
**Milestone:** M001

## Description

Set up the CSS and layout foundation for all dashboard pages, and extend the data layer to support file attachments (R001). This task activates Tailwind v4, builds a reusable layout shell with navigation, adds an `attachments` jsonb column to the tasks table, and extends the API to accept attachments. All subsequent UI tasks depend on this.

**Relevant skills:** `react-best-practices` — for Next.js App Router patterns (Server Components, redirect, layout nesting).

## Steps

1. Create `app/globals.css` with `@import "tailwindcss";` — this is the v4 CSS-first activation. No `tailwind.config.js` or PostCSS config needed.
2. Update `app/layout.tsx`:
   - Import `./globals.css`
   - Add a `<nav>` with "Hive" branding text (left), links to `/tasks` ("Tasks") and `/tasks/new` ("New Task") (right)
   - Style with Tailwind utility classes: sticky top nav, dark background (`bg-gray-900`), white text, reasonable padding
   - Wrap `{children}` in a main container with max-width and padding
3. Update `app/page.tsx` to redirect to `/tasks`:
   - Import `redirect` from `next/navigation`
   - Call `redirect("/tasks")` in the component body (Server Component redirect)
4. Add `attachments` column to `lib/db/schema.ts`:
   - Import `jsonb` from `drizzle-orm/pg-core`
   - Add to tasks table: `attachments: jsonb("attachments")` (nullable, no default needed)
   - Type: array of `{name: string, data: string, type: string}` — but jsonb is untyped at the DB level
5. Extend `createTask` in `lib/api/tasks.ts`:
   - Add optional `attachments?: Array<{name: string; data: string; type: string}>` to the input type
   - Pass `attachments: input.attachments ?? null` to the db insert values
6. Update `POST /api/tasks` route in `app/api/tasks/route.ts`:
   - Extract `attachments` from request body (optional field)
   - Pass to `createTask({prompt, repoUrl, attachments})`
7. Write `__tests__/app/tasks/tasks-pages.test.ts` with tests:
   - Test that `createTask` with attachments stores them in the task record
   - Test that `createTask` without attachments stores null
   - Follow existing test patterns: mock db, uuid, queue modules
8. Push schema to DB: `docker exec m001-app-1 npx drizzle-kit push --force`

## Must-Haves

- [ ] `app/globals.css` exists with `@import "tailwindcss";`
- [ ] `app/layout.tsx` imports globals.css and renders nav with links to `/tasks` and `/tasks/new`
- [ ] `app/page.tsx` redirects to `/tasks`
- [ ] `lib/db/schema.ts` has `attachments` jsonb column on tasks table
- [ ] `lib/api/tasks.ts` createTask accepts optional attachments
- [ ] `app/api/tasks/route.ts` passes attachments to createTask
- [ ] Tests pass: `vitest run`

## Verification

- `vitest run` — all existing tests pass (22+), new attachment tests pass
- `docker exec m001-app-1 npx drizzle-kit push --force` — succeeds with attachments column
- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/` — returns response (redirect to /tasks or layout HTML)
- POST to `/api/tasks` with attachments field returns 201 with task including attachments

## Inputs

- `app/layout.tsx` — existing bare layout (no CSS import, no nav)
- `app/page.tsx` — existing placeholder page
- `lib/db/schema.ts` — existing schema with tasks, taskLogs, workspaces tables (no attachments column)
- `lib/api/tasks.ts` — existing createTask accepting `{prompt, repoUrl}` only
- `app/api/tasks/route.ts` — existing POST handler extracting prompt + repoUrl
- `__tests__/lib/api/tasks.test.ts` — existing test patterns to follow (mock uuid, ioredis, queue/connection, bullmq)
- **Knowledge**: Tailwind v4 uses `@import "tailwindcss"` not `@tailwind base/components/utilities`. drizzle-kit push runs inside Docker container. Next.js App Router uses `redirect()` from `next/navigation` for server-side redirects.

## Expected Output

- `app/globals.css` — new file with Tailwind v4 import
- `app/layout.tsx` — updated with CSS import and nav shell
- `app/page.tsx` — updated to redirect to /tasks
- `lib/db/schema.ts` — updated with attachments jsonb column
- `lib/api/tasks.ts` — updated createTask signature and insert
- `app/api/tasks/route.ts` — updated POST handler
- `__tests__/app/tasks/tasks-pages.test.ts` — new test file for attachment handling
