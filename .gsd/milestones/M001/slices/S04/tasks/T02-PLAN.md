---
estimated_steps: 4
estimated_files: 3
---

# T02: Build CI feedback composite step with 2-round retry cap

**Slice:** S04 — CI Feedback Loop & PR Generation
**Milestone:** M001

## Description

Implement the CI feedback step — the most complex piece in S04. This is a composite step that orchestrates: poll GitHub Actions for CI result → if failed, extract logs, re-invoke agent with failure context, re-lint, re-push, re-poll → if second round fails, return failure with "CI exhaustion" message. The 2-round cap is per R029.

The step accepts injected dependencies (agent step factory, lint step factory, commit-push step factory) so it can re-invoke them during retry without circular imports, and so tests can provide mocks.

**Key knowledge from prior slices:**
- `execInWorkspace` never throws — returns `{ stdout, stderr, exitCode }`
- Existing steps use `ctx.workspaceName` for the SSH target
- The agent step is `createAgentStep()` from `src/lib/blueprint/steps/agent.ts`
- Use `mockImplementation(() => ...)` for fresh responses per call
- The project dir inside workspaces is `/home/coder/project`
- `ctx.branchName` has the branch name for `gh run list` filtering

**CI polling approach:**
- After push, wait 10s initial delay (GitHub Actions takes time to register runs)
- Poll `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId` every interval
- Exponential backoff: 5s → 10s → 20s → 30s cap
- 10-minute total timeout per polling cycle
- On failure, extract logs: `gh run view <id> --log-failed`

## Steps

1. **Add `ciRoundsUsed` to BlueprintContext** in `src/lib/blueprint/types.ts`:
   - Add `ciRoundsUsed?: number` — optional, set by the CI step to track rounds used
   - Add `prUrl?: string` — optional, set by PR step, read by worker for persistence

2. **Create `src/lib/blueprint/steps/ci.ts`** — `createCIStep(deps)` factory:
   - `deps` parameter: `{ createAgentStep, createLintStep, createCommitPushStep }` — injected factories for retry
   - Inner logic:
     a. Check `gh auth status` — if not authenticated, return failure immediately
     b. **Round 1:** Poll `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId` with backoff. If no run found after initial delay, retry a few times (CI may not have started yet).
     c. If CI passes (conclusion === "success") → set `ctx.ciRoundsUsed = 1`, return success
     d. If CI fails → extract failure logs via `gh run view <databaseId> --log-failed` (truncate to 3000 chars)
     e. **Round 2:** Feed failure context to agent: create a new agent step, modify ctx to include CI failure info in prompt/context, execute agent, then re-run lint step, then re-run commit-push step, then poll again
     f. If CI passes on round 2 → set `ctx.ciRoundsUsed = 2`, return success
     g. If CI fails on round 2 → set `ctx.ciRoundsUsed = 2`, return failure with "CI failed after 2 rounds" and include failure summary
   - Log `[blueprint] ci-feedback:` at each phase transition (polling, failure detected, retry, exhaustion)

3. **Write `src/__tests__/lib/blueprint/steps/ci.test.ts`** — Tests covering:
   - **CI passes first time:** gh auth ok → gh run list returns completed/success → returns success, ciRoundsUsed=1
   - **CI fails then passes on retry:** round 1 fails → agent re-invoked → lint → push → round 2 passes → returns success, ciRoundsUsed=2
   - **CI exhaustion (2 failures):** round 1 fails → retry → round 2 fails → returns failure with exhaustion message
   - **gh not authenticated:** gh auth status returns non-zero → returns failure immediately
   - **No CI run found initially:** gh run list returns empty, then on retry returns a run → handles gracefully

4. **Verify all tests pass and no regressions:** `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts && npx vitest run`

## Must-Haves

- [ ] CI step caps at exactly 2 rounds — R029
- [ ] Failed CI logs are extracted and fed to agent on retry
- [ ] Agent, lint, and commit-push steps re-invoked during retry via injected factories
- [ ] Exponential backoff polling with 10-minute timeout per round
- [ ] `ciRoundsUsed` tracked on context for downstream visibility
- [ ] Clear "CI exhaustion" failure message when 2 rounds fail
- [ ] gh auth check at step start with graceful failure

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/ci.test.ts` — all 5 scenarios pass
- `npx vitest run` — zero regressions

## Observability Impact

- Signals added: `[blueprint] ci-feedback:` logs for polling start, CI result per round, retry trigger, exhaustion
- How a future agent inspects this: grep container logs for `[blueprint] ci-feedback:` to see CI round progression; check `taskLogs` for step outcome with round count
- Failure state exposed: `ciRoundsUsed` in context; failure message includes round count and truncated CI error logs

## Inputs

- `src/lib/blueprint/steps/agent.ts` — `createAgentStep()` factory, re-invoked during retry
- `src/lib/blueprint/steps/lint.ts` — `createLintStep()` factory (from T01), re-invoked during retry
- `src/lib/blueprint/steps/commit-push.ts` — `createCommitPushStep()` factory (from T01), re-invoked during retry
- `src/lib/blueprint/types.ts` — BlueprintContext (with new ciRoundsUsed, prUrl fields), BlueprintStep, StepResult
- `src/lib/workspace/exec.ts` — execInWorkspace for running gh commands in workspace

## Expected Output

- `src/lib/blueprint/types.ts` — updated with `ciRoundsUsed?: number` and `prUrl?: string` on BlueprintContext
- `src/lib/blueprint/steps/ci.ts` — CI feedback composite step with 2-round cap, polling, retry logic
- `src/__tests__/lib/blueprint/steps/ci.test.ts` — 5 tests covering all CI feedback scenarios
