---
id: T01
parent: S01
milestone: M001
provides:
  - Next.js 15 App Router project with Docker Compose stack
  - Drizzle ORM schema with tasks, taskLogs, workspaces tables
  - Vitest test framework configured and passing
key_files:
  - package.json
  - docker-compose.yml
  - lib/db/schema.ts
  - lib/db/index.ts
  - drizzle.config.ts
  - vitest.config.ts
key_decisions:
  - "Next.js dev server needs --hostname 0.0.0.0 flag for Docker container binding"
  - "drizzle-kit push runs inside app container (host cannot reach Docker bridge network)"
patterns_established:
  - "Lazy singleton getDb() pattern for Drizzle + pg Pool"
  - "Docker Compose with service_healthy conditions for ordered startup"
  - "Vitest with @/* path alias matching tsconfig"
observability_surfaces:
  - "docker exec m001-postgres-1 psql -U hive -d hive -c '\\dt' — confirms schema presence"
  - "docker exec m001-app-1 npx drizzle-kit push --force — pushes schema from inside network"
  - "docker compose ps — shows health of all 3 services"
duration: 12m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T01: Scaffold Next.js app with Docker Compose stack, Drizzle schema, and test framework

**Scaffolded Next.js 15 project with Postgres + Redis Docker Compose stack, Drizzle ORM schema (tasks/taskLogs/workspaces), and Vitest — all 3 services healthy, schema pushed, 5 tests passing.**

## What Happened

Created the full project foundation from scratch: Next.js 15 App Router with TypeScript, three-service Docker Compose stack (app + Postgres 16 + Redis 7), Drizzle ORM schema with pgEnum types for task and workspace statuses, and Vitest test framework.

Key fix from the previous failed attempt: Next.js 15 requires `--hostname 0.0.0.0` in the dev script for the server to bind to all interfaces inside the Docker container. Without this, the app only listens on localhost inside the container and is unreachable. Also, in this Coder DinD environment, Docker port forwarding to the host doesn't work — `drizzle-kit push` must be run inside the app container (`docker exec m001-app-1 npx drizzle-kit push --force`), and curl verification uses `docker exec` or container IPs.

The schema defines three tables (tasks, task_logs, workspaces) with two pgEnum types (task_status, workspace_status) matching the slice plan exactly. A schema validation test suite with 5 tests verifies all exports.

## Verification

1. `docker compose up -d --build` — all 3 services start, Postgres and Redis pass health checks
2. `docker exec m001-app-1 npx drizzle-kit push --force` — creates tables without errors
3. `docker exec m001-postgres-1 psql -U hive -d hive -c '\dt'` — shows tasks, task_logs, workspaces
4. `npx vitest run` — 5 tests pass (schema structure validation)
5. `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000` — returns HTML with "Hive Orchestrator"

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `docker compose up -d --build` | 0 | ✅ pass | 47s |
| 2 | `docker exec m001-app-1 npx drizzle-kit push --force` | 0 | ✅ pass | 5s |
| 3 | `docker exec m001-postgres-1 psql -U hive -d hive -c '\dt'` | 0 | ✅ pass | 1s |
| 4 | `npx vitest run` | 0 | ✅ pass | 0.3s |
| 5 | `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000 \| grep Hive` | 0 | ✅ pass | 2s |

## Diagnostics

- **Service health:** `docker compose ps` shows all 3 services with health status
- **Schema inspection:** `docker exec m001-postgres-1 psql -U hive -d hive -c '\dt'` lists tables; `-c '\d tasks'` shows columns
- **App logs:** `docker logs m001-app-1` shows Next.js startup and request logs
- **Schema drift:** `docker exec m001-app-1 npx drizzle-kit diff` detects schema differences

## Deviations

- Added `--hostname 0.0.0.0` to the `dev` script in package.json (not in original plan) — required for Next.js to bind to all interfaces in Docker
- `drizzle-kit push` runs inside the app container via `docker exec` instead of from host — Docker bridge network unreachable from host in this Coder DinD environment
- `curl http://localhost:3000` doesn't work from host due to DinD port forwarding limitation — verified via `docker exec` instead

## Known Issues

- Docker port forwarding (localhost:3000, localhost:5432, localhost:6379) doesn't work from the Coder workspace host. All service access must go through `docker exec` or container IPs. This affects how T03's API routes will be tested — integration tests need to either run inside the container or use a test database.

## Files Created/Modified

- `package.json` — Next.js 15 project with drizzle-orm, pg, bullmq, ioredis, vitest dependencies
- `tsconfig.json` — TypeScript config with @/* path alias
- `next.config.ts` — Minimal Next.js configuration
- `docker-compose.yml` — Three-service stack (app, postgres, redis) with health checks
- `Dockerfile` — Node 20 Alpine dev image with HOSTNAME=0.0.0.0
- `.dockerignore` — Excludes node_modules, .next, .git, .gsd
- `.env` — Local environment variables (gitignored)
- `.env.example` — Template with DATABASE_URL, REDIS_URL, CODER_URL, CODER_SESSION_TOKEN
- `.gitignore` — Standard Next.js + GSD ignores
- `lib/db/schema.ts` — Drizzle schema with tasks, taskLogs, workspaces tables and pgEnum types
- `lib/db/index.ts` — Lazy singleton getDb() with pg Pool
- `drizzle.config.ts` — Drizzle Kit config pointing to schema and DATABASE_URL
- `vitest.config.ts` — Vitest config with @/* alias and __tests__ pattern
- `app/layout.tsx` — Root layout with metadata
- `app/page.tsx` — Home page with "Hive Orchestrator" heading
- `__tests__/lib/db/schema.test.ts` — 5 tests validating schema exports
