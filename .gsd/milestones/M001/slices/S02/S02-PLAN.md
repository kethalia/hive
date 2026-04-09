# S02: Task Dashboard — Submit & Monitor

**Goal:** User can submit tasks and monitor their status through a web dashboard
**Demo:** Open the web UI, submit a task with prompt + repo + optional file attachments, see it appear in the task list with real-time status updates (queued → running → done/failed). Navigate to task detail to see logs and status progression.

## Must-Haves

- Tailwind v4 activated with `@import "tailwindcss"` in globals.css, imported by root layout
- Layout shell with navigation (Hive branding, link to task list, link to new task)
- `attachments` jsonb column added to tasks table in Drizzle schema
- `POST /api/tasks` accepts optional `attachments` array (JSON body, not multipart — simpler for M001)
- Task list page at `/tasks` showing all tasks with status badges, linked to detail view
- Task submission form at `/tasks/new` with prompt (textarea), repoUrl (input), optional file attachments
- Task detail page at `/tasks/[id]` showing task info, status badge, logs timeline, workspace info
- Client-side polling on list and detail pages so status updates appear without manual refresh
- Placeholder area on detail page for S06 live agent streaming
- All existing tests pass (`vitest run`)

## Verification

- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` returns rendered HTML containing task list markup
- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/new` returns rendered HTML containing form elements
- Submit a task via `docker exec m001-app-1 wget --post-data='{"prompt":"test","repoUrl":"https://github.com/test/repo"}' --header='Content-Type: application/json' -qO- http://0.0.0.0:3000/api/tasks` → returns 201 with task JSON including null attachments field
- `vitest run` — all existing + new tests pass
- `__tests__/app/tasks/tasks-pages.test.ts` — unit tests for API route handling of attachments field

## Observability / Diagnostics

- **Runtime signals:** `[task]` prefixed console.log lines in `lib/api/tasks.ts` trace task creation, status transitions, and queue enqueue events. `[api]` prefixed lines in route handlers trace request errors.
- **Inspection surfaces:** `GET /api/tasks` returns all tasks with status; `GET /api/tasks/[id]` returns task with logs timeline and workspaces. Task detail page shows status badge, error message (if failed), and logs timeline.
- **Failure visibility:** Failed tasks show `errorMessage` in both API response and detail page UI (styled as alert). API routes return structured `{ error: string }` JSON with appropriate HTTP status codes (400/500). Console errors are logged with `[api]` prefix for container log inspection.
- **Redaction constraints:** No secrets in task data. Repo URLs and prompts are user-provided and displayed as-is. File attachment `data` field contains base64 content — not logged, only stored in DB jsonb column.

## Verification (Failure Path)

- Submit a task with missing fields via `docker exec m001-app-1 wget --post-data='{}' --header='Content-Type: application/json' -qO- http://0.0.0.0:3000/api/tasks` → returns 400 with `{ error: "Missing required fields: prompt, repoUrl" }`

## Integration Closure

- Upstream surfaces consumed: `lib/api/tasks.ts` (createTask, getTask, listTasks), `lib/db/schema.ts` (tasks, taskLogs, workspaces), `app/api/tasks/route.ts`, `app/api/tasks/[id]/route.ts`
- New wiring introduced in this slice: Tailwind CSS pipeline, globals.css import in layout, dashboard pages consuming API routes
- What remains before the milestone is truly usable end-to-end: S03 (worker agent), S04 (CI/PR), S05 (verifier), S06 (live streaming in detail page placeholder)

## Tasks

