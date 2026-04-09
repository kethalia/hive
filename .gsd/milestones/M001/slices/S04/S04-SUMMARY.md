---
id: S04
parent: M001
milestone: M001
provides:
  - createLintStep factory — best-effort lint autofix, always returns success (R028)
  - createCommitPushStep factory — git identity, stage, commit, push to branch
  - createPRStep factory — gh pr create with templated body, captures PR URL (R004)
  - createCIStep composite factory — polls GitHub Actions, extracts failure logs, retries agent once, 2-round cap (R029)
  - cleanupWorkspace function — stop + delete workspace with configurable grace period (R015)
  - 8-step worker pipeline (hydrate → rules → tools → agent → lint → commit-push → ci → pr)
  - prUrl and branch persistence on task record
requires:
  - slice: S01
    provides: CoderClient (stopWorkspace, deleteWorkspace), task-queue worker, Prisma schema
  - slice: S03
    provides: Blueprint runner, BlueprintStep/StepResult types, execInWorkspace, createAgentStep, worker pipeline foundation
affects:
  - S05
  - S06
  - S07
key_files:
  - src/lib/blueprint/steps/lint.ts
  - src/lib/blueprint/steps/commit-push.ts
  - src/lib/blueprint/steps/pr.ts
  - src/lib/blueprint/steps/ci.ts
  - src/lib/workspace/cleanup.ts
  - src/lib/queue/task-queue.ts
  - src/__tests__/lib/blueprint/steps/lint.test.ts
  - src/__tests__/lib/blueprint/steps/commit-push.test.ts
  - src/__tests__/lib/blueprint/steps/pr.test.ts
  - src/__tests__/lib/blueprint/steps/ci.test.ts
  - src/__tests__/lib/workspace/cleanup.test.ts
  - src/__tests__/lib/queue/worker.test.ts
key_decisions:
  - Base64 encoding for PR title/body and commit messages in shell transport — avoids shell injection from user prompts
  - CI step uses injected step factories (agent, lint, commit-push) for testability — no circular imports
  - Lint step always returns success (best-effort) — lint failures should never block the pipeline
  - cleanupWorkspace is fire-and-forget in finally block — cleanup errors don't block job completion
  - Commit message format "hive: <prompt truncated to 72 chars>" for conventional filtering
  - CI failure logs augmented into prompt text (not assembledContext) so agent prioritizes fix instructions
patterns_established:
  - Composite steps orchestrate sub-steps via injected factories, keeping each independently testable
  - vi.useFakeTimers + advanceTimersByTimeAsync for testing polling/sleep loops without real delays
  - All post-agent steps follow same factory pattern as agent.ts: factory returns { name, execute(ctx) => StepResult }
  - Tests mock @/lib/workspace/exec module boundary and dispatch on command string content
observability_surfaces:
  - "[blueprint] lint:" log with outcome (skip/timeout/autofix/error)
  - "[blueprint] commit-push:" log with commit hash or failure reason
  - "[blueprint] ci-feedback:" logs at each phase — auth check, round start, poll status, retry trigger, exhaustion
  - "[blueprint] pr-create:" log with PR URL or failure reason
  - "[cleanup] workspace=<id>" log prefix for stop/delete lifecycle
  - ctx.ciRoundsUsed tracks CI round count for downstream visibility
  - tasks.prUrl and tasks.branch populated on success
  - tasks.errorMessage contains CI exhaustion details on failure
  - workspaces.status set to "deleted" after cleanup
drill_down_paths:
  - .gsd/milestones/M001/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S04/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001/slices/S04/tasks/T03-SUMMARY.md
duration: 39m
verification_result: passed
completed_at: 2026-03-19
---

# S04: CI Feedback Loop & PR Generation

**Built the complete post-agent pipeline — lint, commit-push, CI feedback with 2-round retry, PR creation, and workspace cleanup — so a task now goes from agent code changes all the way to an open PR with automatic CI retry and workspace teardown.**

## What Happened

Three tasks built the pipeline from individual steps up to full integration:

**T01** created three straightforward blueprint steps following the established factory pattern. `createLintStep()` detects the linter from package.json scripts, runs with autofix and a 5-second hard timeout, and always returns success (best-effort — lint failures never block the pipeline). `createCommitPushStep()` configures git identity as "Hive Bot", stages all changes, commits with a conventional-prefix message, and pushes to the task branch. `createPRStep()` runs `gh pr create` with a templated body and captures the PR URL from stdout. All three use base64 encoding for shell-transported strings to avoid injection from user prompts. 15 tests covering success, failure, and edge cases (lint timeout, push rejection, PR already exists, duplicate PR detection).

**T02** tackled the most complex piece: the CI feedback composite step. `createCIStep()` accepts injected step factories (agent, lint, commit-push) for clean testability. It polls `gh run list` with exponential backoff (5s→10s→20s→30s cap, 10-minute timeout), extracts failure logs via `gh run view --log-failed` when CI fails, feeds the failure context to a fresh agent round, re-runs lint and commit-push, then polls again. After 2 failed rounds, it returns failure with a "CI exhaustion" message including the failure logs. 5 tests covering: CI passes first try, CI fails then passes on retry, CI exhaustion after 2 rounds, gh auth failure, and no CI run found.

