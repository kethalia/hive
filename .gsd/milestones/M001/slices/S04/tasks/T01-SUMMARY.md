---
id: T01
parent: S04
milestone: M001
provides:
  - createLintStep factory — best-effort lint autofix, always returns success
  - createCommitPushStep factory — git identity + stage + commit + push
  - createPRStep factory — gh pr create with templated body and URL capture
key_files:
  - src/lib/blueprint/steps/lint.ts
  - src/lib/blueprint/steps/commit-push.ts
  - src/lib/blueprint/steps/pr.ts
  - src/__tests__/lib/blueprint/steps/lint.test.ts
  - src/__tests__/lib/blueprint/steps/commit-push.test.ts
  - src/__tests__/lib/blueprint/steps/pr.test.ts
key_decisions:
  - Used base64 encoding for PR title/body shell transport (same pattern as agent step context piping) to avoid shell injection from user prompts
  - Commit message format: "hive: <prompt truncated to 72 chars>" — conventional prefix for easy filtering
patterns_established:
  - All three steps follow the same factory pattern as agent.ts: factory returns { name, execute(ctx) => StepResult }
  - Tests use mockImplementation with command-string dispatch, same as agent.test.ts
observability_surfaces:
  - "[blueprint] lint:" log with outcome (skip/timeout/autofix/error)
  - "[blueprint] commit-push:" log with commit hash or failure reason
  - "[blueprint] pr-create:" log with PR URL or failure reason
duration: 15m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T01: Build lint, commit-push, and PR creation blueprint steps

**Implemented three BlueprintStep factories (lint, commit-push, PR creation) with 12 passing tests covering success, failure, and edge cases**

## What Happened

Built three new blueprint step modules following the established pattern in `agent.ts`:

1. **Lint step** (`createLintStep`): Reads `package.json` to check for a lint script, runs `npm run lint -- --fix` with a 5000ms hard timeout (R028). Always returns `status: "success"` — lint is best-effort. Handles: no lint script (skip), timeout (exitCode 124), lint errors (continue anyway), invalid package.json (skip).

2. **Commit-push step** (`createCommitPushStep`): Sets git identity to "Hive Bot", stages all changes with `git add -A`, commits with a descriptive message derived from the task prompt (truncated to 72 chars), and pushes with `git push -u origin <branch>`. Returns failure if any git operation fails. Extracts commit hash from git output.

3. **PR step** (`createPRStep`): Runs `gh pr create` with a templated title ("hive: ...") and body containing the task prompt, task ID, and auto-generated attribution note. Uses base64 encoding for title/body to avoid shell injection. Captures the PR URL from stdout.

All three follow the BlueprintStep interface exactly and use `execInWorkspace` for remote execution.

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts` — 4 tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/commit-push.test.ts` — 4 tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/pr.test.ts` — 4 tests pass
- `npx vitest run` — all 66 tests pass, zero regressions

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/blueprint/steps/lint.test.ts` | 0 | ✅ pass | 3.7s |
| 2 | `npx vitest run src/__tests__/lib/blueprint/steps/commit-push.test.ts` | 0 | ✅ pass | 3.7s |
| 3 | `npx vitest run src/__tests__/lib/blueprint/steps/pr.test.ts` | 0 | ✅ pass | 3.7s |
| 4 | `npx vitest run` | 0 | ✅ pass | 3.5s |

## Diagnostics

- Each step logs with a `[blueprint] <step-name>:` prefix including task ID — grep for these in worker output
- Step results carry structured messages: lint has skip/timeout/error reasons, commit-push has commit hash, PR has URL — all stored in `StepResult.message` which the worker persists to `taskLogs`
- Failure cases: commit-push stderr includes the git error; PR stderr includes the `gh` error message

## Deviations

- Added a 4th test to commit-push (prompt truncation) beyond the plan's "3-4 tests" — straightforward edge case coverage
- Added a 4th test to PR (base64 body verification) beyond the plan's "3 tests" — verifies the shell-safe transport

## Known Issues

None.

## Files Created/Modified

- `src/lib/blueprint/steps/lint.ts` — Lint step factory: best-effort autofix with 5s timeout, always succeeds
- `src/lib/blueprint/steps/commit-push.ts` — Commit-push step factory: git identity + stage + commit + push
- `src/lib/blueprint/steps/pr.ts` — PR creation step factory: gh pr create with base64-encoded title/body
- `src/__tests__/lib/blueprint/steps/lint.test.ts` — 4 tests: lint found, no lint, timeout, error
- `src/__tests__/lib/blueprint/steps/commit-push.test.ts` — 4 tests: success, push fail, nothing to commit, truncation
- `src/__tests__/lib/blueprint/steps/pr.test.ts` — 4 tests: success, auth fail, already exists, body content
- `.gsd/milestones/M001/slices/S04/S04-PLAN.md` — Pre-flight: added failure-path verification check
- `.gsd/milestones/M001/slices/S04/tasks/T01-PLAN.md` — Pre-flight: added Observability Impact section
