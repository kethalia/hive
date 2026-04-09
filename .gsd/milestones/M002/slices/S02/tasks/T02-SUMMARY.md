---
id: T02
parent: S02
milestone: M002
key_files:
  - src/lib/blueprint/steps/council-review.ts
  - src/lib/blueprint/steps/council-emit.ts
  - src/lib/blueprint/council-reviewer.ts
  - src/__tests__/lib/blueprint/steps/council-review.test.ts
  - src/__tests__/lib/blueprint/steps/council-emit.test.ts
key_decisions:
  - council-review base64-encodes the full prompt including diff to prevent shell injection from untrusted code
  - council-emit returns validated findings as JSON.stringify in the message field — consistent with other emit/report steps
duration: 
verification_result: passed
completed_at: 2026-04-09T08:55:50.292Z
blocker_discovered: false
---

# T02: Implemented council-review (Claude invocation via base64 prompt), council-emit (R033 JSON validation gate), council-reviewer factory, and 32 unit tests with full schema edge-case coverage

**Implemented council-review (Claude invocation via base64 prompt), council-emit (R033 JSON validation gate), council-reviewer factory, and 32 unit tests with full schema edge-case coverage**

## What Happened

Created council-review.ts with empty-diff early-return (synthetic empty findings), base64-encoded prompt write to COUNCIL_PROMPT_FILE, claude --print invocation with AGENT_TIMEOUT_MS, and failure handling with stderr truncation. Created council-emit.ts as the R033 enforcement gate: JSON.parse with 200-char preview on failure, findings-array shape check, per-field ReviewerFinding validation (file/startLine/severity/issue/fix/reasoning) with named diagnostic messages. Created council-reviewer.ts factory returning [clone, diff, review, emit]. Wrote 8 council-review tests (happy path, empty diff, non-zero exit, write failure, prompt structure, injection prevention, log prefix) and 24 council-emit tests (all schema permutations, empty array, all 4 severities, field-level missing/wrong-type). Full suite: 205/205 pass, 30 test files, 23 pre-existing TS errors (no regressions).

## Verification

npx vitest run on council-review.test.ts + council-emit.test.ts: 32/32 pass. npx vitest run full suite: 205/205 pass. npx tsc --noEmit | grep -c error TS: 23 (baseline).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/blueprint/steps/council-review.test.ts src/__tests__/lib/blueprint/steps/council-emit.test.ts` | 0 | ✅ pass | 179ms |
| 2 | `npx vitest run` | 0 | ✅ pass | 1410ms |
| 3 | `npx tsc --noEmit 2>&1 | grep -c 'error TS'` | 0 | ✅ pass | 30000ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/lib/blueprint/steps/council-review.ts`
- `src/lib/blueprint/steps/council-emit.ts`
- `src/lib/blueprint/council-reviewer.ts`
- `src/__tests__/lib/blueprint/steps/council-review.test.ts`
- `src/__tests__/lib/blueprint/steps/council-emit.test.ts`
