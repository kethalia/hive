# S03 Research: Aggregation & PR Comment

**Slice:** S03 — Aggregation & PR Comment  
**Milestone:** M002 — Council Review  
**Complexity:** Targeted — aggregation is a pure function over known types; PR comment uses `gh` CLI already present; integration into the existing queue worker follows the same pattern as the verifier step.

---

## Summary

S03 wires together the two skeletal workers built in S01, implements aggregation logic over the `ReviewerFinding[][]` arrays produced by S02 reviewer jobs, posts a formatted markdown comment to the GitHub PR via `gh pr comment`, persists a `CouncilReport` to the task record, and integrates all of this into the existing `task-queue.ts` pipeline as step 10 (council). This is the integration-heavy slice: S01 and S02 gave us all the types, queues, and blueprint steps. S03 makes them run.

---

## Relevant Requirements

- **R017** (validated by S02) — aggregation by file+line, consensus ≥2; S03 implements and proves this.
- **R019** (active) — single combined PR comment; S03 implements `gh pr comment`.
- **R032** (validated by S01) — council failure is informational; S03 enforces: task stays `done` regardless.
- **R034** (active) — FlowProducer fan-out, step 10 in pipeline; S03 implements the council step in task-queue.ts.

---

## Implementation Landscape

### 1. What needs to be created

