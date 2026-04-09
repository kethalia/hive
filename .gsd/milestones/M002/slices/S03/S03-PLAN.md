# S03: Aggregation & PR Comment

**Goal:** Aggregation logic groups reviewer findings by file+line with ≥2 consensus, formatted markdown comment posts to PR via gh CLI, and CouncilReport persists to task record — all wired into the pipeline as step 13 after verifier.
**Demo:** Given 3 mock reviewer outputs with overlapping findings at the same file+line, aggregation correctly populates consensusItems; formatted Markdown comment body includes severity sections; task.councilReport has all required fields.

## Must-Haves

- Given 3 mock reviewer outputs with overlapping findings at the same file+line, aggregation correctly populates consensusItems; formatted Markdown comment body includes severity sections; task.councilReport has all required fields.

## Proof Level

- This slice proves: This slice proves: integration. Real runtime required: no (unit + mock tests). Human/UAT required: no.

## Integration Closure

Upstream surfaces consumed: `src/lib/council/types.ts` (ReviewerFinding, AggregatedFinding, CouncilReport, isCouncilReport), `src/lib/queue/council-queues.ts` (queue singletons, FlowProducer, worker factories, job data interfaces), `src/lib/blueprint/council-reviewer.ts` (createCouncilReviewerBlueprint), `src/lib/blueprint/types.ts` (BlueprintContext), `src/lib/queue/task-queue.ts` (existing pipeline steps 1-12), `src/lib/workspace/naming.ts` (councilWorkspaceName), `src/lib/workspace/exec.ts` (execInWorkspace for reviewer processor), `src/lib/coder/client.ts` (CoderClient for workspace creation). New wiring introduced: council step in task-queue.ts pipeline (step 13), real processor functions wired into council worker factories. What remains: S04 adds dashboard UI (CouncilResultCard, councilSize form field).

## Verification

- Runtime signals: [council-aggregator] and [council-reviewer] log prefixes for job lifecycle; aggregator logs outcome, finding counts, and comment post result. Inspection surfaces: task.councilReport Json column queryable via Prisma; PR comment visible on GitHub. Failure visibility: councilReport.outcome distinguishes complete/partial/inconclusive; postedCommentUrl=null when comment post fails; failed reviewer jobs visible via BullMQ job status.

## Tasks

- [x] **T01: Implement pure aggregation, formatter, and comment helper with unit tests** `est:45m`
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
  - Files: `src/lib/council/aggregator.ts`, `src/lib/council/formatter.ts`, `src/lib/council/comment.ts`, `src/__tests__/lib/council/aggregator.test.ts`, `src/__tests__/lib/council/formatter.test.ts`, `src/__tests__/lib/council/comment.test.ts`
  - Verify: npx vitest run src/__tests__/lib/council/aggregator.test.ts src/__tests__/lib/council/formatter.test.ts src/__tests__/lib/council/comment.test.ts

- [x] **T02: Implement reviewer and aggregator BullMQ processors with tests** `est:60m`
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
  - Files: `src/lib/council/reviewer-processor.ts`, `src/lib/council/aggregator-processor.ts`, `src/__tests__/lib/council/reviewer-processor.test.ts`, `src/__tests__/lib/council/aggregator-processor.test.ts`
  - Verify: npx vitest run src/__tests__/lib/council/reviewer-processor.test.ts src/__tests__/lib/council/aggregator-processor.test.ts

- [x] **T03: Wire council step into task-queue pipeline and verify full suite** `est:45m`
  Add the council step (step 13) to task-queue.ts after the verifier block, update council worker factories to use real processors, and write an integration test.

## Description

This is the integration task that makes the council actually run. It adds a council block to task-queue.ts that (1) reads councilSize from the task, (2) guards on prUrl + councilSize > 0 + CODER_COUNCIL_TEMPLATE_ID being set, (3) uses FlowProducer to atomically fan out N reviewer child jobs + 1 aggregator parent job, and (4) awaits the aggregator job completion via QueueEvents.waitUntilFinished(). It also updates the worker factories or adds new wired-worker functions so that startup code uses real processors instead of skeleton handlers.

## Steps

