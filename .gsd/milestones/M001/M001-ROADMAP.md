# M001: Minimum Viable Hive

**Vision:** Build the complete task-to-PR automation pipeline — submit a task via web dashboard, worker workspace implements it with GSD agent following Stripe's blueprint pattern, verifier workspace proves the output works by consuming it, dashboard shows everything in real-time.

## Success Criteria

- User submits a task via the dashboard and receives a PR on the target repo without any further interaction
- Verifier workspace independently confirms the PR output works by actually using it (browser test, SDK import, etc.)
- Multiple tasks run in parallel without interfering with each other
- Dashboard shows live agent activity, task status progression, and final results with PR links
- Failed tasks (2 CI rounds exhausted) surface clearly in the dashboard as "needs attention"
- Workspaces clean up automatically after task completion

## Key Risks / Unknowns

- **pi-web-ui + Next.js integration** — Lit web components in React have SSR friction and event handling differences
- **RPC through Coder proxy** — Live agent streaming from workspace to browser through Coder's proxy layer is unproven
- **GSD headless execution** — Running GSD fully unattended via Pi print/RPC mode needs validation
- **Context hydration quality** — Pre-fetch quality determines agent success rate; this is iterative, not one-shot

## Proof Strategy

- pi-web-ui + Next.js → retire in S06 by building a working live stream component that renders agent events from a real workspace
- RPC through Coder proxy → retire in S06 by establishing a working websocket/SSE connection from browser to workspace agent
- GSD headless execution → retire in S03 by running a real task end-to-end in a worker workspace without human intervention
- Context hydration quality → retire in S03 by measuring first-attempt success on 3+ test tasks with vs without hydration

## Verification Classes

- Contract verification: API tests for orchestrator, unit tests for blueprint steps, integration tests for Coder API calls
- Integration verification: end-to-end task submission → PR creation → verification report on a real GitHub repo
- Operational verification: docker-compose lifecycle, workspace cleanup, parallel execution under load
- UAT / human verification: submit real tasks across different repo types (web app, SDK, utility) and confirm quality

## Milestone Definition of Done

This milestone is complete only when all are true:

- All 7 slice deliverables are complete and verified
- End-to-end pipeline works: dashboard → task → worker → PR → verifier → results
- At least 2 different task types verified (e.g., bug fix + feature addition)
- Parallel execution proven with 2+ simultaneous tasks
- Dashboard shows live streaming, status, and results for all task states
- Workspaces clean up automatically after grace period
- docker-compose up starts the full stack from scratch

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012, R013, R014, R015, R025, R026, R027, R028, R029, R030, R031
- Partially covers: none
- Leaves for later: R017, R018, R019 (council review — M002)
- Orphan risks: none

## Slices

- [x] **S01: Infrastructure & Orchestrator Core** `risk:high` `depends:[]`
  > After this: docker-compose up starts the Next.js app + Postgres + Redis. Orchestrator can create and destroy Coder workspaces via API. Worker template exists and produces a running workspace with Pi/GSD. Task can be created via API and persisted to Postgres.

- [x] **S02: Task Dashboard — Submit & Monitor** `risk:medium` `depends:[S01]`
  > After this: user opens the web UI, submits a task with prompt + repo + file attachments, sees it appear in the task list with real-time status updates (queued → running → done/failed).

- [x] **S03: Blueprint Execution & Worker Agent** `risk:high` `depends:[S01]`
  > After this: submitting a task causes a worker workspace to spin up, GSD agent runs the blueprint (context hydration → scoped rules → agent implementation loop), and the agent produces code changes in the workspace. Proven by examining workspace output — no PR or CI yet.

- [x] **S04: CI Feedback Loop & PR Generation** `risk:medium` `depends:[S03]`
  > After this: after worker agent finishes, the blueprint's deterministic steps run local lint with autofix, push to GitHub, run CI, feed failures back (2-round cap), and create a PR with templated body. Workspace auto-cleans after completion.

- [x] **S05: Verifier Template & Proof-by-Consumption** `risk:high` `depends:[S04]`
  > After this: after worker PR is created, a verifier workspace auto-spins up, pulls the branch, and tests the output by actually consuming it (browser for web apps, import for SDKs). Verification report is stored and visible via API.