**T03** wired everything together. The BullMQ worker pipeline was extended from 4 steps to 8 (hydrate → rules → tools → agent → lint → commit-push → ci → pr). `cleanupWorkspace()` was added as a fire-and-forget call in the finally block — stops and deletes the workspace after a configurable grace period, updates workspace status in DB, and swallows errors to avoid blocking job completion. The worker now persists `prUrl` and `branch` to the task record on success. Job timeout increased to 90 minutes to accommodate CI polling + agent retry. 4 worker tests + 3 cleanup tests verifying the full pipeline, prUrl persistence, and cleanup lifecycle.

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/commit-push.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/pr.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/workspace/cleanup.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — updated tests pass
- `npx vitest run` — full suite passes, zero regressions
- Failure paths verified: lint always succeeds even on non-zero exit; commit-push returns failure with stderr on push rejection; PR step handles auth failure and duplicate PR; CI step caps at 2 rounds with exhaustion message

## Requirements Advanced

- R004 — PR creation step implemented: creates branch, commits with descriptive message, opens PR with templated body, captures and persists PR URL
- R005 — Full CI feedback loop implemented: lint → push → CI poll → failure extraction → agent retry → second CI round → exhaustion flagging
- R015 — Workspace cleanup implemented: stop + delete with configurable grace period, runs in finally block on both success and failure
- R028 — Lint step runs local linter with autofix, hard timeout at 5 seconds, always returns success (best-effort)
- R029 — CI feedback caps at 2 rounds: first failure triggers agent retry + re-push, second failure stops and flags with clear error message

## Requirements Validated

- R028 — Lint step unit tests prove: autofix runs in <5s (hard timeout), always returns success regardless of lint exit code, handles missing linter gracefully
- R029 — CI step unit tests prove: 2-round cap enforced, failure logs extracted and fed to agent, exhaustion message includes CI failure context

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

none — all three tasks executed per plan.

## Known Limitations

- All steps are unit-tested with mocked `execInWorkspace` — no integration test against real GitHub Actions CI. Real end-to-end proof requires running an actual task against a real repo.
- CI polling uses exponential backoff with 10-minute timeout — very long CI runs (>10min) will be treated as "no CI run found" and retried. Timeout is not configurable yet.
- `gh` CLI must be authenticated in the workspace for PR creation and CI polling to work. Auth failure is handled gracefully but there's no pre-flight check.
- Cleanup grace period is passed as a parameter but there's no configuration surface in the UI or environment — it's hardcoded at the call site.

## Follow-ups

- none — remaining work is in S05 (verifier), S06 (live streaming + dashboard results), S07 (prewarming + lifecycle).

## Files Created/Modified

- `src/lib/blueprint/steps/lint.ts` — Lint step: detects linter, runs autofix with 5s timeout, always succeeds
- `src/lib/blueprint/steps/commit-push.ts` — Commit-push step: git identity, stage, commit, push with base64-encoded message
- `src/lib/blueprint/steps/pr.ts` — PR creation step: gh pr create with templated body, captures URL
- `src/lib/blueprint/steps/ci.ts` — CI feedback composite step: poll, extract logs, retry agent, 2-round cap
- `src/lib/blueprint/types.ts` — Added optional ciRoundsUsed to BlueprintContext
- `src/lib/workspace/cleanup.ts` — Workspace cleanup: stop + delete with grace period and DB update
- `src/lib/queue/task-queue.ts` — Extended worker to 8-step pipeline, prUrl/branch persistence, cleanup in finally block
- `src/__tests__/lib/blueprint/steps/lint.test.ts` — 5 tests for lint step
- `src/__tests__/lib/blueprint/steps/commit-push.test.ts` — 5 tests for commit-push step
- `src/__tests__/lib/blueprint/steps/pr.test.ts` — 5 tests for PR step
- `src/__tests__/lib/blueprint/steps/ci.test.ts` — 5 tests for CI feedback step
- `src/__tests__/lib/workspace/cleanup.test.ts` — 3 tests for workspace cleanup
- `src/__tests__/lib/queue/worker.test.ts` — Updated to 4 tests covering extended pipeline

## Forward Intelligence

### What the next slice should know
- The worker pipeline is now 8 steps: hydrate → rules → tools → agent → lint → commit-push → ci → pr. S05 (verifier) should trigger after the PR step succeeds — look for `prUrl` on the task record as the signal.
- `cleanupWorkspace(coderClient, workspaceId, graceMs)` is available in `src/lib/workspace/cleanup.ts` — S05's verifier workspace should use the same cleanup pattern after verification completes.
- The CI step injects failure context into the agent's prompt text (not assembledContext). If the verifier needs a similar "fix and retry" loop, follow the same pattern.
- `tasks.prUrl` and `tasks.branch` are populated after successful PR creation. The verifier should use `tasks.branch` to pull the right code.

### What's fragile
- CI polling timeout (10 minutes) is hardcoded in the step — repos with slow CI will hit this. Consider making it configurable via BlueprintContext.
- `gh` auth in workspaces is assumed but not verified upfront — if the Coder template doesn't pre-configure gh, PR and CI steps will fail with auth errors.
- Cleanup is fire-and-forget — if it fails silently, orphan workspaces accumulate. The `[cleanup]` log prefix is the only signal.

### Authoritative diagnostics
- `taskLogs` table ordered by `createdAt` shows the full 8-step trace per task — each step records its outcome.
- `tasks.prUrl` and `tasks.branch` are the proof of successful PR creation — null means the pipeline didn't reach that point.
- `tasks.errorMessage` for failed tasks contains the step name and failure details (e.g., "CI exhaustion after 2 rounds: <failure log excerpt>").
- Grep for `[blueprint]` and `[cleanup]` log prefixes in container output for runtime diagnosis.

### What assumptions changed
- No assumptions changed — the slice executed per plan. The post-agent pipeline slots cleanly into the existing blueprint runner architecture.
