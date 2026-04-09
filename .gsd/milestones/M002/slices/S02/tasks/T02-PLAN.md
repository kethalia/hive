---
estimated_steps: 68
estimated_files: 5
skills_used: []
---

# T02: Implement council-review, council-emit steps, blueprint factory, and tests

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

## Inputs

- `src/lib/blueprint/types.ts`
- `src/lib/blueprint/steps/council-clone.ts`
- `src/lib/blueprint/steps/council-diff.ts`
- `src/lib/blueprint/steps/agent.ts`
- `src/__tests__/lib/blueprint/steps/agent.test.ts`
- `src/lib/constants.ts`
- `src/lib/council/types.ts`
- `src/lib/workspace/exec.ts`
- `src/lib/blueprint/verifier.ts`

## Expected Output

- `src/lib/blueprint/steps/council-review.ts`
- `src/lib/blueprint/steps/council-emit.ts`
- `src/lib/blueprint/council-reviewer.ts`
- `src/__tests__/lib/blueprint/steps/council-review.test.ts`
- `src/__tests__/lib/blueprint/steps/council-emit.test.ts`

## Verification

npx vitest run src/__tests__/lib/blueprint/steps/council-review.test.ts src/__tests__/lib/blueprint/steps/council-emit.test.ts && npx vitest run && echo 'T02 PASS'
