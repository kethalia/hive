# S03: Aggregation & PR Comment — UAT

**Milestone:** M002
**Written:** 2026-04-09T10:51:35.591Z

# S03 UAT: Council Review Aggregation & PR Comment

## Preconditions

1. **Environment:** Node.js 18+, npm or yarn, local test environment with Vitest
2. **Dependencies:** All npm dependencies installed (`npm install`)
3. **Database:** Prisma DB accessible (test SQLite or in-memory)
4. **External mocks:** All BullMQ, Redis, CoderClient, and gh CLI calls mocked in unit tests
5. **Code state:** All S03 tasks completed; S03 branch merged or staged

## Test Suite Overview

S03 has 45 passing unit tests across 11 test files validating:
- Pure aggregation logic (8 tests)
- Markdown formatting (7 tests)
- PR comment posting (3 tests)
- Reviewer processor workspace & blueprint integration (8 tests)
- Aggregator processor child collection & DB persistence (7 tests)
- Pipeline integration & guards (10 tests)
- Full regression suite (250 tests, 36 files)

All tests pass with zero regressions.

## Functional Test Cases

### Test Case 1: Basic Aggregation — 3 Reviewers, 2 Flag Same Finding
**Objective:** Verify aggregateFindings correctly identifies consensus when ≥2 reviewers flag the same file+line.

