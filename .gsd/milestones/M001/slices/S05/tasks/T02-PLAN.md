---
estimated_steps: 5
estimated_files: 9
---

# T02: Build verifier blueprint steps with unit tests

**Slice:** S05 — Verifier Template & Proof-by-Consumption
**Milestone:** M001

## Description

Build the 4 verifier blueprint steps (clone, detect, execute, report) and a verifier blueprint factory, with comprehensive unit tests. This is the core novel work of S05 — the detection heuristic (R007) that picks a testing strategy and the execution logic that runs it. Each step follows the established factory pattern from S03/S04: a `create*Step()` function returning `{ name, execute(ctx) => StepResult }`. Tests mock `execInWorkspace` — same pattern as existing step tests in `src/__tests__/lib/blueprint/steps/`.

## Steps

1. **Create `src/lib/blueprint/steps/verify-clone.ts`** — Clone and checkout step.
   - Factory: `createVerifyCloneStep()` returns a BlueprintStep
   - Execute: runs `gh repo clone <ctx.repoUrl> /home/coder/project && cd /home/coder/project && git checkout <ctx.branchName>` via `execInWorkspace(ctx.workspaceName, command)`
   - On success: return `{ status: "success", message: "Cloned and checked out <branchName>" }`
   - On failure (non-zero exit): return `{ status: "failure", message: stderr }`
   - Write tests in `src/__tests__/lib/blueprint/steps/verify-clone.test.ts`:
     - Successful clone + checkout
     - Clone failure (repo not found)
     - Checkout failure (branch doesn't exist)

2. **Create `src/lib/blueprint/steps/verify-detect.ts`** — Detection heuristic step.
   - Factory: `createVerifyDetectStep()` returns a BlueprintStep
   - Execute: runs `cat /home/coder/project/package.json` via execInWorkspace. Parse the JSON.
   - Detection priority (R007):
     1. If `scripts.test` exists and is not `"echo \"Error: no test specified\" && exit 1"` → strategy = `"test-suite"`
     2. If `scripts.dev` or `scripts.start` exists → strategy = `"web-app"`
     3. If no package.json, run `test -f /home/coder/project/index.html` → strategy = `"static-site"`
     4. Fallback → strategy = `"none"`
   - Set `ctx.verificationStrategy = strategy`
   - Always returns success (detection never fails — worst case is "none")
   - Write tests in `src/__tests__/lib/blueprint/steps/verify-detect.test.ts`:
     - Repo with `test` script → "test-suite"
     - Repo with both `test` and `dev` → "test-suite" (test takes priority)
     - Repo with `dev` script only → "web-app"
     - Repo with `start` script only → "web-app"
     - No package.json but has index.html → "static-site"
     - Nothing detected → "none"

3. **Create `src/lib/blueprint/steps/verify-execute.ts`** — Strategy execution step.
   - Factory: `createVerifyExecuteStep()` returns a BlueprintStep
   - Execute: dispatch on `ctx.verificationStrategy`:
     - `"test-suite"`: run `cd /home/coder/project && npm install && npm test` with `timeoutMs: 120_000`. Pass → outcome `"pass"`, fail → outcome `"fail"`.
     - `"web-app"`: run `cd /home/coder/project && npm install && npm run dev &` then `bash -c 'for i in $(seq 1 30); do curl -sf http://localhost:3000 && exit 0; sleep 2; done; exit 1'` (60s retry). If port responds, run `browser-screenshot http://localhost:3000 --output /tmp/verification.png`. Pass → outcome `"pass"`, curl fail → outcome `"inconclusive"`.
     - `"static-site"`: run `cd /home/coder/project && npx -y serve . -l 3000 &` then same curl-retry + screenshot pattern. Pass → outcome `"pass"`, fail → outcome `"inconclusive"`.
     - `"none"`: skip, outcome = `"inconclusive"`, message = "No verification strategy found"
   - Store execution logs (stdout+stderr) and outcome in ctx for the report step. Use `ctx.verificationReport` temporarily as a JSON string containing `{ outcome, logs }`.
   - Write tests in `src/__tests__/lib/blueprint/steps/verify-execute.test.ts`:
     - test-suite strategy: npm test passes → outcome pass
     - test-suite strategy: npm test fails → outcome fail
     - web-app strategy: dev server responds → outcome pass
     - web-app strategy: dev server never responds → outcome inconclusive
     - none strategy → skipped with inconclusive
   - Mock `execInWorkspace` to dispatch on command string content (same pattern as S04 tests)

4. **Create `src/lib/blueprint/steps/verify-report.ts`** — Report generation step.
   - Factory: `createVerifyReportStep()` returns a BlueprintStep
   - Execute: read the intermediate data from ctx, assemble a `VerificationReport` (import from `src/lib/verification/report.ts`), serialize to JSON, set `ctx.verificationReport = JSON.stringify(report)`.
   - Always returns success.
   - Write tests in `src/__tests__/lib/blueprint/steps/verify-report.test.ts`:
     - Report assembled with correct strategy and outcome
     - Report includes timestamp and duration
     - Missing intermediate data → inconclusive report

5. **Create `src/lib/blueprint/verifier.ts`** — Verifier blueprint factory.
   - Export `createVerifierBlueprint()` that returns `BlueprintStep[]`:
     ```typescript
     [createVerifyCloneStep(), createVerifyDetectStep(), createVerifyExecuteStep(), createVerifyReportStep()]
     ```
   - This is a simple composition — no test file needed (it's tested via the step tests and the worker integration test in T03).

## Must-Haves

- [ ] All 4 step factories follow the established pattern: `create*Step() → { name, execute(ctx) => StepResult }`
- [ ] Detection heuristic handles all 4 cases: test-suite, web-app, static-site, none
- [ ] Test script has `test` priority over `dev`/`start` (more deterministic)
- [ ] Default npm test script (`echo "Error: no test specified" && exit 1`) is excluded from test-suite detection
- [ ] Execute step uses 120s timeout for npm test, 60s curl-retry for web apps
- [ ] "none" strategy returns inconclusive, not failure
- [ ] `verifierBlueprint()` returns the 4 steps in correct order
- [ ] All test files pass via `npx vitest run`

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/verify-clone.test.ts` — passes
- `npx vitest run src/__tests__/lib/blueprint/steps/verify-detect.test.ts` — passes
- `npx vitest run src/__tests__/lib/blueprint/steps/verify-execute.test.ts` — passes
- `npx vitest run src/__tests__/lib/blueprint/steps/verify-report.test.ts` — passes
- `npx vitest run` — full suite passes, zero regressions

## Observability Impact

- Signals added: `[blueprint] verify-clone:`, `[blueprint] verify-detect:`, `[blueprint] verify-execute:`, `[blueprint] verify-report:` log prefixes via the existing runner's step logging
- How a future agent inspects this: grep container logs for `[blueprint] verify-` to trace verifier progress
- Failure state exposed: step result message contains strategy name and outcome; detection logs which heuristic matched

## Inputs

- `src/lib/blueprint/types.ts` — BlueprintContext with verificationStrategy and verificationReport fields (from T01)
- `src/lib/verification/report.ts` — VerificationReport types (from T01)
- `src/lib/workspace/exec.ts` — execInWorkspace function (mocked in tests)
- `src/__tests__/lib/blueprint/steps/ci.test.ts` — reference for test patterns (mock setup, makeCtx, ok/fail helpers)
- Existing step factories (`src/lib/blueprint/steps/lint.ts`, `pr.ts`, etc.) — reference for factory pattern

## Expected Output

- `src/lib/blueprint/steps/verify-clone.ts` — Clone + checkout step
- `src/lib/blueprint/steps/verify-detect.ts` — Detection heuristic step
- `src/lib/blueprint/steps/verify-execute.ts` — Strategy execution step
- `src/lib/blueprint/steps/verify-report.ts` — Report generation step
- `src/lib/blueprint/verifier.ts` — Verifier blueprint factory returning the 4 steps
- `src/__tests__/lib/blueprint/steps/verify-clone.test.ts` — 3 tests
- `src/__tests__/lib/blueprint/steps/verify-detect.test.ts` — 6 tests (one per heuristic case)
- `src/__tests__/lib/blueprint/steps/verify-execute.test.ts` — 5 tests
- `src/__tests__/lib/blueprint/steps/verify-report.test.ts` — 3 tests
