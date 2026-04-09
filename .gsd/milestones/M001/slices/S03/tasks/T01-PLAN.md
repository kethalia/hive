---
estimated_steps: 4
estimated_files: 5
---

# T01: Build workspace exec primitive, blueprint types, and runner with tests

**Slice:** S03 — Blueprint Execution & Worker Agent
**Milestone:** M001

## Description

Create the two foundational modules that all blueprint work depends on: (1) a workspace exec primitive that runs commands inside Coder workspaces via `coder ssh`, and (2) a blueprint runner that sequences async step functions. Both are pure TypeScript with no external dependencies beyond `child_process`. This task establishes the execution backbone — all subsequent blueprint steps (hydrate, rules, tools, agent) build on these primitives.

The exec primitive wraps `child_process.execFile("coder", ["ssh", workspaceName, "--", "bash", "-l", "-c", command])`. Using `bash -l` (login shell) is critical because tools installed via `nvm`, `pnpm`, etc. are only on PATH in a login shell inside the workspace. The function returns `{stdout, stderr, exitCode}` and supports configurable timeouts.

The blueprint runner takes an array of `BlueprintStep` functions and a `BlueprintContext` object, calls each step sequentially, and handles errors per-step. It does NOT use a DAG, plugin system, or step registry — just a typed array of async functions called in order (per R025: "TypeScript functions, not a generic engine").

## Steps

1. **Create `src/lib/workspace/exec.ts`** — Export an `execInWorkspace(workspaceName: string, command: string, opts?: ExecOptions): Promise<ExecResult>` function. Implementation:
   - Use `child_process.execFile("coder", ["ssh", workspaceName, "--", "bash", "-l", "-c", command])` 
   - Return `{ stdout: string, stderr: string, exitCode: number }`
   - Support `opts.timeoutMs` (default 60_000) — pass to `execFile` options as `timeout`
   - On timeout, the execFile callback receives an error with `code === 'ERR_CHILD_PROCESS_TIMEOUT'` or `killed === true` — handle both
   - Log with `[exec]` prefix: workspace name, command (truncated to 100 chars), exit code
   - Export the `ExecResult` and `ExecOptions` types

2. **Create `src/lib/blueprint/types.ts`** — Define shared types:
   - `BlueprintContext`: `{ taskId: string, workspaceName: string, repoUrl: string, prompt: string, branchName: string, assembledContext: string, scopedRules: string, toolFlags: string[], piProvider: string, piModel: string }`
   - `StepResult`: `{ status: 'success' | 'failure' | 'skipped', message: string, durationMs: number }`
   - `BlueprintStep`: `{ name: string, execute: (ctx: BlueprintContext) => Promise<StepResult> }`
   - `BlueprintResult`: `{ success: boolean, steps: Array<{ name: string } & StepResult>, totalDurationMs: number }`

3. **Create `src/lib/blueprint/runner.ts`** — Export `runBlueprint(steps: BlueprintStep[], ctx: BlueprintContext): Promise<BlueprintResult>`. Implementation:
   - Iterate steps sequentially with `for...of`
   - For each step: log `[blueprint] Starting step: ${step.name}`, call `step.execute(ctx)`, log result
   - If a step returns `status: 'failure'`, stop execution (don't run remaining steps), set `success: false`
   - If a step throws, catch the error, record it as a failure StepResult, stop execution
   - If a step returns `status: 'skipped'`, log and continue to next step
   - Track total duration with `Date.now()` before/after
   - Return `BlueprintResult` with all step outcomes

4. **Write tests** — Create `src/__tests__/lib/workspace/exec.test.ts` and `src/__tests__/lib/blueprint/runner.test.ts`:
   - **exec.test.ts**: Mock `child_process.execFile` via `vi.mock("child_process")`. Test cases: (a) successful command returns stdout + exitCode 0, (b) failed command returns non-zero exitCode with stderr, (c) timeout triggers appropriate error, (d) default timeout is applied when no opts provided
   - **runner.test.ts**: No mocks needed — use inline mock step functions. Test cases: (a) all steps succeed → success result, (b) middle step fails → stops execution + remaining steps not called, (c) step throws → caught as failure, (d) skipped step → continues to next, (e) empty steps array → success with no step results, (f) context object is passed through to each step

## Must-Haves

- [ ] `execInWorkspace` uses `bash -l -c` for login shell (tools on PATH)
- [ ] `execInWorkspace` supports configurable timeout with sensible default (60s)
- [ ] `execInWorkspace` returns structured `{stdout, stderr, exitCode}` — never throws on non-zero exit
- [ ] `runBlueprint` stops on first failure, continues on skip
- [ ] `runBlueprint` catches thrown errors and records them as step failures
- [ ] `BlueprintContext` includes all fields needed by downstream steps (assembledContext, scopedRules, toolFlags, piProvider, piModel)
- [ ] All tests pass: `npx vitest run src/__tests__/lib/workspace/exec.test.ts src/__tests__/lib/blueprint/runner.test.ts`

## Verification

- `npx vitest run src/__tests__/lib/workspace/exec.test.ts` — all exec tests pass
- `npx vitest run src/__tests__/lib/blueprint/runner.test.ts` — all runner tests pass
- `npx vitest run` — no existing tests broken

## Observability Impact

- Signals added: `[exec]` prefix logs for every remote command (workspace, command truncated, exit code); `[blueprint]` prefix logs for step start/complete/fail
- How a future agent inspects this: grep logs for `[exec]` or `[blueprint]` prefix; step results in BlueprintResult
- Failure state exposed: failed step name and error message in BlueprintResult; exec exit code + stderr in ExecResult

## Inputs

- Existing project structure with Vitest configured (`vitest.config.ts` includes `src/__tests__/**/*.test.ts`)
- Knowledge that `coder ssh <workspace> -- <command>` is the remote execution mechanism
- Knowledge that `bash -l -c` is required for login shell PATH resolution in workspaces

## Expected Output

- `src/lib/workspace/exec.ts` — workspace remote exec primitive
- `src/lib/blueprint/types.ts` — shared types for blueprint system
- `src/lib/blueprint/runner.ts` — sequential step runner
- `src/__tests__/lib/workspace/exec.test.ts` — exec tests (4+ test cases)
- `src/__tests__/lib/blueprint/runner.test.ts` — runner tests (5+ test cases)
