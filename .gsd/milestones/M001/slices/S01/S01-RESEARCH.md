# S01 — Infrastructure & Orchestrator Core — Research

**Date:** 2026-03-19
**Depth:** Targeted (known tech stack, new Coder API integration)

## Summary

S01 is a greenfield slice that builds the foundational infrastructure: a Next.js orchestrator app with Postgres + Redis (via docker-compose), a Coder API client for workspace CRUD, a BullMQ job queue for task dispatch, and a worker Coder template derived from the existing `ai-dev/` template. There is no existing application code — everything must be scaffolded from scratch.

The Coder REST API is well-documented and straightforward: workspace creation via `POST /api/v2/organizations/{org}/members/me/workspaces` with `rich_parameter_values` for task parameters, lifecycle management (start/stop/delete) via `POST /api/v2/workspaces/{id}/builds` with `transition` field. The existing `ai-dev/main.tf` is a production-ready template with Pi/GSD, GitHub auth, Docker, Chrome — it needs only minor modifications (add task parameter variables, strip unnecessary tools) to become the worker template.

The primary risk is getting the Coder API client right — session token auth, polling workspace status until running, error handling for provisioning failures. Everything else (Next.js, Drizzle, BullMQ, docker-compose) follows well-known patterns.

## Recommendation

Scaffold a standard Next.js 15 app with App Router. Use Drizzle ORM with `drizzle-kit` for Postgres schema/migrations. Use BullMQ for the Redis job queue. Wrap the Coder REST API in a typed TypeScript client (no SDK exists for TypeScript — use fetch). Derive the worker template from `ai-dev/` by copying and trimming.

**Build order:** docker-compose first (proves the stack runs), then Drizzle schema + migrations (proves persistence), then Coder client (proves workspace CRUD), then BullMQ queue (proves dispatch), then task API (wires it all together), then worker template (proves end-to-end).

## Requirements Owned

| Req | Description | Research Impact |
|-----|-------------|-----------------|
| R002 | Orchestrator creates isolated Coder workspaces via REST API with task parameters | Coder API is well-documented; `rich_parameter_values` maps directly to template variables |
| R008 | Multiple tasks run concurrently without interference | BullMQ concurrency + separate Coder workspaces provide natural isolation |
| R010 | Task metadata in Postgres, job queue in Redis | Drizzle + BullMQ standard pattern |
| R011 | `docker-compose up` starts the full stack | Next.js + Postgres + Redis compose file |
| R012 | Worker template: Pi/GSD, Node.js, GitHub auth, task parameters | Derive from existing `ai-dev/main.tf` — already has everything except task parameter variables |

## Implementation Landscape

### Key Files

**Existing (to read/derive from):**
- `ai-dev/main.tf` — Full Coder template with Docker provider, agent config, Pi/GSD/Claude Code install scripts, GitHub external auth, VS Code, browser vision. **Base for worker template.** Key pattern: `rich_parameter_values` maps to Terraform `variable` blocks; agent env vars injected via `coder_agent.main.env`
- `ai-dev/Dockerfile` — Ubuntu 24.04 with Docker, Chrome, Node.js 24, build tools. Reuse as-is for worker
- `ai-dev/scripts/tools-ai.sh` — Installs Pi, GSD, configures Pi provider. Template uses `pi_api_key`, `pi_provider`, `pi_model` variables
- `ai-dev/scripts/tools-ci.sh` — Installs `gh` CLI, configures GitHub auth from `coder_external_auth.github.access_token`
- `ai-dev/scripts/init.sh` — One-time workspace setup, dotfiles, README generation

**To create:**
- `docker-compose.yml` — Next.js app (port 3000) + Postgres 16 (port 5432) + Redis 7 (port 6379). Volumes for data persistence
- `package.json` — Next.js 15, drizzle-orm, drizzle-kit, bullmq, ioredis, typescript deps
- `lib/db/schema.ts` — Drizzle schema: `tasks` table (id, prompt, repoUrl, status enum, branch, prUrl, createdAt, updatedAt), `taskLogs` table (id, taskId FK, message, level, timestamp), `workspaces` table (id, taskId FK, coderWorkspaceId, templateType enum, status, createdAt)
- `lib/db/index.ts` — Drizzle client initialization with `drizzle(pool)` using `pg` Pool
- `lib/db/migrate.ts` — Migration runner script
- `drizzle.config.ts` — Drizzle Kit config pointing to schema and Postgres connection
- `lib/coder/client.ts` — Typed Coder REST API client: `createWorkspace(templateId, name, params)`, `deleteWorkspace(workspaceId)`, `getWorkspace(workspaceId)`, `stopWorkspace(workspaceId)`. Uses fetch with `Coder-Session-Token` header. Polls status via `getWorkspace` until `latest_build.status === 'running'`
- `lib/coder/types.ts` — TypeScript types for Coder API request/response shapes
- `lib/queue/worker.ts` — BullMQ Queue + Worker setup. Queue name: `task-dispatch`. Job data: `{ taskId, repoUrl, prompt, parameters }`. Worker processes by calling Coder client to create workspace
- `lib/api/tasks.ts` — Server functions: `createTask()` (insert to Postgres + add to BullMQ queue), `getTask()`, `listTasks()`, `updateTaskStatus()`
- `hive-worker/main.tf` — Derived from `ai-dev/main.tf`. Add variables: `task_id`, `task_prompt`, `repo_url`, `branch_name`. Strip: OpenCode, web3 tools, VS Code extensions that aren't needed. Inject task env vars into agent
- `hive-worker/Dockerfile` — Copy of `ai-dev/Dockerfile` (or symlink)
- `hive-worker/scripts/` — Copy relevant scripts from `ai-dev/scripts/`

