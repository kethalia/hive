---
id: T01
parent: S02
milestone: M001
provides:
  - Tailwind v4 CSS-first activation via globals.css
  - Layout shell with nav (Hive branding, /tasks and /tasks/new links)
  - Root redirect from / to /tasks
  - attachments jsonb column on tasks table
  - createTask accepts optional attachments array
  - POST /api/tasks passes attachments through to createTask
key_files:
  - app/globals.css
  - app/layout.tsx
  - app/page.tsx
  - lib/db/schema.ts
  - lib/api/tasks.ts
  - app/api/tasks/route.ts
  - __tests__/app/tasks/tasks-pages.test.ts
key_decisions:
  - Tailwind v4 uses @import "tailwindcss" CSS-first config, no tailwind.config.js or postcss.config needed
patterns_established:
  - Layout shell pattern: sticky nav with max-w-5xl container, dark theme (bg-gray-900/bg-gray-950)
  - Attachments stored as jsonb array of {name, data, type} objects, nullable
observability_surfaces:
  - "[task] Created task {id}" console.log on task creation
  - POST /api/tasks returns 201 with full task JSON including attachments field
  - POST /api/tasks returns 400 with structured error for missing fields
duration: 10m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T01: Activate Tailwind v4, build layout shell, and extend schema/API for file attachments

**Created globals.css with Tailwind v4 import, layout shell with nav, root redirect, attachments jsonb column, and extended createTask/API to accept file attachments.**

## What Happened

Created `app/globals.css` with `@import "tailwindcss"` for Tailwind v4 CSS-first activation. Updated `app/layout.tsx` to import the CSS, render a sticky nav bar with "Hive" branding and links to /tasks and /tasks/new, and wrap children in a max-width container with dark theme styling. Updated `app/page.tsx` to redirect to `/tasks` using Next.js `redirect()`.

Added `attachments` jsonb column (nullable) to the tasks table in `lib/db/schema.ts`. Extended `createTask` in `lib/api/tasks.ts` to accept an optional `attachments` array and pass it through to the DB insert. Updated the `POST /api/tasks` route to extract and forward the `attachments` field.

Wrote `__tests__/app/tasks/tasks-pages.test.ts` with two tests: one verifying attachments are stored when provided, one verifying null is stored when omitted. Fixed a duplicate-line bug in `lib/api/tasks.ts` that appeared after editing.

Pushed the schema change to the DB inside Docker by copying the updated schema file into the container first (no bind mount).

## Verification

- `vitest run` — all 24 tests pass (5 suites: schema, tasks API, worker, new attachment tests)
- `drizzle-kit push --force` — schema changes applied (attachments column added)
- POST with attachments returns 201 with attachments in response JSON
- POST without attachments returns 201 with `attachments: null`
- Root URL redirects to /tasks (returns 404 since /tasks page not yet built — expected, T02 scope)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run` | 0 | ✅ pass | 3.6s |
| 2 | `docker exec m001-app-1 npx drizzle-kit push --force` | 0 | ✅ pass | 3.3s |
| 3 | `docker exec ... wget POST /api/tasks (with attachments)` | 0 | ✅ pass | 3.5s |
| 4 | `docker exec ... wget POST /api/tasks (without attachments)` | 0 | ✅ pass | ~2s |
| 5 | `docker exec ... wget -qO- http://0.0.0.0:3000/tasks` | 8 | ⏳ expected (T02) | ~3s |
| 6 | `docker exec ... wget -qO- http://0.0.0.0:3000/tasks/new` | 8 | ⏳ expected (T02) | ~3s |

## Diagnostics

- Inspect task creation: `docker exec m001-app-1 wget --post-data='{"prompt":"test","repoUrl":"https://github.com/t/r"}' --header='Content-Type: application/json' -qO- http://0.0.0.0:3000/api/tasks`
- Check attachments column exists: `docker exec m001-postgres-1 psql -U postgres -d hive_orchestrator -c "\d tasks"` — should show `attachments` jsonb column
- Container logs show `[task] Created task {id}` lines for each task creation

## Deviations

- Had to `docker cp` updated source files into the container before `drizzle-kit push` because the Docker setup doesn't use bind mounts — the container has its own file copy.
- Fixed a duplicate-line artifact at end of `lib/api/tasks.ts` caused by an edit collision.

## Known Issues

- Root URL (/) redirect targets `/tasks` which doesn't exist yet — returns 404. Expected: T02 creates the tasks page.
- Docker container files are not automatically synced from the worktree; files must be `docker cp`'d for in-container verification. Dev server hot-reload may not reflect worktree changes.

## Files Created/Modified

- `app/globals.css` — new: Tailwind v4 CSS-first import
- `app/layout.tsx` — updated: imports globals.css, renders sticky nav with Hive branding and links
- `app/page.tsx` — updated: redirects to /tasks via next/navigation redirect()
- `lib/db/schema.ts` — updated: added attachments jsonb column to tasks table, imported jsonb
- `lib/api/tasks.ts` — updated: createTask accepts optional attachments, passes to DB insert
- `app/api/tasks/route.ts` — updated: extracts attachments from request body, passes to createTask
- `__tests__/app/tasks/tasks-pages.test.ts` — new: tests for createTask attachments handling
- `.gsd/milestones/M001/slices/S02/S02-PLAN.md` — updated: added Observability/Diagnostics and failure-path verification sections