1. Modify `src/lib/queue/task-queue.ts` — add council block after verifier:
   - After the verifier block resolves (all paths that set status to "done"), add step 13
   - Read `councilTemplateId` from env `CODER_COUNCIL_TEMPLATE_ID`
   - Guard: skip if `!ctx.prUrl || !councilTemplateId` — council requires a PR
   - Read `councilSize` from the task record: `const task = await db.task.findUnique({ where: { id: taskId }, select: { councilSize: true } })`
   - Guard: skip if `councilSize === 0` or `councilSize === null`
   - Import `getCouncilFlowProducer` from council-queues
   - Import `QueueEvents` from bullmq
   - Import `COUNCIL_AGGREGATOR_QUEUE, COUNCIL_REVIEWER_QUEUE, COUNCIL_JOB_TIMEOUT_MS` from constants
   - Build FlowProducer.add() call: parent = aggregator job with `{ taskId, councilSize, prUrl }`, children = N reviewer jobs each with `{ taskId, reviewerIndex, prUrl, repoUrl, branchName }`
   - Set `opts: { failParentOnFailure: false }` on each child (so aggregator runs even if some reviewers fail — this is BullMQ's continueParentOnFailure equivalent)
   - After flow.add() returns, get the parent job reference
   - Create scoped `QueueEvents` for COUNCIL_AGGREGATOR_QUEUE
   - Await `parentJob.waitUntilFinished(queueEvents, COUNCIL_JOB_TIMEOUT_MS)`
   - Close QueueEvents in finally block
   - Wrap entire council block in try/catch — council failure is informational (D015), log and continue

2. Update worker factories in `src/lib/queue/council-queues.ts`:
   - Change `createCouncilReviewerWorker()` signature to accept `coderClient: CoderClient`
   - Replace skeleton processor with `createCouncilReviewerProcessor(coderClient)` from reviewer-processor.ts
   - Change `createCouncilAggregatorWorker()` to use `createCouncilAggregatorProcessor()` from aggregator-processor.ts
   - Keep the existing function names so existing test mocks still work (tests mock the module)

3. Create `src/__tests__/lib/queue/council-step.test.ts`:
   - Test: council step fires FlowProducer.add() with correct parent + children structure when prUrl exists and councilSize > 0
   - Test: council step is no-op when prUrl is null
   - Test: council step is no-op when CODER_COUNCIL_TEMPLATE_ID not set
   - Test: council step is no-op when councilSize is 0
   - Test: council failure doesn't change task status (stays "done")
   - Mock FlowProducer, QueueEvents, db

4. Run full test suite to confirm zero regressions:
   - `npx vitest run` — all 205+ tests must pass
   - `npx tsc --noEmit` — no net new TypeScript errors

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| FlowProducer.add() | Catch, log, skip council — task stays done | BullMQ connection timeout | N/A |
| QueueEvents.waitUntilFinished() | Catch, log, skip — aggregator may still complete async | COUNCIL_JOB_TIMEOUT_MS enforced | N/A |
| db.task.findUnique (councilSize) | Catch, log, skip council | Standard Prisma timeout | N/A |

## Must-Haves

- [ ] Council step fires FlowProducer with correct N children + 1 parent
- [ ] Council step is no-op when prUrl missing, councilSize=0, or template not configured
- [ ] Council failure is caught and doesn't affect task status (D015)
- [ ] Worker factories use real processors
- [ ] Full test suite passes with zero regressions
- [ ] No net new TypeScript errors
  - Files: `src/lib/queue/task-queue.ts`, `src/lib/queue/council-queues.ts`, `src/__tests__/lib/queue/council-step.test.ts`
  - Verify: npx vitest run && npx tsc --noEmit 2>&1 | grep -c 'error TS' | xargs -I{} test {} -le 23

## Files Likely Touched

- src/lib/council/aggregator.ts
- src/lib/council/formatter.ts
- src/lib/council/comment.ts
- src/__tests__/lib/council/aggregator.test.ts
- src/__tests__/lib/council/formatter.test.ts
- src/__tests__/lib/council/comment.test.ts
- src/lib/council/reviewer-processor.ts
- src/lib/council/aggregator-processor.ts
- src/__tests__/lib/council/reviewer-processor.test.ts
- src/__tests__/lib/council/aggregator-processor.test.ts
- src/lib/queue/task-queue.ts
- src/lib/queue/council-queues.ts
- src/__tests__/lib/queue/council-step.test.ts
