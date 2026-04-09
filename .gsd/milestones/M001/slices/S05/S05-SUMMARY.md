---
id: S05
parent: M001
milestone: M001
provides:
  - Verifier Coder workspace template (hive-verifier) — derived from worker, no AI tools, has Chrome/browser
  - 4 verifier blueprint steps (clone, detect, execute, report) following established factory pattern
  - Detection heuristic picking strategy based on repo contents (R007)
  - Verifier pipeline auto-triggered by orchestrator after successful PR creation (R006)
  - Verification report persisted as JSON column on Task model
  - getVerificationReport(taskId) API function
  - Task status transition running → verifying → done
requires:
  - slice: S04
    provides: PR on GitHub (branch_name for verifier to pull), cleanupWorkspace, blueprint runner
  - slice: S01
    provides: CoderClient.createWorkspace, task-queue worker pipeline
affects:
  - S06
  - S07
key_files:
  - templates/hive-verifier/main.tf
  - src/lib/verification/report.ts
  - src/lib/blueprint/types.ts
  - src/lib/blueprint/verifier.ts
  - src/lib/blueprint/steps/verify-clone.ts
  - src/lib/blueprint/steps/verify-detect.ts
  - src/lib/blueprint/steps/verify-execute.ts
  - src/lib/blueprint/steps/verify-report.ts
  - src/lib/queue/task-queue.ts
  - src/lib/api/tasks.ts
  - prisma/schema.prisma
key_decisions:
  - Verifier failure is informational — task still set to done with inconclusive report (PR exists regardless)
  - Execute step always returns success status — outcome stored in ctx for report step, step itself doesn't fail the blueprint
  - branch_name is required (no default) in verifier template since it always targets a specific PR branch
patterns_established:
  - Template derivation pattern — copy hive-worker, remove AI-specific resources, keep infrastructure
  - Verifier step factory pattern mirrors worker steps (create*Step → { name, execute(ctx) })
  - Dual-workspace lifecycle — worker + verifier workspaces tracked independently, both cleaned up in finally block
  - Detection heuristic priority ordering (test > dev/start > index.html > none) with explicit default-script exclusion
observability_surfaces:
  - "[blueprint] verify-clone:", "[blueprint] verify-detect:", "[blueprint] verify-execute:", "[blueprint] verify-report:" log prefixes
  - "[queue] Starting verifier for task ${taskId}" log when verifier triggers
  - tasks.status = 'verifying' during verification phase
  - tasks.verificationReport JSON column stores structured report
  - getVerificationReport(taskId) API retrieval function
  - verificationReport.outcome distinguishes pass/fail/inconclusive
drill_down_paths:
  - .gsd/milestones/M001/slices/S05/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S05/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001/slices/S05/tasks/T03-SUMMARY.md
duration: 42m
verification_result: passed
completed_at: 2026-03-20
---

# S05: Verifier Template & Proof-by-Consumption

**Built the complete verifier pipeline: hive-verifier workspace template, 4 blueprint steps implementing proof-by-consumption with adaptive strategy detection, orchestration wiring that auto-triggers verification after PR creation, and structured report persistence via API.**

## What Happened

T01 created the hive-verifier Coder template by deriving from hive-worker — stripped all AI tools (Pi, GSD, tools-ai.sh) while keeping Chrome, Node.js, and browser tools. Defined `VerificationStrategy` (test-suite | web-app | static-site | none), `VerificationOutcome` (pass | fail | inconclusive), and `VerificationReport` types. Extended `BlueprintContext` with optional verifier fields, backwards-compatible with all existing worker usage.

T02 built the core verifier logic as 4 blueprint steps following the established factory pattern: **verify-clone** runs `gh repo clone` + `git checkout` via execInWorkspace; **verify-detect** reads package.json to pick a strategy using priority ordering (real test script → test-suite, dev/start → web-app, index.html → static-site, fallback → none), explicitly excluding npm's default "no test specified" script; **verify-execute** dispatches on strategy — runs tests, starts a dev server + screenshots, or marks inconclusive; **verify-report** assembles a typed VerificationReport with strategy, outcome, logs, duration, and timestamp. The `createVerifierBlueprint()` factory composes all 4 steps. 18 unit tests cover all detection heuristics and execution strategies.

