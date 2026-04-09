# S02: Review Blueprint & Claude Integration

**Goal:** Implement four council blueprint steps (clone, diff, review, emit) and the council-reviewer blueprint factory, with comprehensive unit tests proving each step works correctly — including Claude CLI invocation, JSON validation, and empty-diff graceful handling.
**Demo:** Unit tests show council blueprint steps execute correctly — claude --print invoked with diff, valid JSON returned as ReviewerFinding[], invalid JSON fails the job, empty diff produces empty findings gracefully.

## Must-Haves

- All four council blueprint steps (council-clone, council-diff, council-review, council-emit) implemented following the verify-clone/agent.ts factory pattern
- council-reviewer.ts blueprint factory returns all four steps in order
- BlueprintContext extended with optional councilDiff and councilFindings fields
- Unit tests pass for all four steps covering: success paths, failure paths, empty diff graceful handling, valid JSON parsing, invalid JSON causing failure, wrong-shape JSON causing failure
- `npx vitest run` passes with zero regressions
- `npx tsc --noEmit` shows zero net new errors

## Proof Level

- This slice proves: Contract — unit tests with mocked execInWorkspace prove step logic without requiring real workspaces or Claude CLI

## Integration Closure

- Upstream surfaces consumed: `BlueprintContext` and `BlueprintStep` from `src/lib/blueprint/types.ts`, `execInWorkspace` from `src/lib/workspace/exec.ts`, `PROJECT_DIR` / `AGENT_TIMEOUT_MS` / `EXEC_TIMEOUT_MS` from `src/lib/constants.ts`, `ReviewerFinding` from `src/lib/council/types.ts`
- New wiring introduced: council blueprint steps and factory; BlueprintContext extended with councilDiff/councilFindings
- What remains: S03 wires the council-reviewer blueprint into the BullMQ worker processor with workspace creation + FlowProducer fan-out + aggregation

## Verification

- Runtime signals: Each step logs `[blueprint] council-{step}: {message} (task={taskId})` at info level, matching existing blueprint logging convention
- Failure visibility: Step failures return structured `{ status: "failure", message }` with truncated stderr; council-emit surfaces JSON parse errors in the message field

## Tasks

- [x] **T01: Extend BlueprintContext, add constants, implement council-clone and council-diff steps with tests** `est:30m`
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
  - Files: `src/lib/blueprint/types.ts`, `src/lib/constants.ts`, `src/lib/blueprint/steps/council-clone.ts`, `src/lib/blueprint/steps/council-diff.ts`, `src/__tests__/lib/blueprint/steps/council-clone.test.ts`, `src/__tests__/lib/blueprint/steps/council-diff.test.ts`
  - Verify: npx vitest run src/__tests__/lib/blueprint/steps/council-clone.test.ts src/__tests__/lib/blueprint/steps/council-diff.test.ts && echo 'T01 PASS'

- [x] **T02: Implement council-review, council-emit steps, blueprint factory, and tests** `est:45m`
  Implement the council-review step (Claude CLI invocation via `claude --print`), council-emit step (JSON validation gate for R033), and the council-reviewer blueprint factory. Write comprehensive unit tests covering valid JSON, invalid JSON failure, wrong-shape JSON failure, empty findings, and empty-diff skip.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| claude --print (via execInWorkspace) | Return step failure with stderr excerpt | AGENT_TIMEOUT_MS causes exec timeout → step failure | council-emit validates; invalid JSON → job failure (D012) |
| execInWorkspace (prompt write) | Return step failure | EXEC_TIMEOUT_MS default | N/A — writing known data |

## Negative Tests

- **Malformed inputs**: council-emit receives non-JSON string → status failure; valid JSON but missing `findings` field → status failure; `findings` is not an array → status failure
- **Error paths**: claude --print exits non-zero → council-review returns failure; prompt file write fails → council-review returns failure
- **Boundary conditions**: empty findings array `{ findings: [] }` → success with zero findings; empty diff → council-review skips Claude invocation entirely

## Steps

1. Create `src/lib/blueprint/steps/council-review.ts`:
   - Export `createCouncilReviewStep(): BlueprintStep`
   - If `ctx.councilDiff === ""`: set `ctx.councilFindings = JSON.stringify({ findings: [] })`, return success with message "Empty diff — skipping review"
   - Otherwise:
     a. Build prompt string instructing Claude to output ONLY valid JSON matching `{ findings: ReviewerFinding[] }` schema. Include the diff inline in the prompt between `<diff>` tags.
     b. Base64-encode the prompt, write to COUNCIL_PROMPT_FILE via `execInWorkspace` (same pattern as agent.ts context file write). If write fails, return failure.
     c. Run `claude --print "$(cat /tmp/hive-council-prompt.txt)"` via `execInWorkspace` with `{ timeoutMs: AGENT_TIMEOUT_MS }`
     d. If exitCode !== 0: return failure with stderr excerpt
     e. Store stdout on `ctx.councilFindings`
     f. Return success
   - Log with `[blueprint] council-review:` prefix

