# S01: Infrastructure & Orchestrator Core

**Goal:** Docker-compose up starts the full stack (Next.js + Postgres + Redis). Orchestrator can create/destroy Coder workspaces via API. Worker template exists. Tasks can be created via API and persisted to Postgres with job dispatch to Redis.
**Demo:** `docker-compose up` → Next.js at localhost:3000, Postgres + Redis running. POST to `/api/tasks` creates a task row in Postgres, enqueues a BullMQ job, and (when connected to Coder) creates a worker workspace. All tests pass.

## Must-Haves

- `docker-compose up` starts Next.js (port 3000), Postgres (5432), Redis (6379) with health checks
- Drizzle schema with `tasks`, `taskLogs`, `workspaces` tables using pgEnum for status fields
- Typed Coder REST API client: createWorkspace, getWorkspace, stopWorkspace, deleteWorkspace with session token auth and status polling
- BullMQ queue (`task-dispatch`) with worker that dispatches to Coder client, `maxRetriesPerRequest: null` on IORedis
- Task API server functions: createTask (persist + enqueue), getTask, listTasks, updateTaskStatus
- Next.js API routes exposing task CRUD
- hive-worker Coder template derived from ai-dev with task parameter variables (task_id, task_prompt, repo_url, branch_name)
- Test suite covering Coder client (mocked), queue dispatch, and task API

## Proof Level

- This slice proves: contract + operational
- Real runtime required: yes (docker-compose for Postgres/Redis; Coder integration is mocked in tests)
- Human/UAT required: no

## Verification

- `npm test` — all unit/integration tests pass:
  - `__tests__/lib/coder/client.test.ts` — Coder client with mocked fetch (create, get, delete, polling)
  - `__tests__/lib/queue/worker.test.ts` — BullMQ queue add + worker dispatch
  - `__tests__/lib/api/tasks.test.ts` — createTask persists to DB + enqueues job, getTask/listTasks return data
- `docker-compose up -d && curl -s http://localhost:3000` returns HTML (Next.js running)
- `docker-compose exec postgres psql -U hive -d hive -c '\dt'` shows tasks, task_logs, workspaces tables
- `hive-worker/main.tf` contains `variable "task_id"`, `variable "task_prompt"`, `variable "repo_url"`, `variable "branch_name"` blocks

## Observability / Diagnostics

- Runtime signals: structured console logs with `[coder]`, `[queue]`, `[task]` prefixes for each subsystem; task status transitions logged
- Inspection surfaces: `tasks` and `workspaces` DB tables; BullMQ dashboard available via Bull Board (future); `/api/tasks` endpoint returns task list with statuses
- Failure visibility: Coder client errors include HTTP status + response body; BullMQ failed jobs retain error message + stack; task status transitions to `failed` with error details in `taskLogs`
- Redaction constraints: `CODER_SESSION_TOKEN` and `PI_API_KEY` must never appear in logs or API responses

## Integration Closure

- Upstream surfaces consumed: none (first slice)
- New wiring introduced: docker-compose stack, Drizzle DB connection, BullMQ Redis connection, Coder API client, Next.js API routes
- What remains before milestone is truly usable end-to-end: S02 (dashboard UI), S03 (blueprint execution), S04 (CI + PR), S05 (verifier), S06 (live streaming), S07 (lifecycle)

## Tasks

- [x] **T01: Scaffold Next.js app with Docker Compose stack, Drizzle schema, and test framework** `est:1h`
  - Why: Everything depends on the running infrastructure and database schema. This establishes the foundation that all other tasks and downstream slices build on. Covers R010 (Postgres + Redis) and R011 (docker-compose up).
  - Files: `package.json`, `tsconfig.json`, `next.config.ts`, `docker-compose.yml`, `.env.example`, `lib/db/schema.ts`, `lib/db/index.ts`, `drizzle.config.ts`, `app/layout.tsx`, `app/page.tsx`, `vitest.config.ts`
  - Do: Initialize Next.js 15 (App Router, TypeScript). Create docker-compose.yml with Next.js (port 3000), Postgres 16 (port 5432, healthcheck), Redis 7 (port 6379, healthcheck). Use `depends_on` with `condition: service_healthy`. Define Drizzle schema with pgEnum for task_status (queued, running, verifying, done, failed) and workspace_status (pending, starting, running, stopped, deleted, failed). Create tasks table (id uuid PK, prompt text, repoUrl text, status task_status, branch text nullable, prUrl text nullable, createdAt, updatedAt), taskLogs table (id uuid PK, taskId FK, message text, level text, timestamp), workspaces table (id uuid PK, taskId FK, coderWorkspaceId text, templateType text, status workspace_status, createdAt). Set up Vitest with vitest.config.ts. Create .env.example with DATABASE_URL, REDIS_URL, CODER_URL, CODER_SESSION_TOKEN placeholders.
  - Verify: `docker-compose up -d` starts all 3 services. `npx drizzle-kit push` creates tables. `npx vitest run` finds the test config.
  - Done when: docker-compose starts cleanly, schema pushes to Postgres, Vitest config loads

