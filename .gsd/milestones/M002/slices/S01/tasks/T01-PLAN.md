---
estimated_steps: 45
estimated_files: 5
skills_used: []
---

# T01: Add Prisma columns, council types, constants, naming helper, and BullMQ queue infrastructure

This task lays all the TypeScript and database foundations for the council feature in one pass. It adds councilSize + councilReport to the Prisma schema, creates the council type definitions (ReviewerFinding, AggregatedFinding, CouncilReport), adds queue name constants and timeout, adds the councilWorkspaceName helper, and creates the BullMQ queue infrastructure (two queue singletons, FlowProducer factory, two worker skeletons).

## Steps

1. Edit `prisma/schema.prisma` — add to the Task model:
   ```prisma
   councilSize    Int   @default(3)      @map("council_size")
   councilReport  Json?                  @map("council_report")
   ```
   Place after `verificationReport` line. Then run `npx prisma migrate dev --name add_council_columns` and `npx prisma generate`.

2. Create `src/lib/council/types.ts` with these interfaces:
   - `ReviewerFinding` — `{ file: string; startLine: number; severity: 'critical' | 'major' | 'minor' | 'nit'; issue: string; fix: string; reasoning: string }`
   - `AggregatedFinding` — extends ReviewerFinding with `{ agreementCount: number; isConsensus: boolean }`
   - `CouncilReport` — `{ outcome: 'complete' | 'partial' | 'inconclusive'; councilSize: number; reviewersCompleted: number; findings: AggregatedFinding[]; consensusItems: AggregatedFinding[]; postedCommentUrl: string | null; durationMs: number; timestamp: string }`
   - Type guard `isCouncilReport(v: unknown): v is CouncilReport`

3. Edit `src/lib/constants.ts` — add at the bottom of the Queue section:
   ```typescript
   export const COUNCIL_REVIEWER_QUEUE = "council-reviewer";
   export const COUNCIL_AGGREGATOR_QUEUE = "council-aggregator";
   export const COUNCIL_JOB_TIMEOUT_MS = 15 * 60 * 1_000; // 15 min per reviewer
   ```

4. Edit `src/lib/workspace/naming.ts` — add:
   ```typescript
   export function councilWorkspaceName(taskId: string, reviewerIndex: number): string {
     return `hive-council-${taskId.slice(0, 8)}-${reviewerIndex}`;
   }
   ```

5. Create `src/lib/queue/council-queues.ts`:
   - Import `Queue`, `Worker`, `FlowProducer` from `bullmq`, `getRedisConnection` from `./connection`
   - Import queue name constants from `@/lib/constants`
   - Define and export `CouncilReviewerJobData` interface: `{ taskId, reviewerIndex, prUrl, repoUrl, branchName }`
   - Define and export `CouncilAggregatorJobData` interface: `{ taskId, councilSize, prUrl }`
   - Lazy singleton `getCouncilReviewerQueue()` — `new Queue<CouncilReviewerJobData>(COUNCIL_REVIEWER_QUEUE, { connection })`
   - Lazy singleton `getCouncilAggregatorQueue()` — `new Queue<CouncilAggregatorJobData>(COUNCIL_AGGREGATOR_QUEUE, { connection })`
   - Lazy singleton `getCouncilFlowProducer()` — `new FlowProducer({ connection })`
   - `createCouncilReviewerWorker()` — returns `new Worker(COUNCIL_REVIEWER_QUEUE, async (job) => { console.log('[council-reviewer] job received', job.id); return {}; }, { connection, concurrency: 5, lockDuration: COUNCIL_JOB_TIMEOUT_MS })`
   - `createCouncilAggregatorWorker()` — returns `new Worker(COUNCIL_AGGREGATOR_QUEUE, async (job) => { console.log('[council-aggregator] job received', job.id); return {}; }, { connection, concurrency: 3, lockDuration: COUNCIL_JOB_TIMEOUT_MS })`

6. Run `npx tsc --noEmit` to verify everything type-checks.

## Must-Haves
- councilSize Int @default(3) and councilReport Json? columns exist in Task model
- Prisma migration succeeds and client regenerated
- ReviewerFinding, AggregatedFinding, CouncilReport types exported
- isCouncilReport type guard exported
- COUNCIL_REVIEWER_QUEUE, COUNCIL_AGGREGATOR_QUEUE, COUNCIL_JOB_TIMEOUT_MS constants exported
- councilWorkspaceName function exported
- Queue singletons, FlowProducer factory, and worker skeleton factories exported
- `npx tsc --noEmit` passes

## Inputs

- ``prisma/schema.prisma` — existing Task model to extend`
- ``src/lib/constants.ts` — existing constants file to append to`
- ``src/lib/workspace/naming.ts` — existing naming helpers to extend`
- ``src/lib/queue/connection.ts` — getRedisConnection singleton to import`
- ``src/lib/verification/report.ts` — pattern reference for type guard and report interface`

## Expected Output

- ``prisma/schema.prisma` — Task model with councilSize and councilReport columns`
- ``prisma/migrations/*_add_council_columns/migration.sql` — generated migration`
- ``src/lib/council/types.ts` — ReviewerFinding, AggregatedFinding, CouncilReport, isCouncilReport`
- ``src/lib/constants.ts` — COUNCIL_REVIEWER_QUEUE, COUNCIL_AGGREGATOR_QUEUE, COUNCIL_JOB_TIMEOUT_MS added`
- ``src/lib/workspace/naming.ts` — councilWorkspaceName function added`
- ``src/lib/queue/council-queues.ts` — queue singletons, FlowProducer, worker skeletons`

## Verification

npx prisma migrate dev --name add_council_columns && npx tsc --noEmit