**`src/lib/council/aggregator.ts`** — Pure aggregation function:
```typescript
aggregateFindings(reviewerResults: ReviewerFinding[][]): {
  findings: AggregatedFinding[];
  consensusItems: AggregatedFinding[];
}
```
- Groups by `file + ":" + startLine` (key)
- Each unique key → one `AggregatedFinding` with `agreementCount` = number of reviewers that flagged it
- `isConsensus = agreementCount >= 2`
- `consensusItems` = findings where `isConsensus === true`
- For the finding body (file, startLine, severity, issue, fix, reasoning): use the first occurrence (reviewer 0's version if available)
- Pure function, no I/O — unit-testable without mocks

**`src/lib/council/formatter.ts`** — Markdown comment formatter:
```typescript
formatCouncilComment(report: CouncilReport): string
```
- Produces a PR comment body
- Groups `consensusItems` by severity (critical → major → minor → nit)
- Uses emoji-prefixed headers (e.g. 🔴 Critical, 🟠 Major, 🟡 Minor, 💬 Nit)
- Shows file:line for each finding, issue, fix, and reasoning
- Footer: summary line (e.g. "Council found N findings across M files; X consensus items from Y reviewers")
- Handles empty findings gracefully (no issues found message)
- Pure function — unit-testable without mocks

**`src/lib/council/reviewer-processor.ts`** — The council reviewer BullMQ job processor:
```typescript
createCouncilReviewerProcessor(coderClient: CoderClient): Processor<CouncilReviewerJobData>
```
- Invoked as the handler in `createCouncilReviewerWorker` (replacing the skeleton `console.log`)
- Creates a Coder workspace (`councilWorkspaceName(taskId, reviewerIndex)`) using `CODER_COUNCIL_TEMPLATE_ID`
- Waits for build, resolves agent name, builds `BlueprintContext`, runs `createCouncilReviewerBlueprint()`
- Returns `ReviewerFinding[]` on success (parsed from council-emit step's message)
- Cleanup in `finally` block (D008 pattern, same as verifier)
- Failure: throws so BullMQ marks job failed → `continueParentOnFailure` fires aggregator

**`src/lib/council/aggregator-processor.ts`** — The council aggregator BullMQ job processor:
```typescript
createCouncilAggregatorProcessor(coderClient: CoderClient): Processor<CouncilAggregatorJobData>
```
- Called after all reviewer children complete (or some fail with `continueParentOnFailure`)
- Retrieves child job results via `job.getChildrenValues()` → returns `Record<string, unknown>` keyed by job key
- Filters out null/undefined (failed reviewers) — these contribute to `completedReviewers` count
- Calls `aggregateFindings(reviewerResults)` → builds `CouncilReport`
- Sets `outcome`: `"complete"` (all reviewers succeeded), `"partial"` (some failed), `"inconclusive"` (all failed)
- Posts PR comment via `gh pr comment <prUrl> --body "..."` using `execFile` or a shell exec (NOT `execInWorkspace` — no workspace needed for this step; OR use a utility function)
- Persists `CouncilReport` to `db.task.update({ where: { id: taskId }, data: { councilReport: report } })`
- Does NOT change task status (task is already `done`)

**`src/lib/council/step.ts`** — The `createCouncilStep()` factory for task-queue.ts:
```typescript
createCouncilStep(coderClient: CoderClient): { name: string; execute(ctx): Promise<StepResult> }
```
- Actually this is **not** a `BlueprintStep` — it runs *outside* the blueprint, inline in `task-queue.ts` like the verifier block currently is
- Guard: no-op if `!task.prUrl` or `task.councilSize === 0`
- Uses `FlowProducer.add()` to atomically enqueue N reviewer child jobs + 1 aggregator parent
- THEN waits for aggregator to complete (poll aggregator job status until `completed` or `failed`)
- Alternatively: the council step can fire-and-forget the FlowProducer and the workers complete asynchronously — but the milestone vision says "aggregator runs; task.councilReport persists" before the pipeline job ends, so it should await
- **NOTE:** The aggregator processor itself persists the report, so the council step in task-queue.ts just needs to fire the flow and wait for the aggregator job to finish

### 2. Key integration point: task-queue.ts

The council block goes after the existing verifier block (which is currently inline, not a separate step function). Looking at `task-queue.ts`:

```
// 12. Trigger verifier if PR was created...
if (ctx.prUrl && verifierTemplateId) { ... }
// After verifier block resolves, add council block:
// 13. Trigger council if PR created and councilSize > 0
```

Need to:
1. Read `task.councilSize` from DB (currently only `councilSize: 3` default — read after step 12 resolves)
2. Get `CODER_COUNCIL_TEMPLATE_ID` from env (same pattern as `CODER_VERIFIER_TEMPLATE_ID`)
3. Create `FlowProducer.add()` with parent (aggregator) + N children (reviewers)
4. Await aggregator job completion (BullMQ `job.waitUntilFinished(queueEvents)` or poll)

**Await mechanism:** BullMQ's `job.waitUntilFinished(queueEvents)` is the clean pattern. Requires a `QueueEvents` instance for the aggregator queue. Alternative: add the aggregator job ID to a queue and poll with `Job.fromId()`. The simplest approach: after `flowProducer.add()` returns the parent job, call `aggregatorJob.waitUntilFinished(new QueueEvents(COUNCIL_AGGREGATOR_QUEUE, { connection }))`.

### 3. gh pr comment invocation

The aggregator processor needs to post a PR comment. Since aggregator runs inside the BullMQ worker process (not inside a Coder workspace), it should use Node.js `execFile('gh', ['pr', 'comment', prUrl, '--body', commentBody])` directly — not `execInWorkspace`. A simple utility or inline `execFile` call suffices.

Pattern from `src/lib/blueprint/steps/ci.ts` uses `execInWorkspace` — but aggregator has no workspace. Use `util.promisify(execFile)` or the existing pattern from `steps/pr.ts`:

```typescript
// steps/pr.ts uses execInWorkspace — can't reuse. Use execFile directly:
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
await execFileAsync('gh', ['pr', 'comment', prUrl, '--body', commentBody], { timeout: GH_CMD_TIMEOUT_MS });
```

Or: create a thin `postPRComment(prUrl: string, body: string): Promise<string>` helper in `src/lib/council/` that returns the comment URL (parsed from `gh` output with `--json url` flag if available, or just use null).

### 4. CouncilReport shape (actual types.ts vs context doc)

The context doc says `count` and `reviewerIndices` but **`types.ts` uses `agreementCount` and `isConsensus`**. Implement to match `types.ts`. The `CouncilReport` also uses `reviewersCompleted` (not `completedReviewers`), `findings` (all deduplicated), and `consensusItems`. The context doc's `reviewers: ReviewerFinding[][]` raw array field is **NOT in types.ts** — the current type doesn't store raw per-reviewer arrays, only aggregated. This is correct for S03.

### 5. BullMQ `job.getChildrenValues()` behavior

Per BullMQ docs, in the parent job processor, `job.getChildrenValues()` returns `Record<string, unknown>` where each key is the child job's unique key (`${queueName}:${jobId}`). Values are the return values of each child processor. Failed children have `null` or no entry. This is the mechanism to collect all reviewer results in the aggregator.

**Crucial**: `createCouncilReviewerWorker` currently has a skeleton processor (`console.log + return {}`). S03 must replace this with the real processor that runs the blueprint and returns `ReviewerFinding[]`.

### 6. Updated worker factories

`council-queues.ts` has skeletal worker factories. S03 updates them to accept a processor parameter OR the real processor is passed at startup time. Looking at how `createTaskWorker(coderClient)` works: it takes `CoderClient` and closes over it. The council worker factories should follow the same pattern — accept `CoderClient` and instantiate the real processor.

**Plan:** Either:
- (a) Add `createCouncilReviewerWorker(coderClient: CoderClient)` overload — but this changes the S01 function signature (breaking tests)
- (b) Create a new `createCouncilReviewerProcessor` function and wire it outside the factory
- (c) Keep the factories, add separate processor-wired versions

Best approach: Keep skeletal factories for tests, create new `createCouncilReviewerWorker(coderClient)` and `createCouncilAggregatorWorker(coderClient)` functions in new files that call the existing queue infrastructure but with real processors. **OR** update the existing factories to accept optional coderClient with default skeleton behavior — but that's messy.

**Simplest:** New files `src/lib/council/reviewer-worker.ts` and `src/lib/council/aggregator-worker.ts` that export functions wiring real processors to the queues. The startup code (wherever workers are initialized) calls these instead of the skeletal factories.

### 7. Where workers are started

Checking the app: workers likely started in a server startup file or API route. Need to verify:

```bash
grep -rn "createTaskWorker\|createCouncilReviewerWorker" src/app --include="*.ts" 2>/dev/null
```

The council workers with real processors need to be registered alongside the task worker.

### 8. Unit test strategy

Per milestone testing requirements:
- **Aggregation unit tests** (pure function): 2/3 → consensus, 1/3 → not, empty input, all-fail, severity preservation
- **Formatter unit tests** (pure function): outputs correct markdown sections, groups by severity, handles empty findings
- **Aggregator processor test**: mock `job.getChildrenValues()`, mock DB, mock `gh pr comment`, verify `CouncilReport` shape
- **Council step integration** in `task-queue.ts`: mock `FlowProducer.add()`, verify correct job data passed, verify council step is no-op when `prUrl` is null
- NO E2E — consistent with milestone testing requirements

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/lib/council/aggregator.ts` | Pure aggregation function |
| `src/lib/council/formatter.ts` | Markdown comment formatter |
| `src/lib/council/comment.ts` | `postPRComment()` helper (gh CLI) |
| `src/lib/council/reviewer-processor.ts` | Reviewer job processor (blueprint runner) |
| `src/lib/council/aggregator-processor.ts` | Aggregator job processor (aggregate + post comment) |
| `src/__tests__/lib/council/aggregator.test.ts` | Pure function tests for aggregation |
| `src/__tests__/lib/council/formatter.test.ts` | Pure function tests for formatting |
| `src/__tests__/lib/council/aggregator-processor.test.ts` | Integration test for aggregator processor |

## Files to Modify

| File | What Changes |
|------|-------------|
| `src/lib/queue/task-queue.ts` | Add council step (step 13) after verifier block; reads `councilSize` from DB, fires FlowProducer, awaits aggregator |
| `src/lib/queue/council-queues.ts` | Optionally update worker factories to accept processors, OR leave as-is and wire processors at startup |

---

## Seams / Task Decomposition

**T01: Pure functions** — `aggregator.ts` + `formatter.ts` + `comment.ts` + all their unit tests. No mocks needed for aggregator/formatter. Comment helper needs `execFile` mock. Completely self-contained. Verifiable by `vitest run`.

**T02: Processor implementations** — `reviewer-processor.ts` + `aggregator-processor.ts`. Reviewers run the blueprint (mock CoderClient + runBlueprint in tests). Aggregator mock `job.getChildrenValues()` + DB + comment helper.

**T03: Pipeline wiring** — Modify `task-queue.ts` to add council step after verifier. Update worker startup to use real processors. Integration-level test to verify council step fires FlowProducer with correct data. Verify no-op guard for missing prUrl.

---

## Risk Notes

- **`job.getChildrenValues()` typing** — BullMQ returns `Record<string, unknown>` and callers must cast. Failed children return `undefined` entries. Validate each entry with `Array.isArray` before treating as `ReviewerFinding[]`.
- **`AggregatedFinding.isConsensus` boolean flag** — The aggregation must compute majority relative to `councilSize`, not just `>= 2`. Wait — types.ts says `isConsensus: boolean` but doesn't document the threshold. Context doc says "≥2 = consensus". Since `councilSize` is known at aggregation time, the threshold is `agreementCount >= 2` (absolute, not majority). This matches D013.
- **Awaiting aggregator** — Using `QueueEvents` + `waitUntilFinished` requires a QueueEvents instance. Keep it scoped to the council step; close it after the await. Don't add to global singletons.
- **`postedCommentUrl`** — `gh pr comment` doesn't output the comment URL by default. Use `--json url` or accept `null` as documented fallback. Check `gh pr comment --help` or use `gh api` to post and capture URL. The safe default is `null` if URL can't be obtained.
- **Type shape discrepancy** — Context doc mentions `reviewerIndices: number[]` on `AggregatedFinding`, but actual `types.ts` does NOT have this field. Implement to match `types.ts` exactly.

---

## Recommendation

**Implement in three tasks:**

1. **T01 (Pure Functions + Tests):** `aggregator.ts`, `formatter.ts`, `comment.ts`, all tests. Fastest to verify. Establishes the data model S03 will use. ~40 min.

2. **T02 (Processor Implementations + Tests):** `reviewer-processor.ts`, `aggregator-processor.ts`, tests. Depends on T01 types being finalized. ~60 min.

3. **T03 (Pipeline Wiring + Integration Test):** Wire council step into `task-queue.ts`, add `QueueEvents` await, ensure workers are started with real processors. ~40 min.

This decomposition keeps each task independently verifiable and follows the same pattern as S01/S02.
