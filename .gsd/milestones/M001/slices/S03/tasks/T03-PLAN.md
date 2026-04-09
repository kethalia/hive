---
estimated_steps: 5
estimated_files: 7
---

# T03: Implement agent execution step, wire blueprint into task-queue worker, and update worker tests

**Slice:** S03 — Blueprint Execution & Worker Agent
**Milestone:** M001

## Description

This task closes the S03 slice by: (1) implementing the agent execution step that runs Pi in `--print` mode inside the workspace (R003), (2) adding a `getWorkspaceResources()` method to CoderClient so we can resolve the workspace agent name for SSH, and (3) extending the BullMQ task-queue worker to wait for workspace build completion and then run the full blueprint pipeline instead of just creating a workspace.

After this task, the complete flow works: task enqueued → workspace created → build completes → blueprint runs [hydrate → rules → tools → agent] → task status updated to done/failed based on result. This fulfills R025 (blueprint execution) and R003 (unattended GSD execution).

**Critical implementation details from research:**
- Pi `--print` mode: `pi -p --no-session --provider anthropic --model claude-sonnet-4-20250514 "prompt"` — non-interactive, exits after completion
- Use `bash -l -c` login shell for PATH resolution (nvm, pnpm, pi all need login shell)
- Pipe assembled context via stdin to avoid shell argument length limits: write context to a temp file in workspace, then `cat /tmp/context.md | pi -p --no-session ...`
- Agent timeout: 30 minutes (complex tasks can run long)
- After agent runs, verify code changes exist with `git diff --stat` in the workspace
- Coder workspace resources endpoint: `GET /api/v2/workspaces/{id}/resources` returns agents array with `name` field — this is what `coder ssh` needs

**Key existing code to modify:**
- `src/lib/queue/task-queue.ts` — Current worker processor only creates workspace + records it. Must be extended to: wait for build, resolve agent name, run blueprint, update task status based on result. The existing error handling pattern (catch → set failed → log → rethrow) should be preserved.
- `src/lib/coder/client.ts` — Add `getWorkspaceResources()` method. The CoderClient pattern uses `this.request<T>(path)` for all API calls.
- `src/lib/coder/types.ts` — Add `WorkspaceResource` and `WorkspaceAgent` type definitions.

## Steps

1. **Create `src/lib/blueprint/steps/agent.ts`** — Export `createAgentStep(): BlueprintStep`. The execute function:
   - Write assembled context to a temp file in workspace: `execInWorkspace(ws, "cat > /tmp/hive-context.md << 'HIVE_CTX_EOF'\n${ctx.assembledContext}\n${ctx.scopedRules}\nHIVE_CTX_EOF")` — but this heredoc approach has quoting issues. Instead: use `execInWorkspace` to write via `printf '%s' '...' > /tmp/hive-context.md` or better, pipe the context as a base64-encoded string to avoid any shell escaping: `echo '<base64>' | base64 -d > /tmp/hive-context.md`
   - Construct Pi command: `cd /home/coder/project && cat /tmp/hive-context.md | pi -p --no-session --provider ${ctx.piProvider} --model ${ctx.piModel} "Based on the following context, implement this task: ${ctx.prompt}"`
   - Run via `execInWorkspace` with 30-minute timeout (1_800_000 ms)
   - After Pi completes, check for code changes: `execInWorkspace(ws, "cd /home/coder/project && git diff --stat")` 
   - If exit code 0 and git diff shows changes → `status: 'success'`
   - If exit code non-zero → `status: 'failure'` with Pi's stderr
   - If exit code 0 but no changes → `status: 'failure'` with "Agent completed but produced no code changes"

2. **Add `getWorkspaceResources()` to `src/lib/coder/client.ts`** — Add method:
   ```typescript
   async getWorkspaceResources(workspaceId: string): Promise<WorkspaceResource[]> {
     const ws = await this.getWorkspace(workspaceId);
     const buildId = ws.latest_build.id;
     return this.request<WorkspaceResource[]>(
       `/api/v2/workspacebuilds/${buildId}/resources`
     );
   }
   ```
   Also add a convenience method `getWorkspaceAgentName(workspaceId: string): Promise<string>` that calls `getWorkspaceResources`, finds the first agent, and returns `${ws.name}.${agent.name}` (the format `coder ssh` expects). Throws if no agent found.

3. **Update `src/lib/coder/types.ts`** — Add types:
   ```typescript
   export interface WorkspaceAgent {
     id: string;
     name: string;
     status: string;
   }
   export interface WorkspaceResource {
     id: string;
     name: string;
     type: string;
     agents?: WorkspaceAgent[];
   }
   ```

