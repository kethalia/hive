---
estimated_steps: 55
estimated_files: 4
skills_used: []
---

# T02: Implement reviewer and aggregator BullMQ processors with tests

Create the real BullMQ job processors that replace the skeleton console.log handlers in council-queues.ts.

## Description

Two processor functions: (1) reviewer-processor creates a Coder workspace, runs the council-reviewer blueprint, and returns ReviewerFinding[], (2) aggregator-processor collects child job results via job.getChildrenValues(), calls aggregateFindings(), posts the PR comment, and persists the CouncilReport to the DB. The aggregator processor is the integration point that ties T01's pure functions to BullMQ's fan-in mechanism.

## Steps

1. Create `src/lib/council/reviewer-processor.ts`:
   - Export `createCouncilReviewerProcessor(coderClient: CoderClient): (job: Job<CouncilReviewerJobData>) => Promise<ReviewerFinding[]>`
   - Create workspace using `coderClient.createWorkspace(councilTemplateId, councilWorkspaceName(taskId, reviewerIndex), { task_id, repo_url, branch_name })`
   - Wait for build via `coderClient.waitForBuild()`
   - Resolve agent name via `coderClient.getWorkspaceAgentName()`
   - Build BlueprintContext with council-specific fields
   - Run `createCouncilReviewerBlueprint()` steps via `runBlueprint()`
   - Parse findings from the council-emit step's message field (last successful step with JSON payload)
   - Return parsed `ReviewerFinding[]`
   - Cleanup workspace in `finally` block using `cleanupWorkspace()` (D008 pattern)
   - Read `CODER_COUNCIL_TEMPLATE_ID` from env

2. Create `src/lib/council/aggregator-processor.ts`:
   - Export `createCouncilAggregatorProcessor(): (job: Job<CouncilAggregatorJobData>) => Promise<CouncilReport>`
   - Call `job.getChildrenValues()` → `Record<string, unknown>`
   - Filter entries: validate each value with `Array.isArray()` before treating as `ReviewerFinding[]`
   - Count `reviewersCompleted` = number of valid arrays
   - Compute `outcome`: all succeeded → "complete", some failed → "partial", none succeeded → "inconclusive"
   - Call `aggregateFindings(validResults, job.data.councilSize)` from T01
   - Call `formatCouncilComment(report)` from T01
   - Call `postPRComment(job.data.prUrl, commentBody)` from T01
   - Build full `CouncilReport` object with timing, timestamp, postedCommentUrl
   - Persist to DB: `db.task.update({ where: { id: taskId }, data: { councilReport: report } })`
   - Return the CouncilReport

3. Create `src/__tests__/lib/council/aggregator-processor.test.ts`:
   - Mock job.getChildrenValues() returning mixed valid/null entries
   - Mock getDb() for Prisma task.update
   - Mock postPRComment
   - Test: all reviewers succeed → outcome "complete", correct aggregation
   - Test: some reviewers fail (null entries) → outcome "partial"
   - Test: all reviewers fail → outcome "inconclusive", empty findings
   - Test: CouncilReport persisted to DB with correct shape
   - Test: postPRComment called with formatted body

4. Create `src/__tests__/lib/council/reviewer-processor.test.ts`:
   - Mock CoderClient (createWorkspace, waitForBuild, getWorkspaceAgentName)
   - Mock runBlueprint to return success with council-emit step message
   - Mock cleanupWorkspace
   - Test: successful run returns parsed ReviewerFinding[]
   - Test: blueprint failure throws (so BullMQ marks job failed)
   - Test: workspace cleanup runs even on failure (finally block)

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| job.getChildrenValues() | Failed children return undefined — filtered out, counted as failed reviewers | N/A (in-memory) | Validate with Array.isArray before casting |
| postPRComment | Returns null — postedCommentUrl set to null, report still persisted | gh timeout handled internally, returns null | N/A |
| db.task.update | Log error, re-throw — aggregator job fails but councilReport may be lost | BullMQ lockDuration handles | N/A |

## Must-Haves

- [ ] Reviewer processor runs blueprint and returns ReviewerFinding[]
- [ ] Reviewer processor cleans up workspace in finally block
- [ ] Aggregator processor collects child results and handles failed reviewers
- [ ] Aggregator processor persists CouncilReport to DB
- [ ] All unit tests pass

## Inputs

- `src/lib/council/aggregator.ts`
- `src/lib/council/formatter.ts`
- `src/lib/council/comment.ts`
- `src/lib/council/types.ts`
- `src/lib/queue/council-queues.ts`
- `src/lib/blueprint/council-reviewer.ts`
- `src/lib/blueprint/runner.ts`
- `src/lib/blueprint/types.ts`
- `src/lib/coder/client.ts`
- `src/lib/workspace/naming.ts`
- `src/lib/workspace/cleanup.ts`
- `src/lib/workspace/exec.ts`
- `src/lib/constants.ts`
- `src/lib/db.ts`

## Expected Output

- `src/lib/council/reviewer-processor.ts`
- `src/lib/council/aggregator-processor.ts`
- `src/__tests__/lib/council/reviewer-processor.test.ts`
- `src/__tests__/lib/council/aggregator-processor.test.ts`

## Verification

npx vitest run src/__tests__/lib/council/reviewer-processor.test.ts src/__tests__/lib/council/aggregator-processor.test.ts
