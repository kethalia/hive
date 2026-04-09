---
id: T02
parent: S05
milestone: M001
provides:
  - 4 verifier blueprint steps (clone, detect, execute, report) following established factory pattern
  - Verifier blueprint factory composing all 4 steps in order
  - Detection heuristic covering test-suite, web-app, static-site, none strategies
key_files:
  - src/lib/blueprint/steps/verify-clone.ts
  - src/lib/blueprint/steps/verify-detect.ts
  - src/lib/blueprint/steps/verify-execute.ts
  - src/lib/blueprint/steps/verify-report.ts
  - src/lib/blueprint/verifier.ts
  - src/__tests__/lib/blueprint/steps/verify-clone.test.ts
  - src/__tests__/lib/blueprint/steps/verify-detect.test.ts
  - src/__tests__/lib/blueprint/steps/verify-execute.test.ts
  - src/__tests__/lib/blueprint/steps/verify-report.test.ts
key_decisions:
  - Execute step always returns "success" status — outcome is stored in ctx for the report step, step itself doesn't fail
  - Intermediate data between execute and report steps passed via ctx.verificationReport as JSON string
patterns_established:
  - Verifier step factory pattern mirrors worker steps (create*Step → { name, execute(ctx) })
  - Detection heuristic uses priority ordering (test > dev/start > index.html > none) with explicit default-script exclusion
observability_surfaces:
  - "[blueprint] verify-clone:", "[blueprint] verify-detect:", "[blueprint] verify-execute:", "[blueprint] verify-report:" log prefixes
duration: 15m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T02: Build verifier blueprint steps with unit tests

**Built 4 verifier blueprint steps (clone, detect, execute, report) and verifier blueprint factory with 18 unit tests covering all detection heuristics and execution strategies.**

## What Happened

Created 4 verifier step factories following the established pattern from S03/S04:

- **verify-clone**: Runs `gh repo clone` + `git checkout` via execInWorkspace. Returns failure with stderr on non-zero exit.
- **verify-detect**: Reads package.json via execInWorkspace, applies R007 priority: real test script → test-suite, dev/start script → web-app, index.html → static-site, fallback → none. Explicitly excludes the npm default test script (`echo "Error: no test specified" && exit 1`).
- **verify-execute**: Dispatches on ctx.verificationStrategy. test-suite runs `npm install && npm test` with 120s timeout. web-app/static-site start server + curl-retry 60s + browser-screenshot. none → inconclusive. Stores outcome+logs as JSON in ctx.verificationReport.
- **verify-report**: Parses intermediate data from ctx, assembles a typed VerificationReport with strategy, outcome, logs, durationMs, timestamp. Serializes final report to ctx.verificationReport.

Created `createVerifierBlueprint()` factory that returns the 4 steps in order.

## Verification

All 4 test files pass (18 tests total): 3 clone tests (success, repo-not-found, branch-not-found), 7 detect tests (all 4 strategies + priority + default-script exclusion), 5 execute tests (pass/fail/inconclusive per strategy), 3 report tests (correct assembly, timestamps, missing data). Full suite: 20 files, 97 tests, zero regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-clone.test.ts` | 0 | ✅ pass | <1s |
| 2 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-detect.test.ts` | 0 | ✅ pass | <1s |
| 3 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-execute.test.ts` | 0 | ✅ pass | <1s |
| 4 | `npx vitest run src/__tests__/lib/blueprint/steps/verify-report.test.ts` | 0 | ✅ pass | <1s |
| 5 | `npx vitest run` | 0 | ✅ pass | 1.9s |
| 6 | `test -d templates/hive-verifier && test -f templates/hive-verifier/main.tf` | 0 | ✅ pass | <1s |

## Diagnostics

- Grep container logs for `[blueprint] verify-` to trace verifier step progress
- Each step's result.message includes strategy name and outcome for debugging
- ctx.verificationReport contains structured JSON after the report step completes

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/lib/blueprint/steps/verify-clone.ts` — Clone + checkout step factory
- `src/lib/blueprint/steps/verify-detect.ts` — Detection heuristic step factory (R007)
- `src/lib/blueprint/steps/verify-execute.ts` — Strategy execution step factory
- `src/lib/blueprint/steps/verify-report.ts` — Report generation step factory
- `src/lib/blueprint/verifier.ts` — Verifier blueprint factory returning 4 steps
- `src/__tests__/lib/blueprint/steps/verify-clone.test.ts` — 3 tests for clone step
- `src/__tests__/lib/blueprint/steps/verify-detect.test.ts` — 7 tests for detection heuristic
- `src/__tests__/lib/blueprint/steps/verify-execute.test.ts` — 5 tests for strategy execution
- `src/__tests__/lib/blueprint/steps/verify-report.test.ts` — 3 tests for report generation
