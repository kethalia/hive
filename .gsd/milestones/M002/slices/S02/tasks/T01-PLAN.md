---
estimated_steps: 39
estimated_files: 6
skills_used: []
---

# T01: Extend BlueprintContext, add constants, implement council-clone and council-diff steps with tests

Extend BlueprintContext with optional councilDiff and councilFindings fields for passing data between council steps. Add COUNCIL_PROMPT_FILE constant. Implement council-clone (clone repo + checkout PR branch, nearly identical to verify-clone) and council-diff (get git diff, store on ctx.councilDiff, handle empty diff gracefully). Write unit tests for both steps following verify-clone.test.ts patterns.

## Steps

1. Edit `src/lib/blueprint/types.ts` — add two optional fields to `BlueprintContext`:
   - `councilDiff?: string` — stores the git diff output from council-diff step
   - `councilFindings?: string` — stores raw Claude JSON output from council-review step
   These are optional so existing steps are unaffected.

2. Edit `src/lib/constants.ts` — add:
   - `COUNCIL_PROMPT_FILE = "/tmp/hive-council-prompt.txt"` — temp file for council review prompt

3. Create `src/lib/blueprint/steps/council-clone.ts`:
   - Export `createCouncilCloneStep(): BlueprintStep`
   - Nearly identical to `verify-clone.ts` — base64-encode repoUrl and branchName, build idempotent clone/checkout script, call `execInWorkspace(ctx.workspaceName, cmd)`
   - On exitCode !== 0: return `{ status: "failure", message: "Clone/checkout failed: {stderr}" }`
   - On success: return `{ status: "success", message: "Cloned and checked out {branchName}" }`
   - Log with `[blueprint] council-clone:` prefix

4. Create `src/lib/blueprint/steps/council-diff.ts`:
   - Export `createCouncilDiffStep(): BlueprintStep`
   - Run `cd /home/coder/project && git diff origin/main...HEAD` via `execInWorkspace`
   - On exitCode !== 0: return `{ status: "failure", message: "Failed to get diff: {stderr}" }`
   - On success with non-empty stdout: set `ctx.councilDiff = result.stdout`, return success
   - On success with empty stdout (empty diff): set `ctx.councilDiff = ""`, return `{ status: "success", message: "Empty diff — no changes to review" }`
   - IMPORTANT: empty diff must NOT be a failure — it's a valid edge case
   - Log with `[blueprint] council-diff:` prefix

5. Create `src/__tests__/lib/blueprint/steps/council-clone.test.ts`:
   - Mock `@/lib/workspace/exec` with `vi.mock` (same pattern as verify-clone.test.ts)
   - Helper `makeCtx()` returns full BlueprintContext with council fields
   - Tests: success case, failure case (repo not found), failure case (branch not found), base64 injection prevention

6. Create `src/__tests__/lib/blueprint/steps/council-diff.test.ts`:
   - Mock `@/lib/workspace/exec`
   - Tests: success with diff content (verify ctx.councilDiff set), success with empty diff (verify ctx.councilDiff is empty string, status is success not failure), failure on git error

## Must-Haves

- [ ] BlueprintContext has `councilDiff?: string` and `councilFindings?: string` fields
- [ ] COUNCIL_PROMPT_FILE constant exported from constants.ts
- [ ] council-clone step follows verify-clone pattern with base64 encoding
- [ ] council-diff handles empty diff as success, not failure
- [ ] All council-clone and council-diff tests pass

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/council-clone.test.ts` — all tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/council-diff.test.ts` — all tests pass
- `npx tsc --noEmit 2>&1 | grep -c 'error TS'` — no more than 23 (pre-existing baseline)

## Inputs

- `src/lib/blueprint/types.ts`
- `src/lib/blueprint/steps/verify-clone.ts`
- `src/__tests__/lib/blueprint/steps/verify-clone.test.ts`
- `src/lib/constants.ts`
- `src/lib/workspace/exec.ts`
- `src/lib/council/types.ts`

## Expected Output

- `src/lib/blueprint/types.ts`
- `src/lib/constants.ts`
- `src/lib/blueprint/steps/council-clone.ts`
- `src/lib/blueprint/steps/council-diff.ts`
- `src/__tests__/lib/blueprint/steps/council-clone.test.ts`
- `src/__tests__/lib/blueprint/steps/council-diff.test.ts`

## Verification

npx vitest run src/__tests__/lib/blueprint/steps/council-clone.test.ts src/__tests__/lib/blueprint/steps/council-diff.test.ts && echo 'T01 PASS'