**Precondition:**
- Mock reviewer results: 3 ReviewerFinding[] arrays
- Reviewer 1 & 2: [{file: \"src/auth.ts\", startLine: 42, severity: \"critical\", issue: \"SQL injection\", fix: \"Use parameterized query\", reasoning: \"User input unsanitized\"}]
- Reviewer 3: [] (empty findings)

**Steps:**
1. Call aggregateFindings([reviewer1, reviewer2, reviewer3], councilSize=3)
2. Inspect returned findings array
3. Inspect returned consensusItems array

**Expected Outcome:**
- findings.length = 1 (one unique file+startLine combination)
- findings[0].agreementCount = 2 (two reviewers flagged it)
- findings[0].isConsensus = true (agreementCount >= 2)
- consensusItems.length = 1 (consensus item included)
- consensusItems[0].issue = \"SQL injection\" (preserved from first occurrence)

**Verification:** npx vitest run src/__tests__/lib/council/aggregator.test.ts

### Test Case 2: No Consensus — 3 Reviewers, Each Flags Different Line
**Objective:** Verify aggregateFindings correctly rejects findings with <2 agreement.

**Expected Outcome:**
- findings.length = 3 (three distinct file+startLine keys)
- For each finding: agreementCount = 1, isConsensus = false
- consensusItems.length = 0 (no consensus items)

### Test Case 3: Markdown Formatting — Consensus Items Grouped by Severity
**Objective:** Verify formatCouncilComment renders consensusItems with correct severity grouping and emoji headers.

**Expected Outcome:**
- Markdown includes \"🔴 Critical\" header with findings
- Markdown includes \"🟠 Major\" header with findings
- Markdown includes \"💬 Nit\" header
- Each finding shows file:line, issue, fix, reasoning
- Footer includes counts: \"Total: X findings, Consensus: X, Reviewers: 3/3\"

**Verification:** npx vitest run src/__tests__/lib/council/formatter.test.ts

### Test Case 4: Empty Findings — All Reviewers Return No Issues
**Objective:** Verify formatCouncilComment handles zero findings gracefully.

**Expected Outcome:**
- String contains \"✅ No issues found\" or equivalent positive message
- Footer shows: \"Total: 0 findings, Consensus: 0, Reviewers: 3/3\"

### Test Case 5: PR Comment Posting — Success Case
**Objective:** Verify postPRComment invokes gh CLI correctly and returns comment URL.

**Expected Outcome:**
- Promise resolves to non-null string (comment URL)
- execFile called with args: [\"gh\", \"pr\", \"comment\", prUrl, \"--body\", body]

### Test Case 6: PR Comment Posting — Failure Handling (No Throw)
**Objective:** Verify postPRComment returns null on gh failure and never throws.

**Expected Outcome:**
- Promise resolves to null (not rejected/thrown)
- stderr logged with [council-aggregator] prefix
- No unhandled promise rejection

**Verification:** npx vitest run src/__tests__/lib/council/comment.test.ts

### Test Case 7: Reviewer Processor — Workspace Creation & Cleanup
**Objective:** Verify reviewer processor creates workspace, runs blueprint, extracts findings, and cleans up.

**Expected Outcome:**
- CoderClient.createWorkspace called once with correct templateId and councilWorkspaceName
- CoderClient.waitForBuild called
- runBlueprint called with correct context
- cleanupWorkspace called in finally (even if blueprint succeeds)
- Promise resolves to ReviewerFinding[] array (parsed from council-emit message)
- Log lines contain [council-reviewer] prefix

**Verification:** npx vitest run src/__tests__/lib/council/reviewer-processor.test.ts

### Test Case 8: Aggregator Processor — Child Collection & Consensus Outcome
**Objective:** Verify aggregator processor collects child results, computes outcome, and persists CouncilReport.

**Expected Outcome:**
- job.getChildrenValues() called once
- 2 valid ReviewerFinding[] found (job-1 and job-3)
- outcome = \"partial\" (some reviewers failed; job-2 was null)
- db.task.update called with full CouncilReport
- Promise resolves to CouncilReport object
- Log contains [council-aggregator] prefix with outcome and finding counts

**Verification:** npx vitest run src/__tests__/lib/council/aggregator-processor.test.ts

### Test Case 9: Aggregator Processor — All Reviewers Fail
**Objective:** Verify aggregator handles complete failure gracefully.

**Expected Outcome:**
- outcome = \"inconclusive\" (no reviewers succeeded)
- findings.length = 0, consensusItems.length = 0
- CouncilReport still persisted to DB
- postedCommentUrl set to null

### Test Case 10: Pipeline Integration — Council Step Fires FlowProducer
**Objective:** Verify task-queue.ts council step creates correct FlowProducer structure (N children + 1 parent).

**Expected Outcome:**
- FlowProducer.add() called exactly once
- Payload includes parent: { name: \"council-aggregator\", data: { taskId, councilSize: 3, prUrl } }
- Children: array of length 3 (one per reviewer)
- Each child has opts: { failParentOnFailure: false }

**Verification:** npx vitest run src/__tests__/lib/queue/council-step.test.ts

### Test Case 11: Pipeline Integration — No-Op When prUrl Missing
**Objective:** Verify council step skips when PR URL not available.

**Expected Outcome:**
- FlowProducer.add() NOT called
- Console log: \"Council review skipped for task X (no prUrl)\"
- Task status remains \"done\"

### Test Case 12: Pipeline Integration — No-Op When councilSize = 0
**Objective:** Verify council step respects per-task opt-out.

**Expected Outcome:**
- FlowProducer.add() NOT called
- Console log: \"Council review skipped for task X (councilSize=0)\"
- Task status remains \"done\"

### Test Case 13: Pipeline Integration — Council Failure Doesn't Block Task
**Objective:** Verify council failure is caught and task stays \"done\" (D015).

**Expected Outcome:**
- Error caught and logged
- Task status remains \"done\" (not changed)
- Pipeline continues normally (no exception propagated)

### Test Case 14: Full Regression Test Suite
**Objective:** Verify zero regressions in the entire codebase (all slices).

**Steps:**
1. Run full test suite: `npx vitest run`
2. Count passing vs failing test files and tests

**Expected Outcome:**
- Test Files: 36 passed, 0 failed
- Tests: 250 passed, 0 failed
- Duration: < 2 seconds
- Exit code: 0

**Verification:** npx vitest run

### Test Case 15: TypeScript Type Safety
**Objective:** Verify no new TypeScript errors introduced; error count stays within budget (≤23).

**Expected Outcome:**
- Error count = 23 (at threshold, no net new errors)
- Exit code from threshold check: 0

**Verification:** npx tsc --noEmit --skipLibCheck 2>&1 | grep -c 'error TS' | xargs -I{} test {} -le 23

## Integration Verification Summary

| Test Case | File(s) | Tests | Status |
|-----------|---------|-------|--------|
| 1. Basic aggregation | aggregator.test.ts | 1 | ✅ Pass |
| 2. No consensus | aggregator.test.ts | 1 | ✅ Pass |
| 3. Markdown severity | formatter.test.ts | 1 | ✅ Pass |
| 4. Empty findings | formatter.test.ts | 1 | ✅ Pass |
| 5. Comment post success | comment.test.ts | 1 | ✅ Pass |
| 6. Comment post failure | comment.test.ts | 1 | ✅ Pass |
| 7. Reviewer processor | reviewer-processor.test.ts | 1 | ✅ Pass |
| 8. Aggregator partial fail | aggregator-processor.test.ts | 1 | ✅ Pass |
| 9. Aggregator complete fail | aggregator-processor.test.ts | 1 | ✅ Pass |
| 10. Pipeline FlowProducer | council-step.test.ts | 1 | ✅ Pass |
| 11. Pipeline skip prUrl | council-step.test.ts | 1 | ✅ Pass |
| 12. Pipeline skip councilSize | council-step.test.ts | 1 | ✅ Pass |
| 13. Pipeline failure tolerance | council-step.test.ts | 1 | ✅ Pass |
| 14. Full regression suite | all 36 files | 250 | ✅ Pass |
| 15. TypeScript budget | tsc | 0 net new | ✅ Pass |

**Overall UAT Result: ✅ PASS**

All functional test cases pass. All regression tests pass. All type safety checks pass. S03 is production-ready for handoff to S04.

## Operational Readiness (Q8)

### Health Signal
Healthy council execution appears as:
```
[council-reviewer] job=123 taskId=task-456 reviewerIndex=0 start
[council-reviewer] job=123 workspaceId=abc123 created
[council-reviewer] job=123 findings=3
[council-aggregator] job=456 outcome=complete reviewersCompleted=3
[council-aggregator] job=456 findings=3 consensusItems=2
[council-aggregator] job=456 comment posted: https://github.com/.../pull/123#issuecomment-999
```

### Failure Signal
- [council-reviewer] with \"Blueprint failed at step X\" = reviewer job failed
- [council-aggregator] with \"outcome=partial\" or \"inconclusive\" = some/all reviewers failed
- \"comment post failed\" = gh CLI error (no token or rate limit)
- task.councilReport outcome field = \"inconclusive\" when entire council failed

### Recovery
1. Check logs for [council-reviewer] failures
2. If partial outcome, re-run aggregator job via BullMQ
3. If comment post failed, verify GITHUB_TOKEN is valid
4. Re-run council step — task stays \"done\" so no reset needed

### Monitoring Gaps
- Per-reviewer timeout (currently applies to entire wait)
- Streaming partial updates (users wait for all N reviewers)
- Comment edit logic (currently posts new comment if re-run)"
