---
id: M001
provides:
  - Complete task-to-PR automation pipeline (dashboard → queue → worker → lint → CI → PR → verifier → report)
  - Next.js 15 orchestrator with Postgres + Redis via Docker Compose
  - Prisma schema with tasks, taskLogs, workspaces tables
  - CoderClient wrapping Coder REST API for workspace CRUD and polling
  - BullMQ task dispatch queue with configurable concurrency (default 5)
  - Task submission dashboard with status badges, polling, and file attachments
  - Blueprint execution engine — sequential TypeScript step runner (not DSL)
  - 4 pre-agent steps (hydrate context, scoped rules, tool selection, agent execution)
  - 4 post-agent steps (lint autofix, commit-push, CI feedback loop, PR creation)
  - CI feedback loop with 2-round cap and failure log extraction
  - Verifier pipeline with adaptive strategy detection (test-suite, web-app, static-site, none)
  - SSE-based live agent streaming from workspace to browser
  - Verification report display with strategy/outcome badges and collapsible logs
  - Prebuilt workspace pools (worker 2 instances, verifier 1 instance)
  - Periodic cleanup scheduler as safety net for leaked workspaces
  - hive-worker and hive-verifier Coder workspace templates
key_decisions:
  - D001 Never push directly to main — all changes via PR
  - D002 BullMQ with IORedis for task dispatch (maxRetriesPerRequest null required)
  - D003 typescript.ignoreBuildErrors for ioredis/bullmq type conflicts
  - D004 Prisma instead of Drizzle ORM (user preference)
  - D005 next-safe-action v8 + zod for server actions
  - D006 Sequential async functions via coder ssh for blueprint execution
  - D007 Verifier failure is informational — task still set to done
  - D008 Dual-workspace lifecycle — worker + verifier tracked independently
  - D009 Custom React components over SSE instead of pi-web-ui Lit components
  - D010 Agent stdout tee-to-logfile + coder ssh tail for streaming
patterns_established:
  - Blueprint step factory pattern — createXStep() returns { name, execute(ctx) => StepResult }
  - execInWorkspace wrapping coder ssh with structured ExecResult (never throws)
  - Composite steps orchestrate sub-steps via injected factories for testability
  - Base64 encoding for shell-transported strings (PR body, commit messages, context)
  - Lazy singleton getDb()/getRedisConnection() for shared resources
  - TaskListPoller pattern — client component wrapping server-rendered children
  - SSE route pattern — Web ReadableStream + TextEncoder for streaming responses
  - EventSource mock pattern for component testing
  - Structured console logging with prefixes for all subsystems
  - vi.useFakeTimers + advanceTimersByTimeAsync for polling/sleep loop tests
observability_surfaces:
  - "[coder]" logs for workspace CRUD and polling operations
  - "[queue]" logs for job processing lifecycle
  - "[blueprint]" logs for step lifecycle with taskId
  - "[exec]" logs for remote workspace commands
  - "[stream]" logs for SSE spawn/close/error/abort
  - "[cleanup]" and "[cleanup-scheduler]" logs for workspace teardown
  - taskLogs table records all status changes with timestamps per task
  - tasks.errorMessage contains failed step name + error details
  - tasks.prUrl and tasks.branch populated on successful PR creation
  - tasks.verificationReport JSON column with strategy/outcome/logs/duration
  - GET /api/tasks/[id] returns full task with workspaces and recent logs
  - SSE endpoint at /api/tasks/[id]/stream for live agent output
  - docker compose ps shows health of all 3 services
requirement_outcomes:
  - id: R001
    from_status: active
    to_status: validated
    proof: POST /api/tasks with prompt, repoUrl, attachments. Submission form at /tasks/new. 2 API tests + form rendering tests.
  - id: R002
    from_status: active
    to_status: validated
    proof: CoderClient.createWorkspace() with task parameters. 8 client tests. Worker pipeline creates workspace.
  - id: R003
    from_status: active
    to_status: validated
    proof: Pi --print --no-session via execInWorkspace. 5 agent step tests + 12 worker pipeline tests.
  - id: R004
    from_status: active
    to_status: validated
    proof: createPRStep + createCommitPushStep with base64 encoding. 10 tests.
  - id: R005
    from_status: active
    to_status: validated
    proof: Lint (5s timeout, always success) + CI (2-round cap, failure extraction). 9 tests.
  - id: R008
    from_status: active
    to_status: validated
    proof: BullMQ concurrency=5, isolated Coder workspaces per task.
  - id: R009
    from_status: active
    to_status: validated
    proof: Task list/detail/submission pages with streaming and verification display. 26+ UI tests.
  - id: R010
    from_status: active
    to_status: validated
    proof: Prisma schema in Postgres, BullMQ on Redis. 5 schema tests.
  - id: R011
    from_status: active
    to_status: validated
    proof: docker-compose.yml with health checks, verified running in S01.
  - id: R012
    from_status: active
    to_status: validated
    proof: hive-worker template with Pi/GSD, GitHub auth, task parameters.
  - id: R014
    from_status: active
    to_status: validated
    proof: SSE streaming + AgentStreamPanel. 19 tests. Custom React over SSE (D009).
  - id: R015
    from_status: active
    to_status: validated
    proof: Inline cleanup + periodic scheduler. 9 tests.
  - id: R025
    from_status: active
    to_status: validated
    proof: 8-step blueprint pipeline in sequential runner. 18 tests.
  - id: R026
    from_status: active
    to_status: validated
    proof: AGENTS.md scoped rule injection. 4 tests.
  - id: R027
    from_status: active
    to_status: validated
    proof: Repo tree + key files context hydration. 4 tests.
  - id: R030
    from_status: active
    to_status: validated
    proof: Repo type detection + curated tool list. 4 tests.
  - id: R031
    from_status: active
    to_status: validated
    proof: Prebuilds configured, terraform validate passes, benchmarks documented.
