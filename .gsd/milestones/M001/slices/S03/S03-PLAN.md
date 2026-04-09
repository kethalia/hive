# S03: Blueprint Execution & Worker Agent

**Goal:** Submitting a task causes a worker workspace to spin up, the blueprint runner sequences deterministic and agent steps (context hydration → scoped rules → tool selection → agent implementation), and the agent produces code changes in the workspace.
**Demo:** POST a task via server action → BullMQ worker creates workspace → waits for build → runs blueprint → `coder ssh <workspace> -- git diff` shows code modifications. No PR or CI yet.

## Must-Haves

- Workspace remote exec primitive (`coder ssh`) with timeout, exit code handling, and stdout/stderr capture
- Blueprint runner that sequences async step functions with error handling and status updates
- Context hydration step that fetches repo tree + key files before agent launch (R027)
- Scoped rule injection that reads AGENTS.md from repo root and subdirectories (R026)
- Curated tool selection based on repo type detection (R030)
- Agent execution step running Pi in `--print` mode inside the workspace (R003)
- BullMQ worker extended to wait for workspace build, then run the full blueprint (R025)
- Unit tests for all modules with mocked `child_process` and mocked dependencies

## Proof Level

- This slice proves: integration (orchestrator → workspace remote execution → agent producing code)
- Real runtime required: yes (for end-to-end proof against real Coder workspace, but unit tests cover logic)
- Human/UAT required: no

## Verification

- `npx vitest run src/__tests__/lib/workspace/exec.test.ts` — exec primitive tests pass
- `npx vitest run src/__tests__/lib/blueprint/runner.test.ts` — runner sequencing, error handling, status updates
- `npx vitest run src/__tests__/lib/blueprint/steps/` — all step tests pass (hydrate, rules, tools, agent)
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — updated worker test covers waitForBuild + runBlueprint flow
- All existing tests continue passing: `npx vitest run`

## Observability / Diagnostics

- Runtime signals: `[blueprint]` prefix logs for step start/complete/fail with taskId, `[exec]` prefix logs for remote command execution with workspace name and exit code
- Inspection surfaces: `taskLogs` table records each blueprint step outcome; `tasks.status` reflects current phase; `workspaces.status` updated to 'running' after build completes
- Failure visibility: Failed step name + error message persisted to `taskLogs`; task status set to 'failed' with `errorMessage` containing the step that failed and why
- Redaction constraints: `CODER_SESSION_TOKEN` and `pi_api_key` never logged; prompt content truncated in logs to 200 chars

## Integration Closure

- Upstream surfaces consumed: `lib/coder/client.ts` (createWorkspace, getWorkspace, waitForBuild), `lib/queue/task-queue.ts` (worker processor), `lib/api/tasks.ts` (updateTaskStatus), Prisma schema (Task, TaskLog, Workspace models)
- New wiring introduced in this slice: `task-queue.ts` worker processor calls `waitForBuild()` then `runBlueprint()` sequentially; blueprint runner calls exec primitive which shells out to `coder ssh`
- What remains before the milestone is truly usable end-to-end: S04 (CI loop + PR generation), S05 (verifier), S06 (live streaming dashboard), S07 (workspace cleanup + prewarming)

## Tasks

- [x] **T01: Build workspace exec primitive, blueprint types, and runner with tests** `est:1h`
  - Why: Everything in S03 depends on two primitives — running commands inside Coder workspaces via `coder ssh`, and sequencing blueprint steps. These must exist and be tested before any step implementation.
  - Files: `src/lib/workspace/exec.ts`, `src/lib/blueprint/types.ts`, `src/lib/blueprint/runner.ts`, `src/__tests__/lib/workspace/exec.test.ts`, `src/__tests__/lib/blueprint/runner.test.ts`
  - Do: (1) Create `exec.ts` wrapping `child_process.execFile("coder", ["ssh", workspace, "--", "bash", "-l", "-c", command])` returning `{stdout, stderr, exitCode}` with configurable timeout. (2) Create `types.ts` with `BlueprintContext`, `StepResult`, `BlueprintStep` function type, `BlueprintResult`. (3) Create `runner.ts` that takes an array of `BlueprintStep` functions and a `BlueprintContext`, runs them in sequence, catches errors per-step, and returns aggregate result. (4) Write unit tests for exec with mocked `child_process.execFile` and for runner with mock step functions.
  - Verify: `npx vitest run src/__tests__/lib/workspace/exec.test.ts src/__tests__/lib/blueprint/runner.test.ts`
  - Done when: Both test files pass, exec handles success/failure/timeout, runner handles step success/failure/skip sequencing