- [x] **T01: Activate Tailwind v4, build layout shell, and extend schema/API for file attachments** `est:45m`
  - Why: Every page needs Tailwind for styling and the layout shell for navigation. The attachments column and API extension are needed before the submission form can use them. This is the foundation for all UI work.
  - Files: `app/globals.css`, `app/layout.tsx`, `app/page.tsx`, `lib/db/schema.ts`, `lib/api/tasks.ts`, `app/api/tasks/route.ts`, `__tests__/app/tasks/tasks-pages.test.ts`
  - Do: (1) Create `app/globals.css` with `@import "tailwindcss";`. (2) Update `app/layout.tsx` to import globals.css, add a nav bar with "Hive" branding and links to `/tasks` and `/tasks/new`. (3) Update `app/page.tsx` to redirect to `/tasks` using `redirect()` from `next/navigation`. (4) Add `attachments` jsonb column (nullable) to tasks table in `lib/db/schema.ts` — use `jsonb("attachments")` from drizzle-orm/pg-core. (5) Extend `createTask` in `lib/api/tasks.ts` to accept optional `attachments` in input and pass it to the insert. (6) Update `POST /api/tasks` route to pass `attachments` from request body to `createTask`. (7) Write tests verifying attachments flow through API. (8) Push schema: `docker exec m001-app-1 npx drizzle-kit push --force`. Tailwind v4 uses CSS-first config — no tailwind.config.js needed. PostCSS config is NOT needed for Tailwind v4 with Next.js.
  - Verify: `vitest run` passes. `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/` shows styled layout with nav. Schema push succeeds.
  - Done when: Tailwind classes render, layout has nav, attachments column exists in DB, createTask accepts attachments

- [x] **T02: Build task list page and task submission form with file attachments** `est:1h`
  - Why: The task list is the dashboard home — users need to see all tasks and their statuses. The submission form is the entry point for creating tasks (R001). Together they cover the core submit-and-see loop.
  - Files: `app/tasks/page.tsx`, `app/tasks/new/page.tsx`, `app/tasks/layout.tsx` (optional)
  - Do: (1) Create `app/tasks/page.tsx` as a Server Component that fetches tasks via `fetch('/api/tasks')` (internal fetch with absolute URL or direct import of `listTasks`). Render a table/list with columns: status badge (colored by status), prompt (truncated), repo, created date, link to `/tasks/[id]`. Include a client wrapper component for polling (setInterval calling router.refresh every 5s). Add a "New Task" button/link to `/tasks/new`. Handle empty state gracefully. (2) Create `app/tasks/new/page.tsx` as a Client Component (`"use client"`). Form fields: prompt (textarea, required), repoUrl (text input, required), file attachments (file input, multiple, optional). On submit: read files as base64 strings, POST JSON to `/api/tasks` with `{prompt, repoUrl, attachments: [{name, data, type}]}`, redirect to `/tasks/[id]` on success. Show loading state during submission and error state on failure. Style everything with Tailwind utility classes. Status badges: green for done, yellow for running/verifying, blue for queued, red for failed.
  - Verify: `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` returns HTML with task list structure. `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/new` returns HTML with form elements.
  - Done when: Task list page renders with status badges and links. Submission form accepts prompt, repo URL, and optional files, POSTs to API, and redirects to detail page.

- [x] **T03: Build task detail page with logs timeline and status polling** `est:45m`
  - Why: Users need to drill into individual tasks to see full details, status history (via logs), workspace info, and eventually live agent streaming (S06). This completes R009.
  - Files: `app/tasks/[id]/page.tsx`
  - Do: (1) Create `app/tasks/[id]/page.tsx` with a Server Component that fetches task data via `fetch('/api/tasks/[id]')` or direct import of `getTask`. Display: task ID, full prompt, repo URL (as link), status badge, branch name, PR link (if present, as clickable link), error message (if failed, styled as alert), created/updated timestamps. (2) Render logs timeline: ordered list of task logs with timestamp and message, most recent first. (3) Show workspace info section if workspaces exist: workspace ID, template type, status. (4) Add a client polling wrapper that refreshes data every 5s when status is queued/running/verifying (stop polling when done/failed). (5) Add a placeholder section "Live Agent Activity" with a note "Real-time streaming will be available in a future update" — this is where S06 will plug in pi-web-ui components. (6) Add a "Back to Tasks" link. Style with Tailwind — use a clean card-based layout.
  - Verify: Create a task via API, then `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/<id>` returns HTML with task details, logs, and status badge. Manually update task status via psql and confirm the page reflects the change on next poll.
  - Done when: Detail page renders task info, logs timeline, workspace info, polling refreshes on active tasks, S06 placeholder exists, all existing tests still pass.

## Files Likely Touched

- `app/globals.css`
- `app/layout.tsx`
- `app/page.tsx`
- `app/tasks/page.tsx`
- `app/tasks/new/page.tsx`
- `app/tasks/[id]/page.tsx`
- `lib/db/schema.ts`
- `lib/api/tasks.ts`
- `app/api/tasks/route.ts`
- `__tests__/app/tasks/tasks-pages.test.ts`
