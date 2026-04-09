# S05: Verifier Template & Proof-by-Consumption

**Goal:** After a worker creates a PR, a verifier workspace auto-spins up, pulls the branch, detects the output type, tests it by actually consuming it (run tests, start web app + screenshot, serve static HTML), and stores a structured verification report accessible via API.
**Demo:** Submitting a task that completes with a PR triggers the verifier pipeline. The task transitions through `verifying` status. A verification report with strategy, outcome, and logs is stored in the DB and retrievable via `getVerificationReport(taskId)`. Unit tests prove the full flow with mocked workspace execution.

## Must-Haves

- Verifier Coder template derived from hive-worker with correct variable set (R013)
- Detection heuristic picks strategy based on repo contents: test suite → web app → static site → fallback (R007)
- Verifier blueprint steps: clone+checkout, detect strategy, execute strategy, generate report (R006)
- Orchestrator triggers verifier after worker PR creation, transitions task to `verifying`, stores report (R006)
- Verification report persisted in DB with strategy, outcome (pass/fail/inconclusive), and logs
- API function `getVerificationReport(taskId)` retrieves the report
- Verifier workspace cleaned up after completion using existing `cleanupWorkspace` (R015)
- Worker failure does NOT trigger verifier

## Proof Level

- This slice proves: contract (unit tests with mocked execInWorkspace — same pattern as S03/S04)
- Real runtime required: no (integration with real Coder is M001 end-to-end)
- Human/UAT required: no

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/verify-clone.test.ts` — clone+checkout step tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/verify-detect.test.ts` — detection heuristic covers all 4 cases
- `npx vitest run src/__tests__/lib/blueprint/steps/verify-execute.test.ts` — strategy execution tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/verify-report.test.ts` — report generation tests pass
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — extended tests cover verifier trigger + no-trigger on failure
- `npx vitest run` — full suite passes, zero regressions
- `npx prisma validate` — schema validates
- `test -d templates/hive-verifier && test -f templates/hive-verifier/main.tf` — template exists

## Observability / Diagnostics

- Runtime signals: `[blueprint] verify-*:` log prefix for each verifier step; `[queue] Starting verifier` log when verifier pipeline triggers; task status transition `running → verifying → done/failed`
- Inspection surfaces: `tasks.status = 'verifying'` during verification; `tasks.verificationReport` JSON column stores structured report; `getVerificationReport(taskId)` API function
- Failure visibility: verification report `outcome` field distinguishes `pass`, `fail`, `inconclusive`; `tasks.errorMessage` captures verifier failures; taskLogs record each verifier step outcome
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `src/lib/blueprint/runner.ts` (runBlueprint), `src/lib/blueprint/types.ts` (BlueprintContext, BlueprintStep, StepResult), `src/lib/workspace/exec.ts` (execInWorkspace), `src/lib/workspace/cleanup.ts` (cleanupWorkspace), `src/lib/coder/client.ts` (CoderClient.createWorkspace, waitForBuild, getWorkspaceAgentName), `src/lib/queue/task-queue.ts` (worker pipeline — consumes prUrl as trigger signal)
- New wiring introduced in this slice: verifier pipeline triggered inside task-queue worker after successful PR step; verifier blueprint composed from 4 new steps; verification report JSON column on Task model
- What remains before the milestone is truly usable end-to-end: S06 (live streaming + dashboard results), S07 (workspace prewarming + lifecycle)

## Tasks

- [x] **T01: Create verifier Coder template and verification report types** `est:30m`
  - Why: The verifier needs its own Coder workspace template (R013) and TypeScript types for verification reports before blueprint steps can be built.
  - Files: `templates/hive-verifier/main.tf`, `templates/hive-verifier/Dockerfile`, `templates/hive-verifier/scripts/`, `src/lib/verification/report.ts`, `src/lib/blueprint/types.ts`
  - Do: Copy hive-worker template to hive-verifier. Modify variables: remove `task_prompt`, keep `task_id`/`repo_url`/`branch_name`. Remove AI tools scripts (tools-ai.sh) and Pi/GSD coder_app resources since verifier doesn't run an agent. Keep Chrome/browser tools. Symlink or copy the Dockerfile (identical base image). Create `src/lib/verification/report.ts` with `VerificationStrategy` enum (test-suite, web-app, static-site, none), `VerificationOutcome` enum (pass, fail, inconclusive), and `VerificationReport` interface. Add optional verifier fields to `BlueprintContext`: `verificationStrategy`, `verificationReport`.
  - Verify: `test -f templates/hive-verifier/main.tf && grep -q "branch_name" templates/hive-verifier/main.tf && ! grep -q "task_prompt" templates/hive-verifier/main.tf && test -f src/lib/verification/report.ts`
  - Done when: hive-verifier template exists with correct variables, report types are importable, BlueprintContext has optional verifier fields

- [x] **T02: Build verifier blueprint steps with unit tests** `est:1h`
  - Why: Core novel work — the 4 verifier steps (clone, detect, execute, report) implement R006 and R007. The detection heuristic and strategy execution are the riskiest parts of S05.
  - Files: `src/lib/blueprint/steps/verify-clone.ts`, `src/lib/blueprint/steps/verify-detect.ts`, `src/lib/blueprint/steps/verify-execute.ts`, `src/lib/blueprint/steps/verify-report.ts`, `src/lib/blueprint/verifier.ts`, `src/__tests__/lib/blueprint/steps/verify-clone.test.ts`, `src/__tests__/lib/blueprint/steps/verify-detect.test.ts`, `src/__tests__/lib/blueprint/steps/verify-execute.test.ts`, `src/__tests__/lib/blueprint/steps/verify-report.test.ts`
  - Do: Build 4 steps following the established factory pattern (each exports a `create*Step()` that returns `{ name, execute(ctx) => StepResult }`). **verify-clone**: `gh repo clone <repoUrl> /home/coder/project && cd /home/coder/project && git checkout <branchName>` via execInWorkspace. **verify-detect**: read package.json via execInWorkspace(`cat package.json`), parse scripts object. Priority: (1) has `test` script → test-suite, (2) has `dev` or `start` script → web-app, (3) find index.html → static-site, (4) fallback → none. Set `ctx.verificationStrategy`. **verify-execute**: dispatch on strategy — test-suite: run `npm test` with 120s timeout; web-app: run `npm run dev &`, curl-retry on port 3000 for 60s, then `browser-screenshot http://localhost:3000 --output /tmp/verification.png`; static-site: `npx serve . -p 3000 &`, same screenshot pattern; none: skip with "inconclusive". Store stdout/stderr in ctx. **verify-report**: assemble VerificationReport from ctx fields, JSON-serialize to ctx.verificationReport. Create `src/lib/blueprint/verifier.ts` exporting `createVerifierBlueprint()` that returns the 4 steps array. Write unit tests for each step mocking execInWorkspace — same pattern as S04 tests. Detection tests must cover all 4 heuristic cases.
  - Verify: `npx vitest run src/__tests__/lib/blueprint/steps/verify-clone.test.ts src/__tests__/lib/blueprint/steps/verify-detect.test.ts src/__tests__/lib/blueprint/steps/verify-execute.test.ts src/__tests__/lib/blueprint/steps/verify-report.test.ts`
  - Done when: all 4 step test files pass, detection heuristic tested for test-suite/web-app/static-site/none cases, verifier blueprint factory returns correct step sequence

