---
estimated_steps: 5
estimated_files: 11
---

# T01: Scaffold Next.js app with Docker Compose stack, Drizzle schema, and test framework

**Slice:** S01 — Infrastructure & Orchestrator Core
**Milestone:** M001

## Description

Bootstrap the entire project from scratch: initialize a Next.js 15 App Router project, create docker-compose.yml for the three-service stack (Next.js + Postgres 16 + Redis 7), define the Drizzle ORM schema with all task/workspace/log tables, and configure Vitest as the test framework. This is the foundation every other task and downstream slice depends on.

Relevant installed skills: `react-best-practices` (for Next.js patterns).

## Steps

1. **Initialize Next.js 15 project** — Run `npx create-next-app@latest . --typescript --app --eslint --tailwind --src-dir=false --import-alias="@/*" --use-npm` (or manually create package.json + tsconfig.json + next.config.ts if create-next-app conflicts with existing files). Add dependencies: `drizzle-orm`, `pg`, `bullmq`, `ioredis`, `uuid`. Add dev dependencies: `drizzle-kit`, `@types/pg`, `@types/uuid`, `vitest`, `@vitejs/plugin-react`. Create minimal `app/layout.tsx` and `app/page.tsx` (just a "Hive Orchestrator" heading).

2. **Create docker-compose.yml** — Define three services:
   - `app`: builds from `.` (Dockerfile for Next.js, or use `node:20-alpine` with volume mount for dev), ports 3000:3000, depends on postgres and redis with `condition: service_healthy`, env vars from `.env`
   - `postgres`: image `postgres:16-alpine`, port 5432, env `POSTGRES_USER=hive`, `POSTGRES_PASSWORD=hive`, `POSTGRES_DB=hive`, healthcheck `pg_isready -U hive`, volume for data persistence
   - `redis`: image `redis:7-alpine`, port 6379, healthcheck `redis-cli ping`, volume for data persistence
   
   For dev workflow, the app service should use `npm run dev` with volume mounts so code changes are reflected. Create a `.env.example` with `DATABASE_URL=postgresql://hive:hive@localhost:5432/hive`, `REDIS_URL=redis://localhost:6379`, `CODER_URL=`, `CODER_SESSION_TOKEN=`.

3. **Define Drizzle schema** — Create `lib/db/schema.ts`:
   - `pgEnum('task_status', ['queued', 'running', 'verifying', 'done', 'failed'])`
   - `pgEnum('workspace_status', ['pending', 'starting', 'running', 'stopped', 'deleted', 'failed'])`
   - `tasks` table: id (uuid PK, default gen_random_uuid()), prompt (text, not null), repoUrl (text, not null), status (task_status, default 'queued'), branch (text, nullable), prUrl (text, nullable), errorMessage (text, nullable), createdAt (timestamp, default now()), updatedAt (timestamp, default now())
   - `taskLogs` table: id (uuid PK), taskId (uuid FK → tasks.id), message (text), level (text, default 'info'), createdAt (timestamp, default now())
   - `workspaces` table: id (uuid PK), taskId (uuid FK → tasks.id), coderWorkspaceId (text), templateType (text, default 'worker'), status (workspace_status, default 'pending'), createdAt (timestamp, default now())
   
   Create `lib/db/index.ts`: export a `getDb()` function that creates a drizzle instance with `pg` Pool from `DATABASE_URL` env var. Use lazy singleton pattern.
   
   Create `drizzle.config.ts` pointing to the schema file with `dialect: 'postgresql'` and connection from `DATABASE_URL`.

4. **Configure Vitest** — Create `vitest.config.ts` with path aliases matching tsconfig (`@/*` → `./*`). Configure test file patterns to match `__tests__/**/*.test.ts`. Set environment to `node`.

5. **Verify the stack** — Ensure `docker-compose up -d` starts all services (Postgres and Redis healthy), `npx drizzle-kit push` creates tables in Postgres, and `npx vitest run` finds the config (will report 0 tests but no errors).

## Must-Haves

- [ ] `docker-compose.yml` defines app, postgres, redis services with health checks
- [ ] Postgres uses `service_healthy` condition so app doesn't start before DB is ready
- [ ] Drizzle schema exports `tasks`, `taskLogs`, `workspaces` tables with proper pgEnum types
- [ ] `lib/db/index.ts` exports a `getDb()` function using pg Pool
- [ ] `.env.example` has DATABASE_URL, REDIS_URL, CODER_URL, CODER_SESSION_TOKEN
- [ ] Vitest config present and loadable
- [ ] `package.json` includes all required dependencies (drizzle-orm, pg, bullmq, ioredis, vitest, drizzle-kit)

## Verification

- `docker-compose up -d` — all 3 services healthy within 30s
- `npx drizzle-kit push` — creates tables without errors
- `docker-compose exec postgres psql -U hive -d hive -c '\dt'` — shows tasks, task_logs, workspaces
- `npx vitest run` — exits 0 (no test files yet is OK, config must load)

## Observability Impact

- **New signals:** Drizzle schema defines `tasks`, `taskLogs`, `workspaces` tables — all future task state inspection happens through these tables. `taskLogs` stores per-task log entries with level/message for post-mortem debugging.
- **Inspection:** `docker-compose exec postgres psql -U hive -d hive -c 'SELECT * FROM tasks'` shows all task state. `\dt` confirms schema presence. `docker-compose ps` shows service health.
- **Failure visibility:** If `drizzle-kit push` fails, schema drift is visible via `drizzle-kit diff`. Docker healthchecks surface Postgres/Redis readiness failures via `docker-compose ps`.
- **Redaction:** `.env.example` documents secrets (CODER_SESSION_TOKEN) but `.env` is gitignored; no secrets in committed files.

## Inputs

- No prior work — this is the first task
- Research findings in S01-RESEARCH.md (inlined in slice plan): use pgEnum, pg Pool, service_healthy for docker-compose

## Expected Output

- `package.json` — Next.js 15 project with all dependencies
- `docker-compose.yml` — Three-service stack with health checks
- `lib/db/schema.ts` — Complete Drizzle schema with 3 tables and 2 enums
- `lib/db/index.ts` — Database client singleton
- `drizzle.config.ts` — Drizzle Kit configuration
- `vitest.config.ts` — Test framework configuration
- `app/layout.tsx`, `app/page.tsx` — Minimal Next.js app shell
- `.env.example` — Environment variable template
