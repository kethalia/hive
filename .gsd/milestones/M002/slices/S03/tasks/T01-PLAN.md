---
estimated_steps: 51
estimated_files: 6
skills_used: []
---

# T01: Implement pure aggregation, formatter, and comment helper with unit tests

Create three pure/near-pure modules in src/lib/council/ and comprehensive unit tests for each.

## Description

This task builds the core data transformation layer for S03: (1) `aggregator.ts` groups ReviewerFinding[][] by file+startLine and computes consensus, (2) `formatter.ts` renders a CouncilReport into a markdown PR comment string, and (3) `comment.ts` provides a thin gh CLI wrapper for posting comments. All three are independently unit-testable.

## Steps

1. Create `src/lib/council/aggregator.ts`:
   - Export `aggregateFindings(reviewerResults: ReviewerFinding[][], councilSize: number)` returning `{ findings: AggregatedFinding[]; consensusItems: AggregatedFinding[] }`
   - Group by `file + ":" + startLine` key
   - For each group: use first occurrence's body fields (file, startLine, severity, issue, fix, reasoning), set `agreementCount` = number of reviewers that flagged it, set `isConsensus = agreementCount >= 2` (per D013)
   - `consensusItems` = findings where `isConsensus === true`
   - Handle empty input (no reviewers) → empty findings + empty consensusItems
   - Handle all-empty reviewers (each returned []) → same

2. Create `src/lib/council/formatter.ts`:
   - Export `formatCouncilComment(report: CouncilReport): string`
   - Group `consensusItems` by severity (critical → major → minor → nit)
   - Use emoji headers: 🔴 Critical, 🟠 Major, 🟡 Minor, 💬 Nit
   - Each finding shows file:line, issue, fix, reasoning
   - Footer: summary line with total findings, consensus count, reviewers completed / council size
   - Handle empty findings: return a "no issues found" message
   - Pure function, no I/O

3. Create `src/lib/council/comment.ts`:
   - Export `postPRComment(prUrl: string, body: string): Promise<string | null>` returning comment URL or null
   - Use `child_process.execFile` with promisify to call `gh pr comment <prUrl> --body <body>`
   - Timeout: use GH_CMD_TIMEOUT_MS from constants
   - On failure: log error, return null (never throw — comment failure is informational per D015)

4. Create `src/__tests__/lib/council/aggregator.test.ts`:
   - Test: 3 reviewers, 2 flag same file+line → agreementCount=2, isConsensus=true
   - Test: 3 reviewers, 1 flags unique line → agreementCount=1, isConsensus=false
   - Test: empty input (no reviewers) → empty findings
   - Test: all reviewers return empty findings → empty findings
   - Test: severity preserved from first occurrence
   - Test: multiple consensus items across different files

5. Create `src/__tests__/lib/council/formatter.test.ts`:
   - Test: groups consensus items by severity with correct emoji headers
   - Test: includes file:line, issue, fix, reasoning for each finding
   - Test: footer has correct counts
   - Test: empty findings → "no issues found" message
   - Test: single severity section only

6. Create `src/__tests__/lib/council/comment.test.ts`:
   - Mock child_process.execFile
   - Test: successful post returns non-null
   - Test: gh failure returns null (not throw)
   - Test: called with correct args (gh pr comment <url> --body <body>)

## Negative Tests

- **Malformed inputs**: empty ReviewerFinding[][] array, ReviewerFinding[] with zero elements, single reviewer
- **Boundary conditions**: all reviewers flag the same line (agreementCount = councilSize), only one finding total, very long comment body

## Must-Haves

- [ ] aggregateFindings groups by file+startLine and computes correct agreementCount
- [ ] isConsensus = true when agreementCount >= 2 (D013)
- [ ] formatCouncilComment produces valid markdown with severity sections
- [ ] postPRComment never throws on gh failure
- [ ] All unit tests pass

## Inputs

- `src/lib/council/types.ts`
- `src/lib/constants.ts`

## Expected Output

- `src/lib/council/aggregator.ts`
- `src/lib/council/formatter.ts`
- `src/lib/council/comment.ts`
- `src/__tests__/lib/council/aggregator.test.ts`
- `src/__tests__/lib/council/formatter.test.ts`
- `src/__tests__/lib/council/comment.test.ts`

## Verification

npx vitest run src/__tests__/lib/council/aggregator.test.ts src/__tests__/lib/council/formatter.test.ts src/__tests__/lib/council/comment.test.ts
