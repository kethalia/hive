---
estimated_steps: 5
estimated_files: 3
---

# T02: Build task list page and task submission form with file attachments

**Slice:** S02 — Task Dashboard — Submit & Monitor
**Milestone:** M001

## Description

Build the two pages that form the core submit-and-monitor loop: a task list page at `/tasks` showing all tasks with status badges and a task submission form at `/tasks/new` with prompt, repo URL, and optional file attachments. This delivers R001 (task submission) and half of R009 (dashboard list view).

**Relevant skills:** `react-best-practices` — for Next.js App Router patterns, Server vs Client Components. `frontend-design` — for clean, functional Tailwind styling.

## Steps

1. Create `app/tasks/page.tsx` as a **Server Component** that fetches tasks:
   - Import `listTasks` directly from `@/lib/api/tasks` (server-side call, no fetch needed)
   - Render a page header "Tasks" with a "New Task" link/button to `/tasks/new`
   - Render a table or card list with columns: status badge, prompt (truncated to ~80 chars), repo URL (show org/repo only), created date (relative or formatted)
   - Status badge styling: `queued` → blue/`bg-blue-100 text-blue-800`, `running` → yellow/`bg-yellow-100 text-yellow-800`, `verifying` → purple/`bg-purple-100 text-purple-800`, `done` → green/`bg-green-100 text-green-800`, `failed` → red/`bg-red-100 text-red-800`
   - Each row links to `/tasks/[id]`
   - Handle empty state: "No tasks yet. Create your first task."
   - Wrap the list in a client component `TaskListPoller` that calls `router.refresh()` every 5 seconds to get fresh server data

2. Create the `TaskListPoller` client component (can be in same file or separate):
   - `"use client"` directive
   - Uses `useRouter()` and `useEffect` with `setInterval` for 5-second polling
   - Just wraps children and provides the polling behavior

3. Create `app/tasks/new/page.tsx` as a **Client Component** (`"use client"`):
   - Form fields: prompt (textarea, required, placeholder "Describe what you want built..."), repoUrl (text input, required, placeholder "https://github.com/org/repo"), files (file input, multiple, optional, accept any type)
   - Submit handler: reads selected files as base64 using FileReader, constructs `attachments: [{name, data, type}]` array, POSTs JSON to `/api/tasks`, on success redirects to `/tasks/${task.id}` using `router.push()`
   - Show loading state: disable submit button and show "Submitting..." during POST
   - Show error state: red error banner if POST fails
   - Style with Tailwind: card-style form with labels, proper spacing, focus rings on inputs

4. Ensure the task list page and form page are accessible:
   - Labels on all form inputs (via `<label htmlFor>`)
   - Button has visible text
   - Links are keyboard-navigable

5. Rebuild Docker to pick up new pages: `docker compose up -d --build` (if needed, or the dev server hot-reloads)

## Must-Haves

- [ ] `/tasks` page renders task list with status badges and links to detail pages
- [ ] `/tasks` page handles empty state gracefully
- [ ] `/tasks` page has auto-polling that refreshes the list every 5 seconds
- [ ] `/tasks/new` page has form with prompt, repoUrl, and file attachments
- [ ] Form submits JSON to `POST /api/tasks` with attachments as base64
- [ ] Form shows loading state during submission
- [ ] Form redirects to task detail page on success
- [ ] Form shows error message on failure

## Verification

- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` — returns HTML with task list or empty state message
- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/new` — returns HTML with form elements (textarea, input, file input, submit button)
- Create a task via `docker exec m001-app-1 wget --post-data='{"prompt":"test task","repoUrl":"https://github.com/test/repo"}' --header='Content-Type: application/json' -qO- http://0.0.0.0:3000/api/tasks` and verify it appears in the task list page
- `vitest run` — all existing tests still pass

## Inputs

- `app/layout.tsx` — layout shell with nav (from T01) provides the chrome around these pages
- `app/globals.css` — Tailwind v4 active (from T01)
- `lib/api/tasks.ts` — `listTasks()`, `createTask()` with attachments support (from T01)
- `app/api/tasks/route.ts` — POST accepts attachments (from T01)
- **Knowledge**: Next.js App Router: Server Components can directly import and call server-side functions. Client Components need `"use client"` directive and must use `fetch()` for API calls. `useRouter()` from `next/navigation` for client-side navigation.

## Expected Output

- `app/tasks/page.tsx` — task list page with polling, status badges, links
- `app/tasks/new/page.tsx` — task submission form with prompt, repoUrl, file attachments, loading/error states
