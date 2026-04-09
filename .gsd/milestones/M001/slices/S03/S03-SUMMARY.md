---
id: S03
parent: M001
milestone: M001
provides:
  - execInWorkspace primitive for remote command execution via coder ssh
  - Blueprint type system (BlueprintContext, StepResult, BlueprintStep, BlueprintResult)
  - Sequential blueprint runner with failure/skip/error handling
  - Context hydration step assembling repo tree + key files (R027)
  - Scoped rule injection step reading AGENTS.md files (R026)
  - Curated tool selection step detecting repo type (R030)
  - Agent execution step running Pi --print --no-session in workspace (R003)
  - Full blueprint pipeline wired into BullMQ task-queue worker (R025)
  - getWorkspaceResources and getWorkspaceAgentName on CoderClient
requires:
  - slice: S01
    provides: CoderClient (createWorkspace, getWorkspace, waitForBuild), task-queue worker processor, Prisma schema (Task, TaskLog, Workspace)
affects:
  - S04
  - S06
  - S07
key_files:
  - src/lib/workspace/exec.ts
  - src/lib/blueprint/types.ts
  - src/lib/blueprint/runner.ts
  - src/lib/blueprint/steps/hydrate.ts
  - src/lib/blueprint/steps/rules.ts
  - src/lib/blueprint/steps/tools.ts
  - src/lib/blueprint/steps/agent.ts
  - src/lib/queue/task-queue.ts
  - src/lib/coder/client.ts
  - src/lib/coder/types.ts
key_decisions:
  - execInWorkspace never throws on non-zero exit — always returns structured ExecResult with exitCode/stdout/stderr
  - Blueprint runner uses simple for...of sequential loop — no DAG, no plugin registry (per R025)
  - Context piped to agent via base64 encoding to avoid shell quoting issues
  - Agent timeout 30 minutes; BullMQ job timeout 35 minutes
  - No code changes after agent run is failure, not success
  - Rules step returns 'skipped' not 'failure' when no AGENTS.md exists — rules are optional
  - Tool detection uses exact dependency name matching against known framework lists
  - Non-Node repos get base tools (read, bash, edit, write, lsp) with success status
patterns_established:
  - "[exec]" prefixed logs for remote workspace commands with workspace name, truncated command, exit code
  - "[blueprint]" prefixed logs for step lifecycle (start/complete/fail/skip) with taskId
  - "[queue]" prefixed logs for waitForBuild and blueprint phases in worker
  - Steps mock @/lib/workspace/exec module boundary; dispatch on cmd string content in mockImplementation
  - All blueprint steps use 30s timeout for exec calls (vs 60s default) since they run simple commands
observability_surfaces:
  - "[exec]" console logs for remote command execution
  - "[blueprint] hydrate-context:" log with tree file and key file counts
  - "[blueprint] scoped-rules:" log with rule file count or "no AGENTS.md found"
  - "[blueprint] tool-selection:" log with detected type and tool list
  - "[blueprint] agent-execution:" log for Pi invocation and code change detection
  - taskLogs table records each blueprint step outcome per task
  - tasks.errorMessage contains failed step name + Pi stderr on failure
  - tasks.status transitions: running → done or running → failed
  - workspaces.status updated to 'running' after build completes
drill_down_paths:
  - .gsd/milestones/M001/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S03/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001/slices/S03/tasks/T03-SUMMARY.md
duration: 22m
verification_result: passed
completed_at: 2026-03-19
---

# S03: Blueprint Execution & Worker Agent

**Built the complete blueprint execution pipeline — exec primitive, sequential runner, four deterministic/agent steps, and BullMQ worker integration — so submitting a task now triggers workspace creation → build wait → context hydration → rule injection → tool selection → Pi agent execution → code change verification.**

## What Happened

Three tasks built the pipeline bottom-up:

**T01** established the execution backbone: `execInWorkspace()` wrapping `coder ssh` with login shell (`bash -l`) for nvm/pnpm PATH access, configurable timeout, and structured `{stdout, stderr, exitCode}` returns that never throw. The blueprint type system (`BlueprintContext`, `StepResult`, `BlueprintStep`, `BlueprintResult`) and `runBlueprint()` sequential runner completed the foundation — 12 tests covering exec success/failure/timeout and runner sequencing/error-handling/skip logic.

**T02** added three deterministic pre-agent steps: `createHydrateStep()` fetches repo file tree (up to 200 files) and key files (README, package.json, tsconfig, AGENTS.md, CODEOWNERS) into `ctx.assembledContext`. `createRulesStep()` finds AGENTS.md files up to depth 3 and concatenates them into `ctx.scopedRules` (skips gracefully when none exist). `createToolsStep()` parses package.json dependencies to detect web/test frameworks and builds a curated tool list from base tools (read, bash, edit, write, lsp) plus conditional additions (browser for web apps, test for test frameworks). 11 tests covering all step variants.

