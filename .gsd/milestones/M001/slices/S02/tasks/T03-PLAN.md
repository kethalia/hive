---
estimated_steps: 5
estimated_files: 2
---

# T03: Build task detail page with logs timeline and status polling

**Slice:** S02 — Task Dashboard — Submit & Monitor
**Milestone:** M001

## Description

Build the task detail page at `/tasks/[id]` showing complete task information, a logs timeline, workspace info, and a placeholder for S06 live agent streaming. This page auto-polls for updates when the task is in an active state (queued/running/verifying). Completes R009 (minimal web dashboard).

**Relevant skills:** `react-best-practices` — for Next.js App Router dynamic routes and data fetching patterns.

## Steps

1. Create `app/tasks/[id]/page.tsx` with a Server Component wrapper and Client Component for interactivity:
   - The Server Component receives `params.id`, fetches task data by calling `getTask(id)` directly (server-side import from `@/lib/api/tasks`)
   - Handle 404: if task is null, use `notFound()` from `next/navigation`
   - Pass task data to a Client Component `TaskDetail` for rendering and polling

2. Build the `TaskDetail` client component (in same file or `app/tasks/[id]/task-detail.tsx`):
   - Display task header: status badge (same color scheme as list page), task ID (shortened UUID)
   - Display task info card: full prompt text, repo URL (as clickable link opening in new tab), branch name, PR URL (as link, shown only if present), error message (shown only if present, styled as red alert)
   - Display timestamps: created at, last updated
   - Display attachments section if present: list attachment names and types
   - Display workspaces section: for each workspace show ID, template type, status badge
   - Display logs timeline: ordered list (most recent first) with timestamp and message. Style log levels: `info` → default, `error` → red text

3. Add the S06 streaming placeholder:
   - A card/section titled "Live Agent Activity"
   - Content: "Real-time agent streaming will be available in a future update." styled as muted text
   - This is where `pi-web-ui` components will be wired in S06

4. Implement status polling in the client component:
   - Use `useEffect` + `setInterval` to re-fetch task data via `fetch('/api/tasks/${id}')` every 5 seconds
   - Only poll when task status is `queued`, `running`, or `verifying`
   - Stop polling when status transitions to `done` or `failed`
   - Update displayed data on each successful poll
   - Cleanup interval on unmount

5. Add navigation:
   - "← Back to Tasks" link at the top linking to `/tasks`
   - Breadcrumb-style: Tasks > Task {shortId}

## Must-Haves

- [ ] `/tasks/[id]` page renders task details: prompt, repo URL, status, branch, timestamps
- [ ] Logs timeline shows task log entries with timestamps
- [ ] Workspace info section shows related workspaces
- [ ] PR link displayed and clickable when present
- [ ] Error message displayed as alert when task is failed
- [ ] Auto-polling refreshes data every 5s for active tasks, stops for done/failed
- [ ] S06 placeholder section "Live Agent Activity" exists
- [ ] 404 handling when task ID doesn't exist
- [ ] "Back to Tasks" navigation link

## Verification

- Create a task via API, then `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/<id>` — returns HTML with task details, logs section, and streaming placeholder
- Request a non-existent task ID → returns 404 page
- Manually update task status in DB: `docker exec m001-postgres-1 psql -U hive -d hive -c "UPDATE tasks SET status='running' WHERE id='<id>'"` → detail page reflects new status on next poll cycle
- `vitest run` — all existing tests still pass
- Final end-to-end: POST a task via API → list page shows it → click through to detail page → see full info

## Observability Impact

- **New inspection surface:** `GET /tasks/[id]` renders full task detail HTML including prompt, repo URL, status badge, logs timeline, workspace info, and error message (if failed). Agents can `wget -qO-` this page to inspect task state visually.
- **Polling signal:** Client component fetches `GET /api/tasks/[id]` every 5s for active tasks. Network logs show these polling requests.
- **Failure visibility:** Failed tasks show `errorMessage` as a red alert banner on the detail page. 404 for non-existent task IDs returns the Next.js not-found page.
- **S06 placeholder:** "Live Agent Activity" section is visible in page HTML — future S06 work replaces this with streaming components.

## Inputs

- `lib/api/tasks.ts` — `getTask(id)` returns task with workspaces and logs arrays (from S01)
- `app/api/tasks/[id]/route.ts` — GET endpoint returns task JSON with workspaces + logs (from S01)
- `app/layout.tsx` — layout shell with nav (from T01)
- `app/globals.css` — Tailwind v4 active (from T01)
- `app/tasks/page.tsx` — task list page exists (from T02), linked from "Back to Tasks"
- **Knowledge**: Next.js 15 dynamic routes use `params: Promise<{id: string}>` in page component props. `notFound()` from `next/navigation` triggers the 404 page. Client components fetch via `/api/tasks/[id]` endpoint for polling.

## Expected Output

- `app/tasks/[id]/page.tsx` — complete task detail page with info, logs, workspaces, polling, streaming placeholder
- Optionally `app/tasks/[id]/task-detail.tsx` — client component extracted if file gets too large
