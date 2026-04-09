# S04: CI Feedback Loop & PR Generation

**Goal:** After the worker agent finishes implementing code changes, the blueprint runs lint with autofix, commits and pushes to a branch, monitors CI, feeds failures back to the agent (2-round cap), and creates a PR with a templated body. Workspaces auto-clean after completion.
**Demo:** Submitting a task causes the agent to produce changes, which are linted, committed, pushed, CI-checked (with one retry round if CI fails), and a PR is opened. The task record shows the PR URL and branch. The workspace is cleaned up after a configurable grace period.

## Must-Haves

- Lint step runs local linter with autofix, completes in <5s (R028), returns success always (best-effort)
- Commit-push step configures git identity, stages all changes, commits with descriptive message, pushes to branch
- PR creation step runs `gh pr create` with templated body, captures PR URL
- CI feedback step polls GitHub Actions for CI result, feeds failures back to agent for one retry round, caps at 2 total CI rounds (R029)
- Worker pipeline extended with lint → commit-push → CI feedback → PR steps after agent
- Task record updated with `prUrl` and `branch` on success (R004)
- Workspace cleanup function stops and deletes workspace after configurable grace period (R015)
- BullMQ job timeout increased to accommodate CI polling + agent retry
- Tasks that exhaust 2 CI rounds are marked `failed` with clear error message

## Proof Level

- This slice proves: contract (all steps unit-tested with mocked execInWorkspace)
- Real runtime required: no (real CI integration is an e2e concern)
- Human/UAT required: no

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/commit-push.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/pr.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/workspace/cleanup.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — updated tests pass (extended pipeline)
- `npx vitest run` — all tests pass, zero regressions
- Failure-path check: lint step returns `status: "success"` even when lint command exits non-zero or times out (exitCode 124); commit-push step returns `status: "failure"` with stderr content when push fails; PR step returns `status: "failure"` with descriptive message when `gh` auth fails or PR already exists — all verified via dedicated test cases

## Observability / Diagnostics

- Runtime signals: `[blueprint] lint:` log with lint outcome; `[blueprint] commit-push:` log with commit hash; `[blueprint] ci-feedback:` log with CI status per round, round count; `[blueprint] pr-create:` log with PR URL; `[cleanup]` log with workspace stop/delete
- Inspection surfaces: `taskLogs` table records each step outcome; `tasks.prUrl` and `tasks.branch` populated on success; `tasks.errorMessage` contains CI exhaustion details on failure
- Failure visibility: CI round count in step message; failed CI logs fed to agent visible in taskLogs; "CI exhaustion after 2 rounds" in errorMessage
- Redaction constraints: none (no secrets in step outputs)

## Integration Closure

- Upstream surfaces consumed: `src/lib/blueprint/types.ts` (BlueprintContext, BlueprintStep, StepResult), `src/lib/blueprint/runner.ts` (runBlueprint), `src/lib/workspace/exec.ts` (execInWorkspace), `src/lib/blueprint/steps/agent.ts` (createAgentStep for retry), `src/lib/coder/client.ts` (stopWorkspace, deleteWorkspace), `src/lib/queue/task-queue.ts` (worker pipeline)
- New wiring introduced in this slice: 4 new blueprint steps added to worker pipeline array; cleanup called after blueprint completes; task record updated with prUrl/branch
- What remains before the milestone is truly usable end-to-end: S05 (verifier), S06 (live streaming + dashboard results), S07 (prewarming + lifecycle)

## Tasks

- [x] **T01: Build lint, commit-push, and PR creation blueprint steps** `est:45m`
  - Why: These three steps are the straightforward parts of the post-agent pipeline — each follows the established BlueprintStep pattern, uses execInWorkspace for remote commands, and returns structured StepResult. Building them first provides the building blocks the CI feedback step needs.
  - Files: `src/lib/blueprint/steps/lint.ts`, `src/lib/blueprint/steps/commit-push.ts`, `src/lib/blueprint/steps/pr.ts`, `src/__tests__/lib/blueprint/steps/lint.test.ts`, `src/__tests__/lib/blueprint/steps/commit-push.test.ts`, `src/__tests__/lib/blueprint/steps/pr.test.ts`
  - Do: Implement three new BlueprintStep factories following the exact pattern in `src/lib/blueprint/steps/agent.ts`. Lint step: detect linter from package.json scripts, run with autofix, 5000ms hard timeout, always return success. Commit-push step: `git config` for Hive Bot identity, `git add -A`, `git commit -m "<message>"`, `git push -u origin <branch>`. PR step: `gh pr create --title --body --base main --head <branch>`, capture PR URL from stdout. Tests mock `execInWorkspace` and dispatch on command content, same pattern as agent.test.ts.
  - Verify: `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts src/__tests__/lib/blueprint/steps/commit-push.test.ts src/__tests__/lib/blueprint/steps/pr.test.ts`
  - Done when: All three step tests pass. Each step handles success, failure, and edge cases (lint timeout, push rejection, PR already exists).