duration: ~4h across 7 slices
verification_result: passed
completed_at: 2026-03-20
---

# M001: Minimum Viable Hive

**Built the complete task-to-PR automation pipeline with behavioral verification — submit a task via the dashboard, worker agent implements it following Stripe's blueprint pattern, verifier proves the output works by consuming it, dashboard shows everything in real-time with live agent streaming.**

## What Happened

Seven slices built the system bottom-up over approximately 4 hours:

**S01 (Infrastructure & Orchestrator Core)** laid the foundation: Next.js 15 app with Docker Compose (Postgres + Redis), Prisma schema for tasks/taskLogs/workspaces, typed CoderClient wrapping the Coder REST API, BullMQ task dispatch queue with configurable concurrency, Task CRUD API with server functions and routes, and the hive-worker Coder template with Pi/GSD agent and task parameter injection. 22 tests established the baseline.

**S02 (Task Dashboard)** built the user interface: task list page with status badges and 5-second polling, task submission form with prompt/repoUrl/file attachments, task detail page with logs timeline and workspace info. Tailwind v4 CSS-first activation, dark theme layout shell, and client/server component patterns for date serialization and polling.

**S03 (Blueprint Execution & Worker Agent)** created the execution backbone: `execInWorkspace()` remote command primitive via `coder ssh`, the blueprint type system and sequential runner, and four pre-agent steps — context hydration (repo tree + key files), scoped rule injection (AGENTS.md), curated tool selection (repo type detection), and agent execution (Pi `--print --no-session` with base64-encoded context). The BullMQ worker was extended to orchestrate the full create → build → blueprint lifecycle. 33 tests.

**S04 (CI Feedback Loop & PR Generation)** added the post-agent pipeline: lint with autofix (5s hard timeout, always succeeds), commit-push with base64-encoded messages, CI feedback composite step (poll GitHub Actions, extract failure logs, retry agent, 2-round cap), and PR creation with templated body capturing the URL. Workspace cleanup was added as fire-and-forget in the finally block. The worker pipeline grew from 4 to 8 steps. 27 tests.

**S05 (Verifier Template & Proof-by-Consumption)** built behavioral verification: hive-verifier Coder template (derived from worker, no AI tools, has Chrome), 4 verifier blueprint steps (clone → detect strategy → execute → report), adaptive strategy detection (test-suite / web-app / static-site / none), and orchestration wiring that auto-triggers verification after PR creation. Verification reports are persisted as JSON on the task record. 18 tests.

**S06 (Live Agent Streaming & Dashboard Results)** connected the user-facing gap: `streamFromWorkspace()` spawn-based streaming primitive, SSE Route Handler relaying agent output from workspace to browser, AgentStreamPanel with EventSource and connection status indicator, and VerificationReportCard with strategy/outcome badges and collapsible logs. The agent step was modified to tee stdout to a log file for streaming. 35 tests.

**S07 (Workspace Lifecycle & Pre-warming)** closed the operational loop: prebuilt workspace pools configured for both templates (worker: 2 instances, verifier: 1), container lifecycle stability via `ignore_changes` on name, `listWorkspaces` method on CoderClient, periodic cleanup scheduler as safety net for leaked workspaces, and benchmark documentation. 9 tests.

## Cross-Slice Verification

