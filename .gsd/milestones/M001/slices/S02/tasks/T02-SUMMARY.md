---
id: T02
parent: S02
milestone: M001
provides:
  - Task list page at /tasks with status badges, relative dates, and polling
  - Task submission form at /tasks/new with prompt, repoUrl, and file attachments
  - TaskListPoller client component for 5-second auto-refresh
  - Fixed createTask TypeScript type to include optional attachments parameter
key_files:
  - app/tasks/page.tsx
  - app/tasks/new/page.tsx
  - app/tasks/task-list-poller.tsx
  - lib/api/tasks.ts
key_decisions:
  - Server Component for task list page (direct DB call via listTasks), client wrapper for polling only
  - Dark theme badge styling with ring borders (bg-*-900/50 + ring-1) matching the layout dark theme
patterns_established:
  - TaskListPoller pattern: client component wrapping server-rendered children, router.refresh() on interval
  - Form submission pattern: Client Component reads files as base64, POSTs JSON to API route, redirects on success
  - Status badge color mapping: queued=blue, running=yellow, verifying=purple, done=green, failed=red
observability_surfaces:
  - /tasks page renders task list with status badges — visual inspection of task states
  - /tasks/new form shows error banner on submission failure (red alert with error message)
  - Form loading state shows "Submitting..." on button during POST
duration: 8m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T02: Build task list page and task submission form with file attachments

**Built task list page at /tasks with status badges, polling, and empty state, plus task submission form at /tasks/new with prompt, repo URL, file attachments, loading/error states.**

## What Happened

Created `app/tasks/page.tsx` as a Server Component that calls `listTasks()` directly and renders a table with status badges (color-coded per status), truncated prompts linking to detail pages, shortened repo URLs (org/repo), and relative dates. The page shows an empty state with a link to create a task when none exist. Wrapped the list in a `TaskListPoller` client component.

Created `app/tasks/task-list-poller.tsx` as a client component that calls `router.refresh()` every 5 seconds to re-fetch server data without a full page reload.

Created `app/tasks/new/page.tsx` as a Client Component with a form containing prompt (textarea, required), repo URL (text input, required), and file attachments (file input, multiple, optional). The submit handler reads files as base64, POSTs JSON to `/api/tasks`, shows "Submitting..." loading state, redirects to `/tasks/{id}` on success, and shows a red error banner on failure.

Fixed the `createTask` type signature in `lib/api/tasks.ts` to include the optional `attachments` parameter that was already being used at runtime but missing from the TypeScript type.

Set `export const dynamic = "force-dynamic"` on the tasks page to ensure fresh data on every request.

## Verification

- `npx vitest run` — all 24 tests pass (5 suites)
- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` — returns HTML with task list table, status badges, prompt links, repo URLs
- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/new` — returns HTML with form elements (textarea, input, file input, button "Create Task")
- Created task via `POST /api/tasks` → 201 with task JSON → task appears in `/tasks` page
- `POST /api/tasks` with empty body → 400 Bad Request (failure path verified)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run` | 0 | ✅ pass | 3.7s |
| 2 | `docker compose up -d --build` | 0 | ✅ pass | 8.8s |
| 3 | `docker exec ... wget -qO- http://0.0.0.0:3000/tasks` | 0 | ✅ pass | ~5s |
| 4 | `docker exec ... wget -qO- http://0.0.0.0:3000/tasks/new` | 0 | ✅ pass | ~3s |
| 5 | `docker exec ... wget POST /api/tasks (valid)` | 0 | ✅ pass | ~3s |
| 6 | `docker exec ... wget POST /api/tasks (empty body)` | 1 (400) | ✅ pass | ~2s |
| 7 | Task appears in /tasks list after creation | — | ✅ pass | — |

## Diagnostics

- Inspect task list: `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` — shows all tasks with status badges
- Inspect form: `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/new` — shows form markup
- Create test task: `docker exec m001-app-1 wget --post-data='{"prompt":"test","repoUrl":"https://github.com/t/r"}' --header='Content-Type: application/json' -qO- http://0.0.0.0:3000/api/tasks`
- Form error state visible when POST fails (red alert banner with error message)

## Deviations

- Fixed `createTask` TypeScript type to include `attachments?` parameter — this was a type-only gap from T01 where the runtime code already handled it but the type signature was incomplete.

## Known Issues

- Task detail page at `/tasks/[id]` does not exist yet — links from task list will 404. Expected: T03 scope.
- Docker container uses copied files, not bind mounts — `docker compose up -d --build` needed to pick up changes.

## Files Created/Modified

- `app/tasks/page.tsx` — new: Server Component task list with status badges, relative dates, empty state, polling wrapper
- `app/tasks/task-list-poller.tsx` — new: Client component wrapping children with 5-second router.refresh() polling
- `app/tasks/new/page.tsx` — new: Client Component form with prompt, repoUrl, file attachments, loading/error states
- `lib/api/tasks.ts` — updated: fixed createTask type signature to include optional attachments parameter
