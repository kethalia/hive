---
id: T03
parent: S01
milestone: M001
provides:
  - IORedis lazy singleton connection with maxRetriesPerRequest:null for BullMQ
  - BullMQ task-dispatch queue and worker with configurable concurrency (default 5)
  - Task API server functions (createTask, getTask, listTasks, updateTaskStatus)
  - Next.js API routes POST/GET /api/tasks and GET /api/tasks/[id]
key_files:
  - lib/queue/connection.ts
  - lib/queue/task-queue.ts
  - lib/api/tasks.ts
  - app/api/tasks/route.ts
  - app/api/tasks/[id]/route.ts
  - __tests__/lib/queue/worker.test.ts
  - __tests__/lib/api/tasks.test.ts
key_decisions:
  - "Mock @/lib/queue/connection module directly in tests to avoid REDIS_URL env var requirement — mocking ioredis alone is insufficient since the connection module validates env vars before constructing IORedis"
patterns_established:
  - "Lazy singleton getRedisConnection() with maxRetriesPerRequest:null — required for BullMQ workers that use blocking Redis commands"
  - "Task API functions as a service layer between routes and DB/queue — createTask does insert + enqueue + log in one flow"
  - "Structured console logs with [queue] and [task] prefixes for tracing dispatch and status transitions"
  - "Branch naming convention: hive/{taskId.slice(0,8)}/{slugified-prompt}"
observability_surfaces:
  - "[queue] prefix logs trace job processing lifecycle"
  - "[task] prefix logs trace task status transitions"
  - "taskLogs table records all status changes with timestamps"
  - "GET /api/tasks/[id] returns task with related workspaces and recent logs"
  - "Failed tasks: SELECT * FROM tasks WHERE status = 'failed'; SELECT * FROM task_logs WHERE task_id = X ORDER BY created_at DESC"
duration: 8m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T03: Wire BullMQ task dispatch queue, Task API functions, and API routes with tests

**Built Redis connection, BullMQ task-dispatch queue/worker, Task CRUD API functions, and Next.js API routes — POST creates task in Postgres + enqueues BullMQ job, all 22 tests passing, API verified end-to-end in Docker.**

## What Happened

Created the full data flow layer wiring Drizzle persistence (T01) and CoderClient (T02) together:

1. **Redis connection** (`lib/queue/connection.ts`) — Lazy singleton IORedis with `maxRetriesPerRequest: null` (critical for BullMQ blocking commands) and env var validation.

2. **BullMQ queue + worker** (`lib/queue/task-queue.ts`) — `getTaskQueue()` returns a singleton Queue named `task-dispatch`. `createTaskWorker(coderClient)` creates a Worker with configurable concurrency (default 5 via `WORKER_CONCURRENCY` env, R008). Worker process: updates task to 'running' → creates Coder workspace with rich params → records workspace in DB → logs to taskLogs. Error path: catches exceptions, sets task to 'failed' with error message, logs error, re-throws for BullMQ.

3. **Task API functions** (`lib/api/tasks.ts`) — `createTask` generates UUID + branch name (`hive/{id.slice(0,8)}/{slug}`), inserts task row, enqueues BullMQ job, and logs creation. `getTask` returns task with related workspaces and last 50 logs. `listTasks` returns 50 most recent tasks. `updateTaskStatus` updates status + inserts taskLog entry.

4. **Next.js API routes** — POST /api/tasks (201 + task JSON), GET /api/tasks (200 + array), GET /api/tasks/[id] (200 + task with relations or 404). All routes have try/catch with structured `{ error }` responses.

5. **Tests** — 4 worker tests (queue add, worker process happy path, worker concurrency, error path) and 5 task API tests (createTask persists + enqueues, branch naming, getTask with relations, getTask not found, listTasks ordering).

## Verification

1. `npx vitest run` — 22/22 tests pass (5 schema + 8 coder + 4 queue + 5 task API)
2. `docker compose up -d --build` — all 3 services healthy
3. POST /api/tasks from inside container — returns 201 with task JSON, status=queued, branch=hive/{id}/{slug}
4. GET /api/tasks — returns array with the created task
5. GET /api/tasks/[id] — returns task with empty workspaces array and taskLog entry
6. DB inspection: tasks table has row with correct status; task_logs table has creation log entry

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run` | 0 | ✅ pass | 0.4s |
| 2 | `docker compose up -d --build` | 0 | ✅ pass | 8s |
| 3 | `docker exec m001-app-1 wget -qO- --post-data='...' http://0.0.0.0:3000/api/tasks` | 0 | ✅ pass | 2s |
| 4 | `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/api/tasks` | 0 | ✅ pass | 1s |
| 5 | `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/api/tasks/{id}` | 0 | ✅ pass | 1s |
| 6 | `docker exec m001-postgres-1 psql -U hive -d hive -c '\dt'` | 0 | ✅ pass | 1s |

### Slice-Level Verification Status

| Check | Status | Notes |
|-------|--------|-------|
| `npm test` — all tests pass | ✅ | 22/22 tests across 4 files |
| `docker-compose up -d && curl localhost:3000` returns HTML | ✅ | Verified via docker exec (DinD limitation) |
| `\dt` shows tasks, task_logs, workspaces tables | ✅ | All 3 tables present |
| `hive-worker/main.tf` contains variable blocks | ⏳ | Not yet created (later task in slice) |

## Diagnostics

- **Test inspection:** `npx vitest run __tests__/lib/queue __tests__/lib/api` reruns queue and task API tests
- **API endpoint:** `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/api/tasks` lists all tasks
- **Task detail:** `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/api/tasks/{id}` returns task with workspaces + logs
- **DB inspection:** `docker exec m001-postgres-1 psql -U hive -d hive -c 'SELECT id, status FROM tasks'`
- **Failed tasks:** `docker exec m001-postgres-1 psql -U hive -d hive -c "SELECT * FROM tasks WHERE status = 'failed'"`
- **Task logs:** `docker exec m001-postgres-1 psql -U hive -d hive -c "SELECT * FROM task_logs WHERE task_id = 'X' ORDER BY created_at DESC"`
- **Log prefixes:** `[queue]` for job processing, `[task]` for status transitions

## Deviations

- Added `@/lib/queue/connection` module mock in both test files — mocking `ioredis` alone was insufficient because `getRedisConnection()` validates the `REDIS_URL` env var before constructing IORedis. Direct module mock bypasses this cleanly.

## Known Issues

- Docker port forwarding doesn't work from host in this Coder DinD environment (inherited from T01). All API testing uses `docker exec` with `wget` instead of `curl` from host.

## Files Created/Modified

- `lib/queue/connection.ts` — IORedis lazy singleton with maxRetriesPerRequest:null for BullMQ compatibility
- `lib/queue/task-queue.ts` — BullMQ Queue + Worker factory with Coder workspace dispatch and error handling
- `lib/api/tasks.ts` — Task CRUD server functions (createTask, getTask, listTasks, updateTaskStatus)
- `app/api/tasks/route.ts` — POST + GET /api/tasks route handlers
- `app/api/tasks/[id]/route.ts` — GET /api/tasks/:id route handler with 404 support
- `__tests__/lib/queue/worker.test.ts` — 4 tests for BullMQ queue and worker (happy + error paths)
- `__tests__/lib/api/tasks.test.ts` — 5 tests for Task API functions (create, get, list)