- [x] **T03: Wire verifier into orchestration pipeline with DB persistence** `est:45m`
  - Why: Integrates the verifier into the task lifecycle — after worker PR creation, the orchestrator must trigger verification, persist the report, and expose it via API. This closes R006 and connects all the pieces.
  - Files: `prisma/schema.prisma`, `src/lib/queue/task-queue.ts`, `src/lib/api/tasks.ts`, `src/__tests__/lib/queue/worker.test.ts`
  - Do: Add `verificationReport Json?` column to `Task` model in Prisma schema (JSON column, not a separate model — keeps it simple). Add `getVerificationReport(taskId)` function to `src/lib/api/tasks.ts`. Modify `task-queue.ts` worker: after the 8-step worker blueprint succeeds AND `ctx.prUrl` is set, (1) update task status to `verifying`, (2) create verifier workspace using `CODER_VERIFIER_TEMPLATE_ID` env var, (3) record verifier workspace in DB with `templateType: "verifier"`, (4) wait for build, (5) run verifier blueprint via `runBlueprint(createVerifierBlueprint(), verifierCtx)`, (6) persist `ctx.verificationReport` to task record, (7) update status to `done`. On verifier failure: still set task to `done` (PR exists — verification is informational, not blocking). Cleanup verifier workspace in the same finally block pattern. Add worker tests: successful worker → verifier triggers → report stored; worker failure → verifier NOT triggered; verifier failure → task still completes as done with error in report.
  - Verify: `npx vitest run src/__tests__/lib/queue/worker.test.ts && npx prisma validate`
  - Done when: worker tests prove verifier triggers after PR, report is persisted, verifier failure doesn't block task completion, schema validates

## Files Likely Touched

- `templates/hive-verifier/main.tf`
- `templates/hive-verifier/Dockerfile`
- `templates/hive-verifier/scripts/*`
- `src/lib/verification/report.ts`
- `src/lib/blueprint/types.ts`
- `src/lib/blueprint/verifier.ts`
- `src/lib/blueprint/steps/verify-clone.ts`
- `src/lib/blueprint/steps/verify-detect.ts`
- `src/lib/blueprint/steps/verify-execute.ts`
- `src/lib/blueprint/steps/verify-report.ts`
- `src/lib/queue/task-queue.ts`
- `src/lib/api/tasks.ts`
- `prisma/schema.prisma`
- `src/__tests__/lib/blueprint/steps/verify-clone.test.ts`
- `src/__tests__/lib/blueprint/steps/verify-detect.test.ts`
- `src/__tests__/lib/blueprint/steps/verify-execute.test.ts`
- `src/__tests__/lib/blueprint/steps/verify-report.test.ts`
- `src/__tests__/lib/queue/worker.test.ts`
