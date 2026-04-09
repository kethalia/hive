# S05: Verifier Template & Proof-by-Consumption — UAT

**Milestone:** M001
**Written:** 2026-03-20

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S05 is contract-tested with mocked workspace execution. Real Coder integration is deferred to M001 end-to-end validation. All proof is via unit tests and structural checks.

## Preconditions

- Working directory is the Hive project root (`/home/coder/coder`)
- Node modules installed (`node_modules/` exists)
- No running services required — all tests use mocks

## Smoke Test

```bash
npx vitest run src/__tests__/lib/blueprint/steps/verify-detect.test.ts
```
If 7 tests pass, the core detection heuristic (the riskiest part of S05) is working.

## Test Cases

### 1. Verifier template structure

1. `test -d templates/hive-verifier && test -f templates/hive-verifier/main.tf`
2. `grep -q 'variable "branch_name"' templates/hive-verifier/main.tf`
3. `! grep -q 'task_prompt' templates/hive-verifier/main.tf`
4. `! grep -q 'coder_app.*"pi"' templates/hive-verifier/main.tf`
5. `! grep -q 'coder_app.*"gsd"' templates/hive-verifier/main.tf`
6. `! test -f templates/hive-verifier/scripts/tools-ai.sh`
7. **Expected:** All 6 checks exit 0 — verifier template exists with branch_name, without AI tools

### 2. Verification report types compile

1. `npx tsc --noEmit src/lib/verification/report.ts 2>&1 || echo "OK if imports resolve"`
2. `grep -q 'VerificationStrategy' src/lib/verification/report.ts`
3. `grep -q 'VerificationOutcome' src/lib/verification/report.ts`
4. `grep -q 'VerificationReport' src/lib/verification/report.ts`
5. **Expected:** All types exist: VerificationStrategy (test-suite | web-app | static-site | none), VerificationOutcome (pass | fail | inconclusive), VerificationReport interface

### 3. BlueprintContext extended with verifier fields

1. `grep -q 'verificationStrategy' src/lib/blueprint/types.ts`
2. `grep -q 'verificationReport' src/lib/blueprint/types.ts`
3. **Expected:** Both fields present as optional on BlueprintContext — existing worker usage unaffected

### 4. Clone step handles success and failure

1. `npx vitest run src/__tests__/lib/blueprint/steps/verify-clone.test.ts`
2. **Expected:** 3 tests pass — successful clone, repo-not-found failure, branch-not-found failure

### 5. Detection heuristic covers all 4 strategies

1. `npx vitest run src/__tests__/lib/blueprint/steps/verify-detect.test.ts`
2. **Expected:** 7 tests pass covering:
   - Repo with real `test` script → test-suite
   - Repo with `dev` script → web-app
   - Repo with `start` script → web-app
   - Repo with index.html → static-site
   - Repo with nothing → none
   - npm default test script (`echo "Error: no test specified"`) excluded from test-suite detection
   - Priority: test script wins over dev/start script

### 6. Strategy execution dispatches correctly

1. `npx vitest run src/__tests__/lib/blueprint/steps/verify-execute.test.ts`
2. **Expected:** 5 tests pass covering test-suite pass/fail, web-app, static-site, and none (inconclusive)

### 7. Report generation assembles structured output

1. `npx vitest run src/__tests__/lib/blueprint/steps/verify-report.test.ts`
2. **Expected:** 3 tests pass — report has correct structure with strategy, outcome, logs, durationMs, timestamp

### 8. Verifier blueprint factory returns correct step sequence

1. `grep -q 'createVerifierBlueprint' src/lib/blueprint/verifier.ts`
2. **Expected:** Factory function exists and returns array of 4 steps in order: clone → detect → execute → report

### 9. Worker pipeline triggers verifier after PR

1. `npx vitest run src/__tests__/lib/queue/worker.test.ts`
2. **Expected:** 12 tests pass including:
   - Successful worker with PR → verifier triggers → report stored
   - Failed worker → verifier NOT triggered
   - Verifier failure → task still completes as done (informational)
   - Both worker and verifier workspaces cleaned up

### 10. DB schema validates with verification report column

1. `npx prisma validate`
2. **Expected:** Schema valid, Task model has `verificationReport Json?` column

### 11. API retrieval function exists

1. `grep -q 'getVerificationReport' src/lib/api/tasks.ts`
2. **Expected:** Function exists that retrieves verification report by taskId

### 12. Full test suite regression check

1. `npx vitest run`
2. **Expected:** 20 test files, 100 tests pass, zero failures

## Edge Cases

### Default npm test script exclusion
1. Detection heuristic receives package.json with `"test": "echo \"Error: no test specified\" && exit 1"`
2. **Expected:** Strategy is NOT test-suite — falls through to check for dev/start scripts or static-site

### Verifier triggered only on PR success
1. Worker blueprint fails (no PR created, ctx.prUrl undefined)
2. **Expected:** Verifier pipeline is NOT triggered, task goes directly to failed status

### Verifier failure is non-blocking
1. Verifier workspace creation or blueprint execution fails
2. **Expected:** Task still transitions to done (not failed), verification report has outcome "inconclusive"

## Failure Signals

- Any of the 100 tests failing indicates a regression
- `npx prisma validate` failing means schema is broken
- Missing `templates/hive-verifier/main.tf` means template wasn't created
- `grep -q 'task_prompt' templates/hive-verifier/main.tf` succeeding means AI tools weren't properly removed
- Worker test showing verifier triggering after a failed worker means the guard condition is broken

## Not Proven By This UAT

- Real Coder workspace creation for verifier (mocked in all tests)
- Actual browser screenshot capture in web-app/static-site strategies
- Real npm test / npm run dev execution inside a workspace
- Network connectivity between orchestrator and verifier workspace
- Dashboard rendering of verification reports (S06)
- Workspace pre-warming for verifier template (S07)

## Notes for Tester

- All tests use mocked `execInWorkspace` — the same pattern established in S03/S04. Real integration testing is scoped to M001 end-to-end validation.
- The detection heuristic is Node.js-only by design for M001. Non-JS repos will get "inconclusive" — this is expected, not a bug.
- The full test suite should complete in under 3 seconds. If it takes significantly longer, something may be wrong with the test environment.