**T03** closed the integration: `createAgentStep()` constructs a Pi `--print --no-session` command, pipes assembled context via base64-encoded temp file, runs with 30-minute timeout, and verifies code changes exist via `git diff --stat`. The BullMQ worker processor was extended to: create workspace → `waitForBuild()` → resolve agent name via `getWorkspaceAgentName()` → `runBlueprint([hydrate, rules, tools, agent])` → update task status. Worker tests were rewritten with complete mocks covering the full 8-stage pipeline, blueprint failure surfacing, and workspace creation errors. 10 tests for agent step and worker.

## Verification

- `npx vitest run src/__tests__/lib/workspace/exec.test.ts` — 6 tests pass
- `npx vitest run src/__tests__/lib/blueprint/runner.test.ts` — 6 tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/` — 16 tests pass (hydrate 4, rules 3, tools 4, agent 5)
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — 5 tests pass
- `npx vitest run` — all 53 tests pass (11 test files), zero regressions from S01/S02

## New Requirements Surfaced

- none

## Deviations

none — all three tasks followed the plan as written.

## Known Limitations

- Blueprint execution is unit-tested with mocked `child_process` and mocked exec — no integration test against a real Coder workspace yet. Real end-to-end proof requires S04 (push + PR) to close the loop.
- Context hydration fetches a fixed list of key files; no code search or semantic relevance ranking yet.
- Tool selection only handles Node.js repos with known frameworks; other ecosystems get base tools only.
- Agent step pipes context via temp file + base64 — works but adds a write step that could fail on disk-full scenarios.

## Follow-ups

- none — remaining work is in S04 (CI loop + PR), S05 (verifier), S06 (streaming), S07 (cleanup).

## Files Created/Modified

- `src/lib/workspace/exec.ts` — execInWorkspace remote command primitive wrapping coder ssh
- `src/lib/blueprint/types.ts` — BlueprintContext, StepResult, BlueprintStep, BlueprintResult type definitions
- `src/lib/blueprint/runner.ts` — Sequential blueprint step runner with failure/skip/error handling and duration tracking
- `src/lib/blueprint/steps/hydrate.ts` — Context hydration step: fetches repo tree + key files into ctx.assembledContext
- `src/lib/blueprint/steps/rules.ts` — Scoped rules step: finds AGENTS.md files into ctx.scopedRules
- `src/lib/blueprint/steps/tools.ts` — Tool selection step: detects repo type, selects curated tool list into ctx.toolFlags
- `src/lib/blueprint/steps/agent.ts` — Agent execution step: runs Pi --print --no-session, verifies code changes
- `src/lib/queue/task-queue.ts` — Extended worker processor: waitForBuild → resolveAgent → runBlueprint → status updates
- `src/lib/coder/client.ts` — Added getWorkspaceResources() and getWorkspaceAgentName() methods
- `src/lib/coder/types.ts` — Added WorkspaceAgent and WorkspaceResource types
- `src/__tests__/lib/workspace/exec.test.ts` — 6 tests for exec primitive
- `src/__tests__/lib/blueprint/runner.test.ts` — 6 tests for blueprint runner
- `src/__tests__/lib/blueprint/steps/hydrate.test.ts` — 4 tests for context hydration
- `src/__tests__/lib/blueprint/steps/rules.test.ts` — 3 tests for scoped rules
- `src/__tests__/lib/blueprint/steps/tools.test.ts` — 4 tests for tool selection
- `src/__tests__/lib/blueprint/steps/agent.test.ts` — 5 tests for agent execution
- `src/__tests__/lib/queue/worker.test.ts` — 5 tests for full worker pipeline

## Forward Intelligence

### What the next slice should know
- The blueprint runner returns a `BlueprintResult` with a `steps` array — each entry has `name`, `status`, `message`, `durationMs`. S04 should add its own steps (lint, push, ci, pr) to this same array.
- `execInWorkspace(workspace, agentName, command, options)` is the only way to run commands in workspaces. It uses `coder ssh` under the hood and requires the agent name (resolved via `getWorkspaceAgentName()`).
- The worker in `task-queue.ts` already handles the full create → build → blueprint → status update lifecycle. S04 needs to extend the step array passed to `runBlueprint()`, not create a parallel flow.
- Context is piped to Pi via base64-encoded temp file written with `echo <base64> | base64 -d > /tmp/context.md`. The agent step constructs the full Pi command including `--print --no-session` flags.

### What's fragile
- `execInWorkspace` relies on `coder ssh` being available on the orchestrator's PATH — if the Coder CLI isn't installed in the Next.js container, all remote execution fails silently (exit code from spawn error, not from the remote command).
- The 30-minute agent timeout is a guess — complex tasks on slow models could exceed it. The 35-minute BullMQ timeout gives only 5 minutes of headroom for workspace build + pre-agent steps.

### Authoritative diagnostics
- `taskLogs` table is the source of truth for per-step blueprint outcomes — query by taskId ordered by createdAt to see the full execution trace.
- `tasks.errorMessage` contains the failed step name and error details when status is 'failed' — this is the first thing to check when a task fails.
- Grep for `[blueprint]` and `[exec]` log prefixes in container logs for runtime diagnosis.

### What assumptions changed
- No assumptions changed — the slice executed cleanly per plan. The exec→runner→steps→worker architecture worked as designed.