4. **Extend `src/lib/queue/task-queue.ts`** — Modify the worker processor function. After workspace creation and DB recording (existing code), add:
   - Import `runBlueprint` from `@/lib/blueprint/runner`
   - Import step factories from `@/lib/blueprint/steps/*`
   - Call `coderClient.waitForBuild(workspace.id, "running", { timeoutMs: 300_000 })` (5-min build timeout)
   - Update workspace status to 'running' in DB
   - Resolve agent name: `coderClient.getWorkspaceAgentName(workspace.id)`
   - Build `BlueprintContext` from job data + resolved workspace name
   - Build steps array: `[createHydrateStep(), createRulesStep(), createToolsStep(), createAgentStep()]`
   - Call `runBlueprint(steps, ctx)`
   - If blueprint succeeds: update task status to 'done', log success
   - If blueprint fails: update task status to 'failed' with the failed step's message
   - Log each transition to `taskLogs`
   - Set BullMQ job options: explicit timeout of 35 minutes (longer than agent's 30-min timeout)
   - Keep existing error handling pattern for unexpected errors

5. **Update tests** — Modify `src/__tests__/lib/queue/worker.test.ts` and create `src/__tests__/lib/blueprint/steps/agent.test.ts`:
   - **agent.test.ts**: Mock `@/lib/workspace/exec`. Tests: (a) successful agent run with code changes → success, (b) Pi exits non-zero → failure with stderr, (c) Pi succeeds but no changes → failure, (d) context written to temp file before Pi execution
   - **worker.test.ts**: Add mocks for `@/lib/blueprint/runner` (mock `runBlueprint`), `@/lib/coder/client` methods (`waitForBuild`, `getWorkspaceAgentName`). Update existing test for successful job to verify full flow: create workspace → waitForBuild → getWorkspaceAgentName → runBlueprint → status 'done'. Add test for blueprint failure → task status 'failed'. Keep existing error handling test for workspace creation failure.

## Must-Haves

- [ ] Agent step runs Pi in `--print --no-session` mode via execInWorkspace (R003)
- [ ] Agent step pipes assembled context + rules via temp file to avoid arg length limits
- [ ] Agent step has 30-minute timeout for long-running tasks
- [ ] Agent step verifies code changes exist via `git diff --stat` after Pi completes
- [ ] CoderClient has `getWorkspaceResources()` and `getWorkspaceAgentName()` methods
- [ ] Task-queue worker calls waitForBuild → runBlueprint after workspace creation (R025)
- [ ] Task status transitions: running → done (on success) or running → failed (on failure)
- [ ] Blueprint failures surface in task's errorMessage with the step name that failed
- [ ] All new and existing tests pass: `npx vitest run`

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/agent.test.ts` — agent step tests pass
- `npx vitest run src/__tests__/lib/queue/worker.test.ts` — updated worker tests pass
- `npx vitest run` — all tests pass (no regressions)

## Observability Impact

- Signals added: `[blueprint]` step-level logs from runner; `[exec]` command logs for Pi execution; `[queue]` logs for waitForBuild + blueprint phases
- How a future agent inspects this: `SELECT * FROM task_logs WHERE task_id = X ORDER BY created_at` shows step-by-step progress; `tasks.error_message` contains failed step details
- Failure state exposed: which blueprint step failed, Pi exit code + stderr, whether code changes were produced

## Inputs

- `src/lib/workspace/exec.ts` — exec primitive from T01
- `src/lib/blueprint/types.ts` — shared types from T01
- `src/lib/blueprint/runner.ts` — runner from T01
- `src/lib/blueprint/steps/hydrate.ts` — hydrate step from T02
- `src/lib/blueprint/steps/rules.ts` — rules step from T02
- `src/lib/blueprint/steps/tools.ts` — tools step from T02
- `src/lib/coder/client.ts` — existing CoderClient with createWorkspace, getWorkspace, waitForBuild
- `src/lib/coder/types.ts` — existing Coder types
- `src/lib/queue/task-queue.ts` — existing worker processor that creates workspace only
- `src/__tests__/lib/queue/worker.test.ts` — existing worker tests (3 test cases) that need updating

## Expected Output

- `src/lib/blueprint/steps/agent.ts` — agent execution step (R003)
- `src/__tests__/lib/blueprint/steps/agent.test.ts` — agent step tests (3-4 test cases)
- `src/lib/coder/client.ts` — modified with getWorkspaceResources + getWorkspaceAgentName
- `src/lib/coder/types.ts` — modified with WorkspaceResource + WorkspaceAgent types
- `src/lib/queue/task-queue.ts` — modified worker with full blueprint flow
- `src/__tests__/lib/queue/worker.test.ts` — updated worker tests covering full flow (4+ test cases)
- `src/__tests__/lib/coder/client.test.ts` — may need updates if existing tests are affected by new methods