| Success Criterion | Status | Evidence |
|---|---|---|
| User submits task → receives PR without further interaction | ✅ Contract-verified | S02 submission form → S01 queue dispatch → S03 blueprint execution → S04 lint/CI/PR. 8-step pipeline wired in task-queue.ts. 148 tests pass. |
| Verifier independently confirms PR output works | ✅ Contract-verified | S05 verifier auto-triggered after PR creation. 4-step blueprint with strategy detection. 18 verifier tests + 4 integration tests in worker.test.ts. |
| Multiple tasks run in parallel | ✅ Architecture-verified | BullMQ concurrency=5, each task gets isolated Coder workspace. Not load-tested against real infrastructure. |
| Dashboard shows live activity + status + results | ✅ Contract-verified | S02 task list/detail with polling. S06 SSE streaming panel + verification report card + PR link. 35 S06 tests. |
| Failed tasks (2 CI rounds) surface clearly | ✅ Contract-verified | S04 CI step returns failure with exhaustion message. S02 renders failed badge + errorMessage. 5 CI tests prove 2-round cap. |
| Workspaces clean up automatically | ✅ Contract-verified | S04 cleanup in finally block. S07 periodic scheduler. 9 cleanup tests. |
| docker-compose up starts full stack | ✅ Operationally verified | S01 verified all 3 services healthy, schema pushed, API responding in Docker. |

**Gaps:** The Definition of Done requires "at least 2 different task types verified" and "parallel execution proven with 2+ simultaneous tasks." These are contract-verified through architecture and unit tests but not integration-proven against real Coder/GitHub infrastructure. Real end-to-end validation requires a running Coder instance with configured templates and GitHub external auth.

## Requirement Changes

- R001: active → validated — POST /api/tasks with prompt, repoUrl, attachments. Submission form at /tasks/new.
- R002: active → validated — CoderClient.createWorkspace() with task parameters. 8 client tests.
- R003: active → validated — Pi --print --no-session via execInWorkspace. 5 agent step tests.
- R004: active → validated — createPRStep + createCommitPushStep. 10 tests.
- R005: active → validated — Lint (5s timeout, always success) + CI (2-round cap, failure extraction). 9 tests.
- R008: active → validated — BullMQ concurrency=5, isolated workspaces per task.
- R009: active → validated — Task list/detail/submission pages with streaming and verification display.
- R010: active → validated — Prisma schema in Postgres, BullMQ on Redis.
- R011: active → validated — docker-compose.yml with health checks, verified running.
- R012: active → validated — hive-worker template with Pi/GSD, GitHub auth, task parameters.
- R014: active → validated — SSE streaming + AgentStreamPanel. 19 tests. Custom React over SSE (D009).
- R015: active → validated — Inline cleanup + periodic scheduler. 9 tests.
- R025: active → validated — 8-step blueprint pipeline in sequential runner. 18 tests.
- R026: active → validated — AGENTS.md scoped rule injection. 4 tests.
- R027: active → validated — Repo tree + key files context hydration. 4 tests.
- R030: active → validated — Repo type detection + curated tool list. 4 tests.
- R031: active → validated — Prebuilds configured, terraform validate passes, benchmarks documented.

Previously validated (unchanged): R006, R007, R013, R028, R029.

## Forward Intelligence

### What the next milestone should know
- The full pipeline is contract-tested (148 unit tests) but has no integration tests against real Coder/GitHub infrastructure. M002 should assume the pipeline works architecturally but may need adjustments when first deployed against real services.
- The worker pipeline is an 8-step sequential array in `src/lib/queue/task-queue.ts`. Adding council review (M002) should happen after the PR step — look for `tasks.prUrl` as the trigger signal, same pattern as the verifier.
- `execInWorkspace(workspace, agentName, command, options)` is the single primitive for all remote command execution. It wraps `coder ssh` and never throws — always returns structured `{stdout, stderr, exitCode}`.
- The cleanup scheduler (`startCleanupScheduler`) is implemented but NOT wired to the application entrypoint. This must be done during deployment/integration.
- pi-web-ui integration was consciously deferred (D009). The SSE text streaming approach works for MVP but lacks structured event rendering.

### What's fragile
- **Workspace name sync** — SSE route constructs workspace names using `hive-worker-${taskId.slice(0,8)}` which must match the naming convention in `src/lib/coder/client.ts`. No shared constant; convention-enforced only.
- **`coder` CLI dependency** — `execInWorkspace` relies on `coder ssh` being available on the orchestrator's PATH. If the Coder CLI isn't installed in the Next.js container, all remote execution fails.
- **CI polling timeout** — 10-minute hardcoded timeout in CI step. Repos with slow CI will be treated as "no CI run found."
- **`gh` auth in workspaces** — PR creation and CI polling assume `gh` is authenticated. No pre-flight check exists.
- **Preset parameter names** — `coder_workspace_preset` parameter map keys must exactly match variable block names. No compile-time validation.

