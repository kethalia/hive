# S03: Blueprint Execution & Worker Agent — UAT

**Milestone:** M001
**Written:** 2026-03-19

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S03 produces no user-visible UI or live runtime behavior — it adds backend modules (exec primitive, blueprint runner, steps, worker wiring) verified through unit tests with mocked dependencies. Real end-to-end runtime proof requires S04+ to close the loop.

## Preconditions

- Repository cloned with all dependencies installed (`pnpm install`)
- Node.js available (v20+)
- Vitest available via `npx vitest`

## Smoke Test

Run `npx vitest run` from the project root. All 53 tests across 11 files must pass with zero failures.

## Test Cases

### 1. Exec primitive handles success, failure, and timeout

1. Run `npx vitest run src/__tests__/lib/workspace/exec.test.ts`
2. **Expected:** 6 tests pass — covering successful command execution returning stdout/exitCode 0, failed command returning non-zero exitCode without throwing, timeout producing exitCode 124 with fallback stderr message, and command string truncation in logs.

### 2. Blueprint runner sequences steps correctly

1. Run `npx vitest run src/__tests__/lib/blueprint/runner.test.ts`
2. **Expected:** 6 tests pass — covering all-success runs, failure-stops-subsequent-steps, thrown-error-caught-as-failure, skip-continues-to-next-step, empty-step-array returns success, and context-mutation-passes-between-steps.

### 3. Context hydration assembles repo structure and key files

1. Run `npx vitest run src/__tests__/lib/blueprint/steps/hydrate.test.ts`
2. **Expected:** 4 tests pass — covering successful hydration with tree + key files populating `ctx.assembledContext`, failure when repo directory doesn't exist, partial success when some key files are missing, and content verification that assembled context contains expected markdown sections.

### 4. Scoped rules handles present and absent AGENTS.md

1. Run `npx vitest run src/__tests__/lib/blueprint/steps/rules.test.ts`
2. **Expected:** 3 tests pass — covering multiple AGENTS.md files concatenated into `ctx.scopedRules`, no AGENTS.md returning 'skipped' status (not failure), and single file producing correct header format.

### 5. Tool selection detects repo types and selects appropriate tools

1. Run `npx vitest run src/__tests__/lib/blueprint/steps/tools.test.ts`
2. **Expected:** 4 tests pass — covering Next.js repo getting browser tool added, plain Node repo getting base tools only, missing package.json getting base tools with success status, and test framework detection adding test tool.

### 6. Agent step runs Pi and verifies code changes

1. Run `npx vitest run src/__tests__/lib/blueprint/steps/agent.test.ts`
2. **Expected:** 5 tests pass — covering successful execution with code changes detected, Pi exit failure, no code changes after run treated as failure, context file write failure, and timeout handling.

### 7. Worker pipeline covers full lifecycle

1. Run `npx vitest run src/__tests__/lib/queue/worker.test.ts`
2. **Expected:** 5 tests pass — covering complete success flow (create workspace → waitForBuild → resolveAgent → runBlueprint → status=done), blueprint failure surfacing step name in errorMessage and status=failed, workspace creation error handling, queue initialization, and concurrency configuration.

### 8. Full regression — no S01/S02 breakage

1. Run `npx vitest run`
2. **Expected:** All 53 tests pass across 11 test files. Zero regressions in S01 tests (coder client, tasks API, schema) and S02 tests (task pages).

## Edge Cases

### Exec timeout produces structured result, not exception

1. In exec tests, verify the timeout test case returns `{exitCode: 124, stderr: "...timed out..."}` rather than throwing an unhandled error.
2. **Expected:** Test passes — `execInWorkspace` never throws, always returns ExecResult.

### Rules step skips gracefully when no AGENTS.md exists

1. In rules tests, verify the "no AGENTS.md" test case returns `{status: 'skipped', message: ...}`.
2. **Expected:** Downstream steps still run after a skipped rules step — skip does not halt the blueprint.

### Non-Node repos get base tools, not failure

1. In tools tests, verify the "no package.json" case returns `{status: 'success'}` with base tools `['read', 'bash', 'edit', 'write', 'lsp']`.
2. **Expected:** Tool selection never fails — unknown repos get a safe default.

### Agent step treats zero code changes as failure

1. In agent tests, verify the "no changes" case (git diff --stat returns empty) produces `{status: 'failure'}`.
2. **Expected:** An agent that runs without producing changes is a failed task, not a success.

## Failure Signals

- Any test file reporting failures in `npx vitest run` — all 53 must pass
- Import errors in test files — indicates module path or export changes breaking existing code
- Mock setup errors — indicates interface changes in upstream modules (CoderClient, task-queue) that haven't been reflected in test mocks
- `Cannot find module` errors — indicates missing files that should have been created

## Not Proven By This UAT

- Real execution against a live Coder workspace (all remote execution is mocked)
- Actual Pi agent producing real code changes in a workspace
- End-to-end flow from dashboard submission through to workspace output
- Performance characteristics (timeouts are tested but not under real latency)
- Context hydration quality on real repositories (mocked file system output)

## Notes for Tester

- All tests use mocked `child_process.execFile` and mocked `@/lib/workspace/exec` — no Coder instance or workspace is needed.
- The worker test mocks the entire CoderClient, Prisma, and blueprint runner — it tests orchestration logic, not real infrastructure.
- If adding new tests, follow the established pattern: mock the `@/lib/workspace/exec` module boundary (not the underlying `child_process`), and dispatch mock responses based on the command string content.
