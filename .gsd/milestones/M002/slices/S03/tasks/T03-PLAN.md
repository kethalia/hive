---
estimated_steps: 48
estimated_files: 3
skills_used: []
---

# T03: Wire council step into task-queue pipeline and verify full suite

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

## Inputs

- `src/lib/council/reviewer-processor.ts`
- `src/lib/council/aggregator-processor.ts`
- `src/lib/council/aggregator.ts`
- `src/lib/council/formatter.ts`
- `src/lib/council/comment.ts`
- `src/lib/council/types.ts`
- `src/lib/queue/council-queues.ts`
- `src/lib/queue/task-queue.ts`
- `src/lib/constants.ts`
- `src/lib/workspace/naming.ts`

## Expected Output

- `src/lib/queue/task-queue.ts`
- `src/lib/queue/council-queues.ts`
- `src/__tests__/lib/queue/council-step.test.ts`

## Verification

npx vitest run && npx tsc --noEmit 2>&1 | grep -c 'error TS' | xargs -I{} test {} -le 23