### Authoritative diagnostics
- `taskLogs` table ordered by `createdAt` — full execution trace per task with step-level outcomes
- `tasks.errorMessage` — first thing to check when a task fails (contains step name + error details)
- `tasks.prUrl` / `tasks.branch` — proof of successful PR creation (null = pipeline didn't reach that point)
- `tasks.verificationReport` — JSON with strategy/outcome/logs/duration
- Console log prefixes: `[coder]`, `[queue]`, `[blueprint]`, `[exec]`, `[stream]`, `[cleanup]`, `[cleanup-scheduler]`

### What assumptions changed
- **pi-web-ui Lit components** — Originally planned for live agent activity display. Replaced with custom React components over SSE (D009) to avoid SSR friction. Simpler and sufficient for MVP.
- **Pi RPC for streaming** — Originally planned for agent event streaming. Replaced with agent stdout tee-to-logfile + coder ssh tail (D010). Avoids Redis pub/sub complexity.
- **Drizzle ORM** — Originally scaffolded with Drizzle in S01, switched to Prisma (D004) per user preference.

## Files Created/Modified

### Infrastructure (S01)
- `package.json` — Next.js 15 project with Prisma, BullMQ, Vitest
- `docker-compose.yml` — App + Postgres + Redis with health checks
- `prisma/schema.prisma` — Task, TaskLog, Workspace models + verificationReport column
- `src/lib/db/index.ts` — Lazy singleton Prisma client
- `src/lib/coder/client.ts` — CoderClient with workspace CRUD, polling, listWorkspaces
- `src/lib/coder/types.ts` — Coder REST API TypeScript interfaces
- `src/lib/queue/connection.ts` — IORedis lazy singleton
- `src/lib/queue/task-queue.ts` — BullMQ queue + 8-step worker pipeline + verifier trigger
- `src/lib/api/tasks.ts` — Task CRUD + getVerificationReport server functions
- `src/app/api/tasks/route.ts` — POST/GET /api/tasks
- `src/app/api/tasks/[id]/route.ts` — GET /api/tasks/[id]
- `templates/hive-worker/main.tf` — Worker Coder template with prebuilds
- `templates/hive-worker/Dockerfile` — Ubuntu 24.04 with Docker, Chrome, Node.js

### Dashboard (S02)
- `src/app/globals.css` — Tailwind v4 CSS-first activation
- `src/app/layout.tsx` — Dark theme layout shell with nav
- `src/app/tasks/page.tsx` — Task list with status badges
- `src/app/tasks/new/page.tsx` — Task submission form
- `src/app/tasks/[id]/page.tsx` — Task detail server component
- `src/app/tasks/[id]/task-detail.tsx` — Task detail client component with polling

### Blueprint Execution (S03)
- `src/lib/workspace/exec.ts` — execInWorkspace via coder ssh
- `src/lib/blueprint/types.ts` — BlueprintContext, StepResult, BlueprintStep types
- `src/lib/blueprint/runner.ts` — Sequential blueprint step runner
- `src/lib/blueprint/steps/hydrate.ts` — Context hydration step
- `src/lib/blueprint/steps/rules.ts` — Scoped rule injection step
- `src/lib/blueprint/steps/tools.ts` — Tool selection step
- `src/lib/blueprint/steps/agent.ts` — Agent execution step (Pi --print)

### CI + PR (S04)
- `src/lib/blueprint/steps/lint.ts` — Lint autofix step (5s timeout, always succeeds)
- `src/lib/blueprint/steps/commit-push.ts` — Git commit + push step
- `src/lib/blueprint/steps/pr.ts` — PR creation step
- `src/lib/blueprint/steps/ci.ts` — CI feedback composite step (2-round cap)
- `src/lib/workspace/cleanup.ts` — Workspace stop + delete

### Verifier (S05)
- `templates/hive-verifier/main.tf` — Verifier Coder template with prebuilds
- `src/lib/verification/report.ts` — Verification report types
- `src/lib/blueprint/verifier.ts` — Verifier blueprint factory
- `src/lib/blueprint/steps/verify-clone.ts` — Clone + checkout step
- `src/lib/blueprint/steps/verify-detect.ts` — Strategy detection step
- `src/lib/blueprint/steps/verify-execute.ts` — Strategy execution step
- `src/lib/blueprint/steps/verify-report.ts` — Report generation step

### Streaming + Dashboard Results (S06)
- `src/lib/workspace/stream.ts` — streamFromWorkspace spawn-based primitive
- `src/app/api/tasks/[id]/stream/route.ts` — SSE Route Handler
- `src/app/tasks/[id]/agent-stream-panel.tsx` — Live streaming panel
- `src/app/tasks/[id]/verification-report-card.tsx` — Verification report display
- `src/lib/types/tasks.ts` — VerificationReportData type
- `src/lib/helpers/format.ts` — outcomeVariant + formatDuration helpers

### Workspace Lifecycle (S07)
- `src/lib/workspace/scheduler.ts` — Periodic cleanup scheduler
- `docs/workspace-benchmarks.md` — Cold-start vs warm-start benchmarks

### Tests (148 total across 25 files)
- 25 test files covering all subsystems with zero regressions
