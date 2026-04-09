---
id: T01
parent: S03
milestone: M001
provides:
  - execInWorkspace primitive for remote command execution in Coder workspaces
  - BlueprintContext, StepResult, BlueprintStep, BlueprintResult types
  - runBlueprint sequential step runner
key_files:
  - src/lib/workspace/exec.ts
  - src/lib/blueprint/types.ts
  - src/lib/blueprint/runner.ts
  - src/__tests__/lib/workspace/exec.test.ts
  - src/__tests__/lib/blueprint/runner.test.ts
key_decisions:
  - execInWorkspace never throws on non-zero exit — always returns structured ExecResult
  - Timeout exit code is 124 (Unix convention) with stderr fallback message
  - runBlueprint uses simple for...of loop — no DAG, no plugin registry (per R025)
patterns_established:
  - "[exec]" prefixed logs for all remote workspace commands with workspace name, truncated command, exit code
  - "[blueprint]" prefixed logs for step lifecycle (start/complete/fail/skip) with taskId
  - Mock child_process.execFile via vi.mock for exec tests; inline step functions for runner tests
observability_surfaces:
  - "[exec]" prefix console logs for remote command execution
  - "[blueprint]" prefix console logs for step lifecycle
  - ExecResult.exitCode + stderr for command failure diagnosis
  - BlueprintResult.steps array with per-step status/message/duration
duration: 8m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T01: Build workspace exec primitive, blueprint types, and runner with tests

**Added execInWorkspace remote command primitive, blueprint type system, and sequential step runner with 12 passing tests**

## What Happened

Created three source modules forming the execution backbone for blueprint work:

1. **`src/lib/workspace/exec.ts`** — `execInWorkspace()` wraps `child_process.execFile("coder", ["ssh", workspace, "--", "bash", "-l", "-c", cmd])`. Uses login shell (`bash -l`) so nvm/pnpm tools are on PATH. Returns `{stdout, stderr, exitCode}` and never throws on non-zero exit. Supports configurable timeout (default 60s) with proper handling of both `killed` and `ERR_CHILD_PROCESS_TIMEOUT` error shapes. Logs with `[exec]` prefix including truncated command.

2. **`src/lib/blueprint/types.ts`** — Defines `BlueprintContext` (all downstream fields: assembledContext, scopedRules, toolFlags, piProvider, piModel), `StepResult`, `BlueprintStep`, and `BlueprintResult`.

3. **`src/lib/blueprint/runner.ts`** — `runBlueprint()` iterates steps sequentially, stops on first failure, continues on skip, catches thrown errors as failure StepResults, and tracks total duration. Logs with `[blueprint]` prefix.

One minor fix during implementation: the timeout stderr fallback used `??` (nullish coalescing) which doesn't catch empty string `""`; changed to `||` so the fallback message appears when stderr is empty.

## Verification

- `npx vitest run src/__tests__/lib/workspace/exec.test.ts` — 6 tests pass
- `npx vitest run src/__tests__/lib/blueprint/runner.test.ts` — 6 tests pass
- `npx vitest run` — all 36 tests pass (7 test files), zero regressions

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/workspace/exec.test.ts` | 0 | ✅ pass | 0.2s |
| 2 | `npx vitest run src/__tests__/lib/blueprint/runner.test.ts` | 0 | ✅ pass | 0.2s |
| 3 | `npx vitest run` | 0 | ✅ pass | 0.3s |

## Diagnostics

- Grep logs for `[exec]` to see all remote commands with workspace name, command snippet, and exit code
- Grep logs for `[blueprint]` to see step lifecycle events with taskId
- `BlueprintResult.steps` array contains per-step name, status, message, and durationMs
- `ExecResult` always has structured stdout/stderr/exitCode — check exitCode for non-zero, stderr for error details

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/lib/workspace/exec.ts` — execInWorkspace remote command primitive wrapping coder ssh
- `src/lib/blueprint/types.ts` — BlueprintContext, StepResult, BlueprintStep, BlueprintResult types
- `src/lib/blueprint/runner.ts` — Sequential blueprint step runner with failure/skip/error handling
- `src/__tests__/lib/workspace/exec.test.ts` — 6 test cases for exec primitive (success, failure, timeout variants, truncation)
- `src/__tests__/lib/blueprint/runner.test.ts` — 6 test cases for runner (success, failure stops, thrown error, skip continues, empty, context passthrough)