2. Create `src/lib/blueprint/steps/council-emit.ts`:
   - Export `createCouncilEmitStep(): BlueprintStep`
   - Read `ctx.councilFindings` string
   - Try `JSON.parse(ctx.councilFindings)` — if parse throws, return `{ status: "failure", message: "Invalid JSON from Claude: {first 200 chars}" }`
   - Validate parsed object has `findings` array where each element has: `file` (string), `startLine` (number), `severity` (one of critical/major/minor/nit), `issue` (string), `fix` (string), `reasoning` (string)
   - If validation fails: return `{ status: "failure", message: "Findings schema validation failed: {details}" }`
   - If valid: return `{ status: "success", message: JSON.stringify(parsed.findings) }` with the validated findings count in the log
   - This step is the R033 enforcement gate — strict validation, no silent empty findings on bad data

3. Create `src/lib/blueprint/council-reviewer.ts`:
   - Export `createCouncilReviewerBlueprint(): BlueprintStep[]`
   - Returns `[createCouncilCloneStep(), createCouncilDiffStep(), createCouncilReviewStep(), createCouncilEmitStep()]`
   - Import all four step factories

4. Create `src/__tests__/lib/blueprint/steps/council-review.test.ts`:
   - Mock `@/lib/workspace/exec`
   - Helper `makeCtx()` with `councilDiff` pre-set (simulating council-diff having run)
   - Tests:
     a. Happy path: prompt write succeeds, `claude --print` returns valid JSON `{ findings: [{...}] }` → success, ctx.councilFindings set
     b. Empty diff path: `ctx.councilDiff = ""` → success without invoking execInWorkspace for Claude, ctx.councilFindings = `{"findings":[]}`
     c. Claude exits non-zero → step failure
     d. Prompt file write fails → step failure
     e. Verify prompt contains `<diff>` tags and JSON schema instructions
     f. Verify base64 encoding used for prompt (no shell injection)

5. Create `src/__tests__/lib/blueprint/steps/council-emit.test.ts`:
   - No mocks needed (council-emit does pure JSON parsing, no exec calls)
   - Tests:
     a. Valid JSON with correct schema → success, message contains stringified findings
     b. Invalid JSON string (not parseable) → failure with "Invalid JSON" message
     c. Valid JSON but no `findings` field → failure with schema validation message
     d. Valid JSON but `findings` not an array → failure
     e. Valid JSON but finding missing required field (e.g. no `startLine`) → failure
     f. Empty findings array `{ findings: [] }` → success with empty array
   - This test file is the critical R033 proof

6. Run full test suite: `npx vitest run` — all tests pass, zero regressions
7. Run `npx tsc --noEmit` — no more than 23 errors (pre-existing baseline)

## Must-Haves

- [ ] council-review writes prompt via base64 temp file, invokes `claude --print`, stores output on ctx.councilFindings
- [ ] council-review skips Claude invocation on empty diff, sets findings to empty array
- [ ] council-emit validates JSON strictly — invalid JSON returns failure (R033)
- [ ] council-emit validates finding schema — missing/wrong fields return failure
- [ ] council-reviewer.ts factory returns all four steps in correct order
- [ ] All council-review and council-emit tests pass
- [ ] Full test suite passes with zero regressions

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/council-review.test.ts src/__tests__/lib/blueprint/steps/council-emit.test.ts` — all tests pass
- `npx vitest run` — full suite passes, zero regressions
- `npx tsc --noEmit 2>&1 | grep -c 'error TS'` — no more than 23
  - Files: `src/lib/blueprint/steps/council-review.ts`, `src/lib/blueprint/steps/council-emit.ts`, `src/lib/blueprint/council-reviewer.ts`, `src/__tests__/lib/blueprint/steps/council-review.test.ts`, `src/__tests__/lib/blueprint/steps/council-emit.test.ts`
  - Verify: npx vitest run src/__tests__/lib/blueprint/steps/council-review.test.ts src/__tests__/lib/blueprint/steps/council-emit.test.ts && npx vitest run && echo 'T02 PASS'

## Files Likely Touched

- src/lib/blueprint/types.ts
- src/lib/constants.ts
- src/lib/blueprint/steps/council-clone.ts
- src/lib/blueprint/steps/council-diff.ts
- src/__tests__/lib/blueprint/steps/council-clone.test.ts
- src/__tests__/lib/blueprint/steps/council-diff.test.ts
- src/lib/blueprint/steps/council-review.ts
- src/lib/blueprint/steps/council-emit.ts
- src/lib/blueprint/council-reviewer.ts
- src/__tests__/lib/blueprint/steps/council-review.test.ts
- src/__tests__/lib/blueprint/steps/council-emit.test.ts
