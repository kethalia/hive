---
id: T01
parent: S03
milestone: M002
key_files:
  - src/lib/council/aggregator.ts
  - src/lib/council/formatter.ts
  - src/lib/council/comment.ts
  - src/__tests__/lib/council/aggregator.test.ts
  - src/__tests__/lib/council/formatter.test.ts
  - src/__tests__/lib/council/comment.test.ts
key_decisions:
  - aggregateFindings preserves first-occurrence body fields (severity, issue, fix, reasoning) when multiple reviewers flag the same file+startLine
  - councilSize is accepted by aggregateFindings but unused — callers pass it through CouncilReport to the formatter
  - postPRComment logs [council-aggregator] prefix on failure and returns null — never throws (D015)
duration: 
verification_result: passed
completed_at: 2026-04-09T09:26:35.002Z
blocker_discovered: false
---

# T01: Added aggregator, formatter, and gh comment wrapper for the council review pipeline — all 20 unit tests pass.

**Added aggregator, formatter, and gh comment wrapper for the council review pipeline — all 20 unit tests pass.**

## What Happened

Created three pure/near-pure modules under src/lib/council/: aggregator.ts groups ReviewerFinding[][] by file+startLine key with agreementCount and isConsensus>=2 (D013); formatter.ts renders CouncilReport to markdown with severity-ordered sections (🔴/🟠/🟡/💬) and footer counts; comment.ts wraps gh CLI via util.promisify(execFile) with GH_CMD_TIMEOUT_MS, returning null on any failure without throwing (D015). Wrote 20 unit tests covering happy paths, edge cases, negative inputs, and the non-throwing error path for the comment helper.

## Verification

Ran npx vitest run on all three test files: 3 test files, 20 tests — all passed in 174ms. The console.error output during the gh failure test is intentional and confirms the non-throwing error path is exercised.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/council/aggregator.test.ts src/__tests__/lib/council/formatter.test.ts src/__tests__/lib/council/comment.test.ts` | 0 | ✅ pass | 174ms |

## Deviations

councilSize parameter renamed to _councilSize in aggregator.ts to make its intentional non-use explicit; no behavioral change.

## Known Issues

None.

## Files Created/Modified

- `src/lib/council/aggregator.ts`
- `src/lib/council/formatter.ts`
- `src/lib/council/comment.ts`
- `src/__tests__/lib/council/aggregator.test.ts`
- `src/__tests__/lib/council/formatter.test.ts`
- `src/__tests__/lib/council/comment.test.ts`
