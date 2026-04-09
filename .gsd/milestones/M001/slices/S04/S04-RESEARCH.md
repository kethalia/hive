# S04: CI Feedback Loop & PR Generation — Research

**Date:** 2026-03-19

## Summary

S04 extends the blueprint pipeline from S03 with four new steps: **lint** (local autofix), **commit-and-push** (git add/commit/push to branch), **ci-feedback** (poll CI, feed failures back to agent, 2-round cap per R029), and **pr-create** (open PR with templated body via `gh pr create`). It also adds a **workspace cleanup** module (stop + delete after configurable grace period per R015).

This is straightforward extension of established patterns. Every existing step follows the same `BlueprintStep` interface, uses `execInWorkspace` for remote commands, and returns structured `StepResult`. The new steps are the same. The CI feedback loop is the one moderately complex piece — it needs to poll GitHub Actions status, parse failure output, and re-invoke the agent (reusing `createAgentStep()`) for a second attempt.

The Task model already has `prUrl` and `branch` fields. `TaskStatus` has `failed` which covers the "needs_attention" state for CI exhaustion. No schema changes needed. The `CoderClient` already has `stopWorkspace()` and `deleteWorkspace()` for cleanup.

## Recommendation

Build bottom-up: lint step → commit/push step → CI polling step → PR creation step → wire into worker pipeline → workspace cleanup. The CI feedback loop should be a composite step that orchestrates lint→push→poll→(optionally agent→lint→push→poll) rather than the runner handling retry logic. This keeps the runner simple and puts the 2-round cap logic in one place.

The cleanup module should be a standalone function called after the blueprint completes (success or failure), not a blueprint step — cleanup is unconditional and shouldn't participate in step success/failure semantics.

## Implementation Landscape

### Key Files

- `src/lib/blueprint/steps/lint.ts` — **New.** Runs lint with autofix in workspace. `cd /home/coder/project && npx eslint --fix . 2>&1 || true` (or detect linter from package.json). Must complete in <5s per R028. Returns success always (autofix is best-effort).
- `src/lib/blueprint/steps/commit-push.ts` — **New.** `git add -A && git commit -m "<message>" && git push origin <branch>`. Constructs descriptive commit message from task prompt. Needs `git config user.email/name` setup.
- `src/lib/blueprint/steps/ci.ts` — **New.** Composite step: push → poll `gh run list --branch <branch> --limit 1 --json status,conclusion` → wait for completion → if failed, extract logs via `gh run view <id> --log-failed`, feed to agent, lint, push again → poll second run → if still failed, return failure with "CI exhaustion" message.
- `src/lib/blueprint/steps/pr.ts` — **New.** `gh pr create --title "<title>" --body "<body>" --base main --head <branch>`. Captures PR URL from stdout, stores in `ctx` for the worker to persist to `tasks.prUrl`.
- `src/lib/workspace/cleanup.ts` — **New.** `cleanupWorkspace(coderClient, workspaceId, graceMs)` — waits grace period, then calls `stopWorkspace` + `deleteWorkspace`. Updates workspace status in DB.
- `src/lib/blueprint/types.ts` — **Extend.** Add optional `prUrl?: string` and `ciRoundsUsed?: number` to `BlueprintContext` so downstream steps and the worker can read them.
- `src/lib/queue/task-queue.ts` — **Modify.** Add lint, ci, pr steps to the blueprint array after agent. Call cleanup after blueprint completes. Persist `prUrl` and `branch` to Task record on success.
- `src/lib/blueprint/runner.ts` — **No changes.** The sequential runner works as-is.

### Build Order

1. **Lint step** — simplest, no external dependencies, proves the step pattern works for S04. Tests mock `execInWorkspace` same as existing steps.
2. **Commit-push step** — depends on nothing, straightforward git commands. Tests verify commit message construction and git config setup.
3. **PR creation step** — uses `gh pr create`, captures URL. Tests mock exec responses.
4. **CI feedback step** — most complex. Depends on commit-push (to trigger CI). Needs to reuse agent step for retry. Tests cover: CI passes first time, CI fails then passes on retry, CI fails twice (exhaustion).
5. **Workspace cleanup module** — independent of steps. Tests mock CoderClient methods.
6. **Worker integration** — wire all steps into task-queue.ts, persist prUrl/branch, call cleanup.

### Verification Approach

- Unit tests for each new step following the exact pattern in `src/__tests__/lib/blueprint/steps/agent.test.ts` — mock `execInWorkspace`, dispatch on command content.
- Unit test for cleanup module mocking CoderClient.
- Updated worker test verifying the full extended pipeline.
- `npx vitest run` — all tests pass, zero regressions from S01-S03.

## Constraints

- `gh` CLI must be authenticated inside the workspace — the worker Coder template should have GitHub external auth configured. The steps should check `gh auth status` and fail gracefully with a clear message if not authenticated.
- Lint must complete in <5 seconds (R028). The step should use a hard timeout of 5000ms via `execInWorkspace` options. If lint times out, treat as success (best-effort autofix, don't block the pipeline).
- CI polling needs a reasonable timeout — GitHub Actions can take minutes. Use 10-minute timeout with exponential backoff (5s → 10s → 20s → 30s cap).
- The `gh run list` and `gh run view` commands require the working directory to be inside the git repo (they use the remote URL to identify the repo).
- Git push requires the branch to exist or `--set-upstream`. Use `git push -u origin <branch>` on first push.

## Common Pitfalls

- **CI run not found immediately after push** — GitHub Actions takes a few seconds to register a new run. Add a short delay (5-10s) before first poll, or retry `gh run list` if it returns no runs for the branch.
- **`gh pr create` fails if PR already exists** — On the second CI round, the branch already has commits pushed. PR creation must happen only after CI passes (or after the second round exhausts). Don't create a PR before CI completes.
- **Git config not set in workspace** — `git commit` fails without `user.email` and `user.name`. Set these in the commit-push step before committing. Use generic "Hive Bot" identity.
- **Lint step running wrong linter** — Repos may use ESLint, Biome, Prettier, or no linter at all. Detect from package.json scripts (look for `"lint"` script) and fall back to `npm run lint -- --fix` if it exists, or skip gracefully.

## Open Risks

- CI polling relies on `gh` being installed and authenticated in the workspace. If the Coder template doesn't have `gh` or GitHub external auth isn't configured, the entire CI loop fails. The step should detect this early and return a clear failure message.
- The 2-round CI feedback requires re-running the agent step, which has a 30-minute timeout. Combined with CI polling (up to 10 minutes per round), the total job time could approach 80+ minutes. The BullMQ job timeout (currently 35 minutes) must be increased significantly — probably to 90 minutes.
