# S02: Task Dashboard — Submit & Monitor — Research

**Date:** 2026-03-19
**Depth:** Light — standard Next.js pages consuming existing S01 APIs

## Summary

S02 builds three pages (task list, task detail, task submission form) on top of the S01 API layer. The backend is already solid: `lib/api/tasks.ts` provides `createTask`, `getTask`, `listTasks`, `updateTaskStatus`; API routes exist at `/api/tasks` (POST, GET) and `/api/tasks/[id]` (GET). The DB schema has tasks with status enum (queued/running/verifying/done/failed), taskLogs, and workspaces tables.

The one gap is **file attachments** (R001 says "optional file attachments"). The current schema has no attachment column, the API has no multipart handling, and `createTask` only accepts `{prompt, repoUrl}`. This needs a small schema addition and API extension.

Tailwind CSS v4.2.2 is installed but not configured — needs a `globals.css` with `@import "tailwindcss"` and the layout must import it. No UI component library is installed.

## Recommendation

Build this as plain Next.js App Router pages with Tailwind v4 for styling — no component library needed for 3 pages. Use Server Components for the list/detail pages (fetch data server-side), and a Client Component for the submission form (needs interactivity). Add polling-based status refresh on the list page (setInterval + router.refresh or SWR) — real-time streaming comes in S06.

For file attachments: add an `attachments` JSONB column to the tasks table, extend the API to accept multipart form data, store files as base64 or local file paths (full object storage is overkill for M001). Keep it minimal — the attachment data just needs to reach the worker workspace eventually (S03's concern).

## Implementation Landscape

### Key Files

- `app/globals.css` — **CREATE.** `@import "tailwindcss";` to activate Tailwind v4
- `app/layout.tsx` — **MODIFY.** Import globals.css, add basic layout shell (nav with "Hive" branding)
- `app/page.tsx` — **MODIFY.** Redirect to `/tasks` or render task list directly
- `app/tasks/page.tsx` — **CREATE.** Server Component. Calls `GET /api/tasks`, renders task list with status badges, links to detail view. Auto-refresh via client wrapper with polling.
- `app/tasks/new/page.tsx` — **CREATE.** Client Component. Form with prompt (textarea), repoUrl (input), optional file attachments (file input). POSTs to `/api/tasks` then redirects to task detail.
- `app/tasks/[id]/page.tsx` — **CREATE.** Server Component with client polling wrapper. Calls `GET /api/tasks/[id]`, shows task details (prompt, repo, status, branch, PR link), logs timeline, workspace info. Placeholder area for S06 live streaming.
- `lib/db/schema.ts` — **MODIFY.** Add `attachments` jsonb column to tasks table (nullable).
- `lib/api/tasks.ts` — **MODIFY.** Extend `createTask` input to accept optional `attachments` array.
- `app/api/tasks/route.ts` — **MODIFY.** Handle multipart form data for file uploads in POST, or accept attachments as JSON (simpler for M001).

### Build Order

1. **Tailwind + layout shell** — activate Tailwind v4 CSS, update layout with nav. This unblocks all page styling.
2. **Task list page** (`/tasks`) — consumes existing `GET /api/tasks`. Proves the data layer works end-to-end in the browser.
3. **Task submission form** (`/tasks/new`) — form + POST to API. Extend schema/API for attachments if doing it here, or defer to a sub-task.
4. **Task detail page** (`/tasks/[id]`) — consumes existing `GET /api/tasks/[id]`. Shows logs, status, workspaces. Placeholder for S06 streaming.
5. **Polling for live status** — add client-side polling (setInterval or SWR) to list and detail pages so status updates appear without manual refresh.

### Verification Approach

- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` returns rendered HTML with task list
- Submit a task via the `/tasks/new` form → confirm it appears in the task list with "queued" status
- Navigate to `/tasks/[id]` → confirm task details, logs, and status badge render
- Manually update a task's status via psql → confirm the list/detail pages reflect the change on next poll
- All existing tests still pass: `vitest run`

## Constraints

- Tailwind v4 uses CSS-first configuration (`@import "tailwindcss"` in CSS file) — no `tailwind.config.js` needed
- Docker-in-Docker networking means browser testing must go through Coder's forwarded ports or `docker exec` commands (see KNOWLEDGE.md)
- Next.js 15 App Router: Server Components by default, `"use client"` directive needed for interactive components (forms, polling)
- The task status enum is defined in Postgres via Drizzle's `pgEnum` — any new statuses need migration

## Common Pitfalls

- **Tailwind v4 not loading** — Must have `@import "tailwindcss"` in a CSS file imported by the root layout. The old `@tailwind base/components/utilities` directives don't work in v4.
- **Server vs Client Component confusion** — Form submission and polling need `"use client"`. Data fetching pages should stay as Server Components. Don't accidentally make everything a Client Component.
- **File upload in Next.js App Router** — `NextRequest.formData()` is the API for multipart. Don't try to use body-parser or multer (those are Pages Router / Express patterns).