### Build Order

1. **Docker-compose + Next.js scaffold** — `docker-compose up` must work first. Proves the infrastructure runs. Creates the app shell that everything else plugs into. Unblocks all other tasks.
2. **Drizzle schema + migrations** — Define task/workspace/log tables, run `drizzle-kit push` against Postgres. Proves persistence works. Unblocks task API.
3. **Coder API client** — Implement typed fetch wrapper for workspace CRUD. Can be tested independently against a real Coder instance. Unblocks queue worker and is the highest-risk piece (external API integration).
4. **BullMQ queue setup** — Queue + Worker that dispatches to Coder client. Proves async task dispatch. Depends on Coder client.
5. **Task API (server functions)** — Wire together: create task → persist → enqueue. Depends on schema + queue.
6. **Worker Coder template** — Derive from `ai-dev/`, add task parameter variables. Can be built in parallel with steps 2-5 since it's Terraform, not TypeScript.

### Verification Approach

1. `docker-compose up` starts all 3 services, Next.js accessible at localhost:3000
2. `npx drizzle-kit push` succeeds, tables visible in Postgres (`docker exec` + `psql`)
3. Coder client unit test: mock fetch responses for create/get/delete workspace
4. Integration test: create a real workspace via Coder API, verify it reaches `running` status, delete it
5. BullMQ test: add a job, verify worker picks it up and calls Coder client
6. Task API test: call `createTask()`, verify row in Postgres + job in Redis queue
7. Worker template: `coder templates push hive-worker` succeeds on a Coder instance

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Postgres ORM + migrations | `drizzle-orm` + `drizzle-kit` | Type-safe schema, auto-generated migrations, lightweight |
| Job queue with Redis | `bullmq` | Battle-tested, supports concurrency, retries, progress tracking, TypeScript native |
| Redis client | `ioredis` | Required by BullMQ, proven reliability |
| Postgres client | `pg` (node-postgres) | Works with Drizzle, connection pooling built-in |
| Coder TypeScript SDK | None exists — use raw `fetch` | Coder REST API is simple enough; typed wrapper is ~100 lines |

## Common Pitfalls

- **BullMQ `maxRetriesPerRequest: null`** — IORedis connection for BullMQ must set `maxRetriesPerRequest: null` or workers will fail with timeout errors. This is a common gotcha.
- **Coder workspace polling** — After `createWorkspace()`, the workspace enters `pending` → `starting` → `running`. Must poll `getWorkspace()` with backoff until `latest_build.status === 'running'` before considering it ready. Don't assume synchronous creation.
- **Drizzle enum vs pgEnum** — Use `pgEnum()` for status fields (task status, workspace status) to get Postgres-native enums with type safety. Define enums before tables that reference them.
- **Docker-compose Postgres readiness** — Next.js container must wait for Postgres to be ready. Use `depends_on` with `condition: service_healthy` and a Postgres healthcheck, not just service ordering.
- **Coder session token scope** — The token used for API calls must have permissions to create workspaces and manage templates. Document which env var provides this (`CODER_SESSION_TOKEN` or `CODER_URL` + `CODER_TOKEN`).

## Open Risks

- **Coder API availability during dev** — The Coder client integration tests require a running Coder instance. If the instance is down or rate-limited, tests will fail. Mitigate with mock-first development and optional integration test flag.
- **Worker template registration** — Pushing a new template to Coder requires `coder templates push` which needs the Coder CLI and appropriate permissions. This is a manual step that can't be fully automated in docker-compose.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Coder workspaces | `jovermier/claude-code-plugins-ip-labs@coder-workspace-management` | available (4 installs) |
| Coder workspaces | `developmentcats/coder-workspaces-skill@coder-workspaces` | available (4 installs) |
| Next.js deployment | `giuseppe-trisciuoglio/developer-kit@nextjs-deployment` | available (188 installs) |
| React/Next.js | react-best-practices | installed |

## Sources

- Coder workspace creation API: `POST /api/v2/organizations/{org}/members/me/workspaces` with `rich_parameter_values` for template variables (source: [Coder API docs](https://coder.com/docs/reference/api))
- Coder workspace lifecycle: start/stop/delete via `POST /api/v2/workspaces/{id}/builds` with `transition` field (source: [Coder API docs](https://coder.com/docs/reference/api))
- BullMQ worker setup requires `maxRetriesPerRequest: null` on IORedis connection (source: [BullMQ docs](https://docs.bullmq.io))
- Drizzle ORM schema with `pgTable`, `pgEnum`, and migration generation via `drizzle-kit generate` (source: [Drizzle docs](https://orm.drizzle.team))