- [x] **T02: Build CI feedback composite step with 2-round retry cap** `est:45m`
  - Why: The CI feedback loop is the most complex piece in S04 — it orchestrates polling GitHub Actions, extracting failure logs, re-invoking the agent for a fix attempt, then re-running lint+push+poll. The 2-round cap (R029) and CI exhaustion surfacing are core requirements. This must be a separate task because the polling/retry logic is substantial.
  - Files: `src/lib/blueprint/steps/ci.ts`, `src/__tests__/lib/blueprint/steps/ci.test.ts`, `src/lib/blueprint/types.ts`
  - Do: Implement `createCIStep(deps)` that accepts injected step factories (lint, commit-push, agent) for testability. The step: (1) polls `gh run list --branch <branch> --limit 1 --json status,conclusion` with exponential backoff (5s→10s→20s→30s cap, 10min timeout), (2) if CI passes → return success, (3) if CI fails round 1 → extract logs via `gh run view <id> --log-failed`, feed failure context to agent step, run lint step, run commit-push step, poll again, (4) if CI fails round 2 → return failure with "CI exhaustion" message. Add optional `ciRoundsUsed` to BlueprintContext. Tests cover: CI passes first time, CI fails then passes on retry, CI fails twice (exhaustion), gh not authenticated, no CI run found (retry with delay).
  - Verify: `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts`
  - Done when: CI step tests pass covering all 5 scenarios. The step correctly caps at 2 rounds and includes CI failure logs in the error message.

- [x] **T03: Wire extended pipeline into worker and add workspace cleanup** `est:40m`
  - Why: The new steps exist but aren't connected to the actual worker pipeline. This task wires lint→commit-push→CI→PR into task-queue.ts after the agent step, persists prUrl/branch to the Task record, adds the workspace cleanup module, and increases the BullMQ job timeout. Without this, the steps are dead code.
  - Files: `src/lib/queue/task-queue.ts`, `src/lib/workspace/cleanup.ts`, `src/__tests__/lib/workspace/cleanup.test.ts`, `src/__tests__/lib/queue/worker.test.ts`
  - Do: (1) Create `cleanupWorkspace(coderClient, workspaceId, graceMs)` — waits grace period, calls stopWorkspace + deleteWorkspace, updates workspace status in DB. (2) In task-queue.ts: import new step factories, add them to the blueprint step array after agent, extract prUrl from CI/PR step results and persist to task record, call cleanupWorkspace in a finally block (success or failure). (3) Increase JOB_TIMEOUT_MS to 90 minutes to accommodate CI polling + agent retry. (4) Update worker.test.ts to verify the extended 8-step pipeline, prUrl persistence, and cleanup invocation. (5) Write cleanup.test.ts.
  - Verify: `npx vitest run src/__tests__/lib/queue/worker.test.ts src/__tests__/lib/workspace/cleanup.test.ts && npx vitest run`
  - Done when: Worker test verifies full extended pipeline with prUrl/branch persistence. Cleanup test verifies stop+delete with grace period. All project tests pass with zero regressions.

## Files Likely Touched

- `src/lib/blueprint/steps/lint.ts`
- `src/lib/blueprint/steps/commit-push.ts`
- `src/lib/blueprint/steps/pr.ts`
- `src/lib/blueprint/steps/ci.ts`
- `src/lib/blueprint/types.ts`
- `src/lib/workspace/cleanup.ts`
- `src/lib/queue/task-queue.ts`
- `src/__tests__/lib/blueprint/steps/lint.test.ts`
- `src/__tests__/lib/blueprint/steps/commit-push.test.ts`
- `src/__tests__/lib/blueprint/steps/pr.test.ts`
- `src/__tests__/lib/blueprint/steps/ci.test.ts`
- `src/__tests__/lib/workspace/cleanup.test.ts`
- `src/__tests__/lib/queue/worker.test.ts`