T03 wired the verifier into the orchestration pipeline. Added `verificationReport Json?` column to the Prisma Task model and `getVerificationReport(taskId)` to the API. Extended the task-queue worker to trigger the verifier blueprint after a successful worker blueprint that produces a PR URL — creates a verifier workspace, runs the 4-step blueprint, persists the structured report. Verifier failure is handled gracefully (task still completes as done — PR exists regardless). Both worker and verifier workspaces are cleaned up in the finally block. 4 new integration tests prove the full flow.

## Verification

- All 4 verifier step test files pass: 3 clone, 7 detect, 5 execute, 3 report tests (18 total)
- Worker integration tests pass: 12 tests including 4 new verifier-specific tests
- Full test suite: 20 files, 100 tests, zero regressions
- Prisma schema validates with new verificationReport column
- hive-verifier template exists with correct variables (has branch_name, no task_prompt, no AI tools)

## New Requirements Surfaced

- none

## Deviations

- none — all 3 tasks executed as planned with no structural changes

## Known Limitations

- Detection heuristic only inspects package.json — non-Node.js projects (Python, Go, Rust) will always fall through to "none" strategy. Adequate for M001 scope but needs extension for multi-language support.
- Web-app/static-site verification relies on curl-retry polling and a single screenshot — no functional testing (click-through, form submission) yet.
- Verifier failure is purely informational — there's no mechanism to flag tasks where verification failed vs passed in the dashboard (S06 will surface this).

## Follow-ups

- none

## Files Created/Modified

- `templates/hive-verifier/main.tf` — Coder template for verifier workspaces, derived from hive-worker without AI tools
- `templates/hive-verifier/Dockerfile` — Identical copy of worker Dockerfile
- `templates/hive-verifier/scripts/*` — All worker scripts except tools-ai.sh (removed)
- `src/lib/verification/report.ts` — VerificationStrategy, VerificationOutcome, VerificationReport types
- `src/lib/blueprint/types.ts` — Added optional verificationStrategy and verificationReport fields to BlueprintContext
- `src/lib/blueprint/steps/verify-clone.ts` — Clone + checkout step factory
- `src/lib/blueprint/steps/verify-detect.ts` — Detection heuristic step factory (R007)
- `src/lib/blueprint/steps/verify-execute.ts` — Strategy execution step factory
- `src/lib/blueprint/steps/verify-report.ts` — Report generation step factory
- `src/lib/blueprint/verifier.ts` — Verifier blueprint factory returning 4 steps in order
- `src/lib/queue/task-queue.ts` — Extended worker with verifier trigger, dual-workspace lifecycle, report persistence
- `src/lib/api/tasks.ts` — Added getVerificationReport(taskId) API function
- `prisma/schema.prisma` — Added verificationReport Json? column to Task model
- `src/__tests__/lib/blueprint/steps/verify-clone.test.ts` — 3 tests for clone step
- `src/__tests__/lib/blueprint/steps/verify-detect.test.ts` — 7 tests for detection heuristic
- `src/__tests__/lib/blueprint/steps/verify-execute.test.ts` — 5 tests for strategy execution
- `src/__tests__/lib/blueprint/steps/verify-report.test.ts` — 3 tests for report generation
- `src/__tests__/lib/queue/worker.test.ts` — Added 4 verifier integration tests

## Forward Intelligence

### What the next slice should know
- The verifier pipeline is fully wired but only contract-tested (mocked execInWorkspace). Real Coder integration testing happens at M001 end-to-end validation.
- `getVerificationReport(taskId)` returns the parsed JSON report or null — S06 dashboard can consume this directly to show verification results.
- The `tasks.verificationReport` JSON column contains strategy, outcome (pass/fail/inconclusive), logs, durationMs, and timestamp — sufficient for dashboard rendering.

### What's fragile
- Detection heuristic assumes Node.js ecosystem (package.json) — any non-JS repo will get "none" strategy and "inconclusive" outcome. This is acceptable for M001 but will need extension.
- The execute step's web-app strategy starts a dev server and polls with curl — timing-sensitive in real environments. The 60s timeout should be generous enough but hasn't been tested against real slow-starting apps.

### Authoritative diagnostics
- `tasks.status = 'verifying'` — query to find tasks currently in verification phase
- `getVerificationReport(taskId)` — API function returns structured report or null
- Grep for `[queue] Starting verifier` in container logs to trace verifier triggers
- Grep for `[blueprint] verify-` to trace individual verifier step execution

### What assumptions changed
- No assumptions changed — S05 executed cleanly against the S04 contract (prUrl as trigger signal, existing cleanup patterns, blueprint runner)
