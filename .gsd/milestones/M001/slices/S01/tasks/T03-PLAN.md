---
estimated_steps: 5
estimated_files: 7
---

# T03: Wire BullMQ task dispatch queue, Task API functions, and API routes with tests

**Slice:** S01 — Infrastructure & Orchestrator Core
**Milestone:** M001

## Description

Build the data flow layer: Redis connection → BullMQ queue + worker → Task API server functions → Next.js API routes. This wires Drizzle persistence (from T01) and the Coder client (from T02) together into a working orchestrator that can accept HTTP requests, persist tasks, and dispatch them to worker workspaces. Covers R008 (parallel execution — BullMQ concurrency config) and R010 (task state in Postgres, job queue in Redis).

## Steps

1. **Create Redis connection module** — Create `lib/queue/connection.ts`:
   - Export `getRedisConnection()` that creates IORedis instance from `REDIS_URL` env var
   - **Critical**: set `maxRetriesPerRequest: null` — BullMQ requires this or workers fail with timeout errors
   - Use lazy singleton pattern (same approach as db/index.ts)

2. **Create BullMQ queue and worker** — Create `lib/queue/task-queue.ts`:
   - Export `getTaskQueue()` returning a BullMQ `Queue` named `task-dispatch` using the shared Redis connection
   - Export `createTaskWorker(coderClient: CoderClient)` that returns a BullMQ `Worker`:
     - Job data shape: `{ taskId: string, repoUrl: string, prompt: string, params: Record<string, string> }`
     - Worker concurrency: 5 (configurable via `WORKER_CONCURRENCY` env var, default 5) — this enables R008 parallel execution
     - Process function: (a) update task status to 'running' via db, (b) call coderClient.createWorkspace with template from `CODER_WORKER_TEMPLATE_ID` env var, workspace name `hive-worker-{taskId.slice(0,8)}`, and rich params including task_id, task_prompt, repo_url, branch_name, (c) insert workspace record into `workspaces` table, (d) log to taskLogs. Wrap in try/catch: on error, update task status to 'failed', log the error.
   - Export type `TaskJobData` for the job payload

3. **Implement Task API server functions** — Create `lib/api/tasks.ts`:
   - `createTask(input: { prompt: string, repoUrl: string })` — generate uuid, insert into tasks table with status 'queued', add job to BullMQ queue with taskId + params, return the created task. Generate branch_name as `hive/{taskId.slice(0,8)}/{slugify(prompt.slice(0,30))}`.
   - `getTask(id: string)` — query tasks table by id, include related workspaces and recent logs (last 50)
   - `listTasks()` — query all tasks ordered by createdAt desc, limit 50
   - `updateTaskStatus(id: string, status: string, errorMessage?: string)` — update task row + insert taskLog entry

4. **Create Next.js API routes** — Create:
   - `app/api/tasks/route.ts` — POST handler calls createTask, returns 201 + task JSON. GET handler calls listTasks, returns 200 + array.
   - `app/api/tasks/[id]/route.ts` — GET handler calls getTask, returns 200 + task JSON or 404.
   - All routes use try/catch with structured error responses `{ error: string }`.

5. **Write tests** — Create:
   - `__tests__/lib/queue/worker.test.ts` — Test queue job addition (mock Redis/queue). Test worker process function: mock CoderClient and DB, verify it calls createWorkspace with correct params, inserts workspace record, updates task status. Test error path: mock CoderClient.createWorkspace throwing, verify task status set to 'failed'.
   - `__tests__/lib/api/tasks.test.ts` — Test createTask: mock db insert + queue add, verify both called with correct args, verify returned task shape. Test getTask: mock db query, verify returned shape. Test listTasks: mock db query, verify ordering.

## Must-Haves

- [ ] IORedis connection has `maxRetriesPerRequest: null`
- [ ] BullMQ worker concurrency is configurable (default 5) for parallel execution
- [ ] Worker process function: updates task status, creates Coder workspace, records workspace in DB
- [ ] `createTask` persists to Postgres AND enqueues to BullMQ in one flow
- [ ] API routes: POST /api/tasks (201), GET /api/tasks (200), GET /api/tasks/[id] (200 or 404)
- [ ] Error paths: worker failures set task status to 'failed' with error in taskLogs
- [ ] Tests cover happy path and error path for both queue worker and task API

## Verification

- `npx vitest run __tests__/lib/queue __tests__/lib/api` — all tests pass
- Manual: `docker-compose up -d`, then `curl -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' -d '{"prompt":"test","repoUrl":"https://github.com/test/repo"}'` returns 201 with task JSON

## Observability Impact

- Signals added: task status transitions logged to `taskLogs` table with timestamp; worker errors logged with full error message
- How a future agent inspects this: query `SELECT * FROM tasks WHERE status = 'failed'` and `SELECT * FROM task_logs WHERE task_id = X ORDER BY created_at DESC`
- Failure state exposed: failed tasks have status='failed' + errorMessage field; failed workspace creation recorded in taskLogs

## Inputs

- `lib/db/schema.ts` — Drizzle schema with tasks, taskLogs, workspaces tables (from T01)
- `lib/db/index.ts` — Database client function (from T01)
- `lib/coder/client.ts` — CoderClient class (from T02)
- `vitest.config.ts` — Test framework (from T01)

## Expected Output

- `lib/queue/connection.ts` — Redis connection with maxRetriesPerRequest:null
- `lib/queue/task-queue.ts` — BullMQ Queue + Worker factory with Coder dispatch
- `lib/api/tasks.ts` — Task CRUD server functions
- `app/api/tasks/route.ts` — POST + GET /api/tasks
- `app/api/tasks/[id]/route.ts` — GET /api/tasks/:id
- `__tests__/lib/queue/worker.test.ts` — Queue + worker tests
- `__tests__/lib/api/tasks.test.ts` — Task API tests
