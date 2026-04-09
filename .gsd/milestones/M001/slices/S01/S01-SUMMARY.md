---
id: S01
parent: M001
milestone: M001
provides:
  - Next.js 15 App Router project with Docker Compose stack
  - Drizzle ORM schema with tasks, taskLogs, workspaces tables
  - Vitest test framework configured and passing
  - Typed CoderClient class with createWorkspace, getWorkspace, stopWorkspace, deleteWorkspace, waitForBuild methods
  - TypeScript interfaces for all Coder REST API request/response shapes
  - Comprehensive unit tests with mocked fetch (8 tests)
  - IORedis lazy singleton connection with maxRetriesPerRequest:null for BullMQ
  - BullMQ task-dispatch queue and worker with configurable concurrency (default 5)
  - Task API server functions (createTask, getTask, listTasks, updateTaskStatus)
  - Next.js API routes POST/GET /api/tasks and GET /api/tasks/[id]
  - hive-worker Coder template with task parameter variables, Pi/GSD agent, GitHub auth, headless execution (no interactive IDE tools)
key_files:
  - package.json
  - docker-compose.yml
  - lib/db/schema.ts
  - lib/db/index.ts
  - drizzle.config.ts
  - vitest.config.ts
  - lib/coder/types.ts
  - lib/coder/client.ts
  - __tests__/lib/coder/client.test.ts
  - lib/queue/connection.ts
  - lib/queue/task-queue.ts
  - lib/api/tasks.ts
  - app/api/tasks/route.ts
  - app/api/tasks/[id]/route.ts
  - __tests__/lib/queue/worker.test.ts
  - __tests__/lib/api/tasks.test.ts
  - hive-worker/main.tf
  - hive-worker/Dockerfile
  - hive-worker/scripts/init.sh
key_decisions:
  - Next.js dev server needs --hostname 0.0.0.0 flag for Docker container binding
  - drizzle-kit push runs inside app container (host cannot reach Docker bridge network)
  - Response objects can only have their body read once — mock fetch with mockImplementation returning fresh Response per call, not mockResolvedValue with a shared Response
  - Mock @/lib/queue/connection module directly in tests to avoid REDIS_URL env var requirement — mocking ioredis alone is insufficient since the connection module validates env vars before constructing IORedis
  - Removed EXTENSIONS_GALLERY env var and merge() pattern from agent env block since no code-server is included
  - Branch checkout uses fallback (checkout -b || checkout) to handle both new and existing branches
patterns_established:
  - Lazy singleton getDb() pattern for Drizzle + pg Pool
  - Docker Compose with service_healthy conditions for ordered startup
  - Vitest with @/* path alias matching tsconfig
  - CoderClient wraps raw fetch with Coder-Session-Token header injection and structured error messages including HTTP status + body
  - waitForBuild uses exponential backoff (1s start, 5s cap) with immediate throw on 'failed' status
  - Structured console.log with [coder] prefix for all client operations
  - Lazy singleton getRedisConnection() with maxRetriesPerRequest:null — required for BullMQ workers that use blocking Redis commands
  - Task API functions as a service layer between routes and DB/queue — createTask does insert + enqueue + log in one flow
  - Structured console logs with [queue] and [task] prefixes for tracing dispatch and status transitions
  - Branch naming convention: hive/{taskId.slice(0,8)}/{slugified-prompt}
  - HIVE_* env vars injected via Terraform variables into coder_agent env block for task parameterization
observability_surfaces:
  - docker exec m001-postgres-1 psql -U hive -d hive -c '\\dt' — confirms schema presence
  - docker exec m001-app-1 npx drizzle-kit push --force — pushes schema from inside network
  - docker compose ps — shows health of all 3 services
  - [coder] prefix console logs for workspace create/stop/delete/poll operations
  - Error messages include HTTP status code + response body text for debugging
  - waitForBuild logs each poll iteration with current status
  - sessionToken never appears in logs — only used in request headers
  - [queue] prefix logs trace job processing lifecycle
  - [task] prefix logs trace task status transitions
  - taskLogs table records all status changes with timestamps
  - GET /api/tasks/[id] returns task with related workspaces and recent logs
  - Failed tasks: SELECT * FROM tasks WHERE status = 'failed'; SELECT * FROM task_logs WHERE task_id = X ORDER BY created_at DESC
  - init.sh logs repo clone and branch checkout with echo statements for Coder workspace build logs
  - HIVE_TASK_ID, HIVE_TASK_PROMPT, HIVE_REPO_URL, HIVE_BRANCH_NAME available as env vars inside the workspace for agent inspection
verification_result: passed
completed_at: 2026-03-19T10:31:47.079Z
---

# S01: Slice Summary

- **T01**: Scaffolded Next.js 15 project with Postgres + Redis Docker Compose stack, Drizzle ORM schema (tasks/taskLogs/workspaces), and Vitest — all 3 services healthy, schema pushed, 5 tests passing.
- **T02**: Built typed CoderClient class wrapping raw fetch with session token auth, CRUD methods for Coder workspaces, and exponential-backoff polling — all 8 unit tests passing with mocked fetch.
- **T03**: Built Redis connection, BullMQ task-dispatch queue/worker, Task CRUD API functions, and Next.js API routes — POST creates task in Postgres + enqueues BullMQ job, all 22 tests passing, API verified end-to-end in Docker.
- **T04**: Created hive-worker/ Coder template with task parameter variables (task_id, task_prompt, repo_url, branch_name), Pi/GSD agent apps, GitHub auth, and headless execution — removed OpenCode, Claude Code, web3, code-server, and filebrowser.