- [x] **S06: Live Agent Streaming & Dashboard Results** `risk:medium` `depends:[S02,S03]`
  > After this: dashboard shows live agent activity via pi-web-ui components connected over RPC. Completed tasks show PR link, CI status, and verification report. The full task lifecycle is visible in the UI.

- [x] **S07: Workspace Lifecycle & Pre-warming** `risk:low` `depends:[S03]`
  > After this: workspaces auto-cleanup after configurable grace period. Coder prebuilt workspace pools configured for worker and verifier templates. Cold start time measured and documented.

## Boundary Map

### S01 → S02

Produces:
- `lib/db/schema.ts` → Task, TaskLog, Workspace Prisma/Drizzle models
- `lib/api/tasks.ts` → createTask(), getTask(), listTasks(), updateTaskStatus() server functions
- `lib/coder/client.ts` → createWorkspace(), deleteWorkspace(), getWorkspaceStatus() Coder API wrapper
- `lib/queue/worker.ts` → task dispatch queue (Redis/BullMQ) with add/process interface
- Docker-compose stack running at localhost

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- `lib/coder/client.ts` → createWorkspace() with template parameters
- `lib/queue/worker.ts` → task dispatch that creates workspaces
- Worker Coder template → `hive-worker/main.tf` with Pi/GSD, task parameter injection
- `lib/db/schema.ts` → Task model with status transitions

Consumes:
- nothing (first slice)

### S03 → S04

Produces:
- Blueprint execution engine → `lib/blueprint/runner.ts` with step sequencing
- Context hydration step → `lib/blueprint/steps/hydrate.ts` producing assembled context
- Agent execution step → `lib/blueprint/steps/agent.ts` running GSD via Pi RPC/print mode
- Scoped rule injection → `lib/blueprint/steps/rules.ts` loading per-repo AGENTS.md
- Curated tool selection → `lib/blueprint/steps/tools.ts` selecting MCP tools per task type
- Worker workspace with code changes ready to push

Consumes from S01:
- `lib/coder/client.ts` → createWorkspace()
- Worker template → workspace with Pi/GSD installed
- `lib/queue/worker.ts` → task dispatch

### S04 → S05

Produces:
- `lib/blueprint/steps/lint.ts` → local lint with autofix (<5s)
- `lib/blueprint/steps/ci.ts` → push, wait for CI, feed failures back, 2-round cap
- `lib/blueprint/steps/pr.ts` → create PR with templated body
- `lib/workspace/cleanup.ts` → workspace stop + delete after grace period
- PR on GitHub with branch, commits, and body

Consumes from S03:
- Blueprint runner → step sequencing
- Agent execution → code changes in workspace

### S03 → S06

Produces:
- Pi RPC endpoint inside workspace → agent event stream (messages, tool calls, progress)
- Blueprint step events → status transitions observable by orchestrator

Consumes from S01:
- Workspace with Pi/GSD running

### S02 → S06

Produces:
- `app/tasks/page.tsx` → task list view with status
- `app/tasks/[id]/page.tsx` → task detail view (placeholder for streaming)
- `app/tasks/new/page.tsx` → task submission form

Consumes from S01:
- `lib/api/tasks.ts` → CRUD operations
- `lib/db/schema.ts` → Task model

### S05 → (terminal)

Produces:
- Verifier Coder template → `hive-verifier/main.tf` with Chrome + testing tools
- `lib/blueprint/verifier.ts` → verifier blueprint (pull branch → detect type → test → report)
- `lib/verification/report.ts` → structured verification report model
- Verification report stored in Postgres, accessible via API

Consumes from S04:
- PR on GitHub (branch to pull)
- `lib/coder/client.ts` → createWorkspace() for verifier
- `lib/workspace/cleanup.ts` → cleanup after verification

### S07 → (terminal)

Produces:
- `hive-worker/main.tf` → prebuilds block in workspace preset
- `hive-verifier/main.tf` → prebuilds block in workspace preset
- Cleanup scheduler → periodic workspace garbage collection
- Documentation: cold start vs warm start benchmarks

Consumes from S03:
- Worker template (to add prebuilds configuration)
- `lib/workspace/cleanup.ts` from S04