- [x] **T02: Implement context hydration, scoped rules, and tool selection steps with tests** `est:1h`
  - Why: These three deterministic steps run before the agent and directly fulfill R027 (hydration), R026 (rules), and R030 (tools). They use the exec primitive from T01 to run commands inside the workspace.
  - Files: `src/lib/blueprint/steps/hydrate.ts`, `src/lib/blueprint/steps/rules.ts`, `src/lib/blueprint/steps/tools.ts`, `src/__tests__/lib/blueprint/steps/hydrate.test.ts`, `src/__tests__/lib/blueprint/steps/rules.test.ts`, `src/__tests__/lib/blueprint/steps/tools.test.ts`
  - Do: (1) `hydrate.ts` — runs `find` + `cat` via exec to get repo tree listing and key files (README, package.json, AGENTS.md, tsconfig.json, relevant source), assembles into context string on `BlueprintContext.assembledContext`. (2) `rules.ts` — reads AGENTS.md from repo root and task-relevant subdirectories via exec, appends scoped rules to context. (3) `tools.ts` — detects repo type from package.json/file patterns via exec, selects Pi tool flags (read,bash,edit,write base; +browser for web apps; etc.), stores on context. (4) Write tests for each step with mocked exec returning realistic output.
  - Verify: `npx vitest run src/__tests__/lib/blueprint/steps/`
  - Done when: All 3 step test files pass; hydrate produces non-empty assembled context from mocked file system output; rules appends AGENTS.md content; tools returns appropriate flags per repo type

- [x] **T03: Implement agent execution step, wire blueprint into task-queue worker, and update worker tests** `est:1h`
  - Why: This is the integration task that closes the slice — the agent step runs Pi headless (R003), and the BullMQ worker now runs the full blueprint (R025) instead of just creating a workspace.
  - Files: `src/lib/blueprint/steps/agent.ts`, `src/__tests__/lib/blueprint/steps/agent.test.ts`, `src/lib/queue/task-queue.ts`, `src/__tests__/lib/queue/worker.test.ts`, `src/lib/coder/client.ts`, `src/lib/coder/types.ts`
  - Do: (1) `agent.ts` — constructs Pi command (`pi -p --no-session --provider <provider> --model <model>`), pipes assembled context via stdin, runs via exec with 30-min timeout, checks exit code, verifies code changes exist via `git diff --stat`. (2) Add `getWorkspaceAgent()` method to CoderClient that resolves workspace resources to find the agent name for SSH. (3) Extend `task-queue.ts` worker processor: after workspace creation, call `waitForBuild(id, "running")`, resolve agent name, run `runBlueprint()` with the step array [hydrate, rules, tools, agent], update task status based on result. (4) Update worker tests to cover the new waitForBuild + runBlueprint flow with all dependencies mocked.
  - Verify: `npx vitest run src/__tests__/lib/blueprint/steps/agent.test.ts src/__tests__/lib/queue/worker.test.ts` and `npx vitest run` (all tests pass)
  - Done when: Agent step test passes with mocked exec; worker test covers full flow (create workspace → wait → blueprint → status update); all existing tests still pass

## Files Likely Touched

- `src/lib/workspace/exec.ts` (new)
- `src/lib/blueprint/types.ts` (new)
- `src/lib/blueprint/runner.ts` (new)
- `src/lib/blueprint/steps/hydrate.ts` (new)
- `src/lib/blueprint/steps/rules.ts` (new)
- `src/lib/blueprint/steps/tools.ts` (new)
- `src/lib/blueprint/steps/agent.ts` (new)
- `src/lib/queue/task-queue.ts` (modify)
- `src/lib/coder/client.ts` (modify)
- `src/lib/coder/types.ts` (modify)
- `src/__tests__/lib/workspace/exec.test.ts` (new)
- `src/__tests__/lib/blueprint/runner.test.ts` (new)
- `src/__tests__/lib/blueprint/steps/hydrate.test.ts` (new)
- `src/__tests__/lib/blueprint/steps/rules.test.ts` (new)
- `src/__tests__/lib/blueprint/steps/tools.test.ts` (new)
- `src/__tests__/lib/blueprint/steps/agent.test.ts` (new)
- `src/__tests__/lib/queue/worker.test.ts` (modify)