- [x] **T02: Implement typed Coder REST API client with unit tests** `est:45m`
  - Why: The Coder client is the highest-risk piece — no TypeScript SDK exists, we need raw fetch with auth, response typing, and status polling with backoff. This is the foundation for R002 (workspace creation via API). Must be independently testable with mocked fetch.
  - Files: `lib/coder/client.ts`, `lib/coder/types.ts`, `__tests__/lib/coder/client.test.ts`
  - Do: Define TypeScript types for Coder API shapes (Workspace, WorkspaceBuild, CreateWorkspaceRequest with rich_parameter_values). Implement CoderClient class with constructor taking baseUrl + sessionToken. Methods: createWorkspace(templateId, name, richParams) → POST /api/v2/organizations/default/members/me/workspaces; getWorkspace(workspaceId) → GET /api/v2/workspaces/{id}; stopWorkspace(workspaceId) → POST /api/v2/workspaces/{id}/builds with transition:stop; deleteWorkspace(workspaceId) → same with transition:delete; waitForBuild(workspaceId, targetStatus, opts) → polls getWorkspace with exponential backoff until latest_build.status matches or timeout. All methods use fetch with `Coder-Session-Token` header. Write comprehensive unit tests mocking global fetch.
  - Verify: `npx vitest run __tests__/lib/coder/client.test.ts` — all tests pass covering create, get, stop, delete, polling success, polling timeout
  - Done when: Coder client fully typed, all unit tests green

- [x] **T03: Wire BullMQ task dispatch queue, Task API functions, and API routes with tests** `est:1h`
  - Why: This connects persistence (Drizzle) to async dispatch (BullMQ) to HTTP interface (Next.js routes), completing the orchestrator's core data flow. Covers R008 (parallel execution via BullMQ concurrency) and R010 (task state in Postgres + job queue in Redis).
  - Files: `lib/queue/connection.ts`, `lib/queue/task-queue.ts`, `lib/api/tasks.ts`, `app/api/tasks/route.ts`, `app/api/tasks/[id]/route.ts`, `__tests__/lib/queue/worker.test.ts`, `__tests__/lib/api/tasks.test.ts`
  - Do: Create Redis connection module (lib/queue/connection.ts) with IORedis using `maxRetriesPerRequest: null`. Create task dispatch queue (lib/queue/task-queue.ts) with BullMQ Queue named `task-dispatch` and Worker that processes jobs by calling Coder client to create workspace. Implement task server functions (lib/api/tasks.ts): createTask inserts row to Postgres then adds job to BullMQ queue, getTask/listTasks query Postgres, updateTaskStatus updates status + creates taskLog entry. Create Next.js API routes: POST /api/tasks (create), GET /api/tasks (list), GET /api/tasks/[id] (get by id). Write tests: queue test verifies job enqueue + worker processing (mock Coder client), task API test verifies createTask persists + enqueues (use test Postgres from docker-compose).
  - Verify: `npx vitest run __tests__/lib/queue __tests__/lib/api` — all tests pass
  - Done when: POST /api/tasks creates DB row + BullMQ job; GET endpoints return task data; queue worker processes jobs

- [x] **T04: Create hive-worker Coder template derived from ai-dev** `est:45m`
  - Why: The worker template is where agent execution happens. It needs Pi/GSD, GitHub auth, and task parameter injection. Derived from the existing ai-dev template which already has the right base. Covers R012 (worker template with Pi/GSD, Node.js, GitHub auth, task parameters).
  - Files: `hive-worker/main.tf`, `hive-worker/Dockerfile`, `hive-worker/scripts/init.sh`, `hive-worker/scripts/tools-ai.sh`, `hive-worker/scripts/tools-ci.sh`, `hive-worker/scripts/tools-shell.sh`, `hive-worker/scripts/tools-node.sh`, `hive-worker/scripts/tools-nvm.sh`
  - Do: Copy ai-dev/Dockerfile as-is. Copy ai-dev/main.tf and modify: add `variable "task_id"`, `variable "task_prompt"`, `variable "repo_url"`, `variable "branch_name"` blocks. Inject these as env vars into coder_agent.main.env (HIVE_TASK_ID, HIVE_TASK_PROMPT, HIVE_REPO_URL, HIVE_BRANCH_NAME). Remove OpenCode resources (coder_script.opencode_install, coder_app.opencode_terminal, coder_app.opencode_ui, coder_script.opencode_serve), web3 tools (coder_script.tools_web3), VS Code extensions not needed for headless work. Remove code-server module and filebrowser module (headless template). Keep: Pi/GSD apps, GitHub auth (coder_external_auth.github), git modules, AI tools, CI tools, shell tools, node/nvm tools, browser vision (needed for testing), Docker socket mount, resource limits. Copy only the scripts referenced by kept resources.
  - Verify: `terraform -chdir=hive-worker validate` passes (or manual review that main.tf is syntactically valid Terraform). Variables task_id, task_prompt, repo_url, branch_name are present. No references to removed resources.
  - Done when: hive-worker/ directory contains valid Terraform template with task parameter variables, Pi/GSD, GitHub auth, and no unused resources

## Files Likely Touched

- `package.json`
- `tsconfig.json`
- `next.config.ts`
- `docker-compose.yml`
- `.env.example`
- `drizzle.config.ts`
- `vitest.config.ts`
- `app/layout.tsx`
- `app/page.tsx`
- `app/api/tasks/route.ts`
- `app/api/tasks/[id]/route.ts`
- `lib/db/schema.ts`
- `lib/db/index.ts`
- `lib/coder/client.ts`
- `lib/coder/types.ts`
- `lib/queue/connection.ts`
- `lib/queue/task-queue.ts`
- `lib/api/tasks.ts`
- `__tests__/lib/coder/client.test.ts`
- `__tests__/lib/queue/worker.test.ts`
- `__tests__/lib/api/tasks.test.ts`
- `hive-worker/main.tf`
- `hive-worker/Dockerfile`
- `hive-worker/scripts/*.sh`
