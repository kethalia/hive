---
estimated_steps: 5
estimated_files: 6
---

# T01: Build lint, commit-push, and PR creation blueprint steps

**Slice:** S04 — CI Feedback Loop & PR Generation
**Milestone:** M001

## Description

Implement three new BlueprintStep factories — lint, commit-push, and PR creation — following the established pattern in `src/lib/blueprint/steps/agent.ts`. Each step uses `execInWorkspace` for remote command execution and returns structured `StepResult`. These are the straightforward building blocks that the CI feedback step (T02) and worker integration (T03) depend on.

**Key knowledge from prior slices:**
- All blueprint steps follow the same interface: `{ name: string, execute: (ctx: BlueprintContext) => Promise<StepResult> }`
- `execInWorkspace(workspaceName, command, { timeoutMs })` runs commands via `coder ssh` — never throws, returns `{ stdout, stderr, exitCode }`
- Context is in `ctx.workspaceName` (SSH target), `ctx.branchName`, `ctx.prompt`, `ctx.taskId`
- The project dir inside workspaces is `/home/coder/project`
- Tests mock `@/lib/workspace/exec` module and dispatch on command string content
- Use `mockImplementation` (not `mockResolvedValue`) to return fresh responses per call — see KNOWLEDGE.md "Vitest: Response Body Can Only Be Read Once"

## Steps

1. **Create `src/lib/blueprint/steps/lint.ts`** — `createLintStep()` factory:
   - Run `cd /home/coder/project && cat package.json` to check for a `"lint"` script
   - If lint script exists: `cd /home/coder/project && npm run lint -- --fix 2>&1 || true`
   - If no lint script: return success with "No lint script found, skipping"
   - Use 5000ms hard timeout (R028). If exec times out (exitCode 124), return success with "Lint timed out, continuing"
   - Always return `status: "success"` — lint is best-effort autofix, never blocks the pipeline
   - Log `[blueprint] lint:` with outcome

2. **Create `src/lib/blueprint/steps/commit-push.ts`** — `createCommitPushStep()` factory:
   - Set git identity: `cd /home/coder/project && git config user.email "hive-bot@coder.com" && git config user.name "Hive Bot"`
   - Stage all changes: `cd /home/coder/project && git add -A`
   - Construct descriptive commit message from `ctx.prompt` (truncate to 72 chars for subject line)
   - Commit: `cd /home/coder/project && git commit -m "<message>"`
   - Push: `cd /home/coder/project && git push -u origin ${ctx.branchName}`
   - Return success with commit hash from stdout, or failure if push fails
   - Log `[blueprint] commit-push:` with commit hash

3. **Create `src/lib/blueprint/steps/pr.ts`** — `createPRStep()` factory:
   - Run: `cd /home/coder/project && gh pr create --title "<title>" --body "<body>" --base main --head ${ctx.branchName}`
   - Title derived from prompt (truncated, prefixed with "hive: ")
   - Body is a template including: task description, what the agent changed, auto-generated note
   - Capture PR URL from stdout (gh pr create outputs the URL on success)
   - Store PR URL in `ctx` by mutating a known field or returning it in the message (the CI step and worker will extract it)
   - Return failure with clear message if `gh` is not authenticated or PR creation fails
   - Log `[blueprint] pr-create:` with PR URL

4. **Write `src/__tests__/lib/blueprint/steps/lint.test.ts`** — Tests:
   - Lint script found → runs npm run lint -- --fix, returns success
   - No lint script in package.json → returns success with skip message
   - Lint times out (exitCode 124) → returns success
   - Lint command fails (non-zero, non-timeout) → still returns success (best-effort)

5. **Write `src/__tests__/lib/blueprint/steps/commit-push.test.ts`** — Tests:
   - Successful commit and push → returns success with commit info
   - Git config + add + commit + push sequence verified via mock call inspection
   - Push fails (e.g., auth error) → returns failure
   - Empty working tree (nothing to commit) → returns failure

6. **Write `src/__tests__/lib/blueprint/steps/pr.test.ts`** — Tests:
   - Successful PR creation → returns success, message contains PR URL
   - gh not authenticated → returns failure with clear message
   - PR already exists → returns failure with descriptive message

## Must-Haves

- [ ] Lint step always returns success (even on timeout or lint errors) — R028 best-effort
- [ ] Lint step uses 5000ms timeout — R028 <5s constraint
- [ ] Commit-push step sets git identity before committing
- [ ] Commit-push step uses `git push -u origin <branch>` for first push
- [ ] PR step captures URL from gh stdout
- [ ] PR body includes task prompt and auto-generated description — R004
- [ ] All three steps follow the BlueprintStep interface exactly
- [ ] All tests mock execInWorkspace at the module boundary, not child_process

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts` — all pass
- `npx vitest run src/__tests__/lib/blueprint/steps/commit-push.test.ts` — all pass
- `npx vitest run src/__tests__/lib/blueprint/steps/pr.test.ts` — all pass
- `npx vitest run` — zero regressions

## Observability Impact

- **New signals:** `[blueprint] lint:` logs lint outcome (skip/timeout/autofix result); `[blueprint] commit-push:` logs commit hash or failure reason; `[blueprint] pr-create:` logs PR URL or failure reason
- **Inspection:** Each step's `StepResult.message` contains structured detail (commit hash, PR URL, skip reason) that the worker records to `taskLogs`
- **Failure visibility:** Lint failures are silent (best-effort), but logged. Commit-push failures surface stderr from git. PR failures surface stderr from `gh`. All are inspectable via step messages in taskLogs.
- **Future agent debugging:** A failing commit-push will show "push failed" with stderr; a failing PR will show "gh pr create failed" with the exact error from GitHub CLI

## Inputs

- `src/lib/blueprint/steps/agent.ts` — reference implementation for step pattern (factory, execInWorkspace usage, logging, StepResult returns)
- `src/__tests__/lib/blueprint/steps/agent.test.ts` — reference test pattern (mock setup, makeCtx helper, dispatch on command content)
- `src/lib/blueprint/types.ts` — BlueprintContext, BlueprintStep, StepResult interfaces
- `src/lib/workspace/exec.ts` — execInWorkspace signature and ExecResult type

## Expected Output

- `src/lib/blueprint/steps/lint.ts` — lint step factory, always-success autofix
- `src/lib/blueprint/steps/commit-push.ts` — commit-push step factory, git identity + stage + commit + push
- `src/lib/blueprint/steps/pr.ts` — PR creation step factory, gh pr create + URL capture
- `src/__tests__/lib/blueprint/steps/lint.test.ts` — 4 tests
- `src/__tests__/lib/blueprint/steps/commit-push.test.ts` — 3-4 tests
- `src/__tests__/lib/blueprint/steps/pr.test.ts` — 3 tests
