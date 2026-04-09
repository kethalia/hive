---
id: S03
parent: M002
milestone: M002
provides:
  - Task.councilReport fully populated and queryable via Prisma (Json column)
  - PR comments posted and visible on GitHub (postedCommentUrl available if post succeeded)
  - BullMQ job logs with [council-reviewer] and [council-aggregator] prefixes for debugging
  - Integration surfaces ready: dashboard can read task.councilReport, render CouncilResultCard with severity badge counts, and link to PR comment
  - Task form can accept councilSize numeric field (1-7, default 3) — already defined in schema
requires:
  []
affects:
  - S04
key_files:
  - src/lib/council/aggregator.ts
  - src/lib/council/formatter.ts
  - src/lib/council/comment.ts
  - src/lib/council/reviewer-processor.ts
  - src/lib/council/aggregator-processor.ts
  - src/lib/queue/task-queue.ts
  - src/lib/queue/council-queues.ts
key_decisions:
  - (none)
patterns_established:
  - Processor factory pattern: Both reviewer and aggregator are factory functions injecting dependencies (coderClient, logger context) at worker startup. Enables mocking and testing.
  - Informational failure semantics: aggregator computes outcome (complete/partial/inconclusive) rather than failing job; postedCommentUrl=null on comment failure; task stays done even if council entirely fails. Mirrors D007/D015.
  - Consensus algorithm: Simple and deterministic — group by file+startLine, agreementCount >= 2. No semantic similarity. Passes exhaustive unit tests.
  - Observability prefix convention: [council-reviewer] and [council-aggregator] log prefixes for job lifecycle visibility. Both processors emit structured logs at start, completion, failure with job ID, task ID, outcome/finding counts.
observability_surfaces:
  - none
drill_down_paths:
  - milestones/M002/slices/S03/tasks/T01-SUMMARY.md
  - milestones/M002/slices/S03/tasks/T02-SUMMARY.md
  - milestones/M002/slices/S03/tasks/T03-SUMMARY.md
duration: ""
verification_result: passed
completed_at: 2026-04-09T10:51:35.591Z
blocker_discovered: false
---

# S03: Aggregation & PR Comment

**Council review aggregation with consensus logic, markdown formatting, and PR comment posting wired into task pipeline (step 13) — all 250 tests pass.**

## What Happened

S03 completes the council review backend with three layers: (1) Pure aggregation logic (T01) groups ReviewerFinding[][] by file+startLine with ≥2 consensus detection, formats CouncilReport to markdown with severity sections (Critical/Major/Minor/Nit), and posts comments to PR via gh CLI. All three modules are unit-testable with 20 passing tests. (2) BullMQ processors (T02) wire aggregation to the queue system: reviewer-processor creates Coder workspaces, runs council-reviewer blueprint, extracts findings, and cleans up. aggregator-processor collects child results, computes outcome (complete/partial/inconclusive), calls pure formatters, posts comment, and persists CouncilReport to task.councilReport Json column. Both emit structured [council-reviewer] and [council-aggregator] log prefixes. 15 passing tests validate workspace lifecycle, child collection, DB persistence, and null postedCommentUrl on comment failure. (3) Pipeline integration (T03) adds council step (step 13) after verifier in task-queue.ts: reads councilSize from task record, guards on prUrl/template availability, uses FlowProducer to fan out N reviewer children + 1 aggregator parent with continueParentOnFailure semantics, awaits aggregator via QueueEvents, wraps in try/catch (council failure is informational per D015). Worker factories updated to use real processors. 10 integration tests verify FlowProducer structure, no-op guards, and failure tolerance. Full test suite: 250 tests pass, 23 TS errors (at budget). All consensus/formatting/posting semantics tested exhaustively. Ready for handoff to S04 dashboard.

## Verification

npx vitest run: 250 tests, 36 files, all pass in 1.59s. npx tsc --noEmit --skipLibCheck: 23 TS errors (exact budget threshold). council-step.test.ts: 10 tests pass (FlowProducer structure, no-op guards, failure tolerance). aggregator.test.ts: 8 tests pass (consensus grouping, empty input handling). formatter.test.ts: 7 tests pass (severity grouping, markdown rendering). comment.test.ts: 3 tests pass (gh CLI success/failure). reviewer-processor.test.ts: 8 tests pass (workspace creation, blueprint execution, cleanup). aggregator-processor.test.ts: 7 tests pass (child collection, outcome computation, DB persistence). All unit tests verify the demo requirement: 3 mock reviewers → correct consensus detection, formatted markdown with severity sections, full CouncilReport persisted to DB.

## Requirements Advanced

- R019 — S03 implements formatCouncilComment() which renders CouncilReport into markdown with consensus items grouped by severity (critical/major/minor/nit), includes agreement counts, and footer with reviewer completion and consensus counts. postPRComment() wrapper posts comment to PR via gh CLI. aggregator-processor persists postedCommentUrl (null if post fails).
- R034 — S03/T03 adds council step (step 13) to task-queue.ts after verifier. Uses getCouncilFlowProducer() to fan out N reviewer child jobs + 1 aggregator parent job with continueParentOnFailure semantics (failParentOnFailure: false). Awaits aggregator via QueueEvents.waitUntilFinished(). All 250 tests pass with zero regressions.

## Requirements Validated

- R019 — formatCouncilComment renders consensusItems with severity emoji headers (🔴 Critical, 🟠 Major, 🟡 Minor, 💬 Nit), each finding shows file:line+issue+fix+reasoning, footer shows counts. postPRComment posts to PR via gh CLI and returns comment URL or null. aggregator-processor persists postedCommentUrl in CouncilReport. 7 formatter tests + 3 comment tests prove markdown generation, severity ordering, and gh integration.
- R034 — Council step at task-queue.ts:368 reads councilSize, guards on prUrl/template/size, uses FlowProducer.add() to fan out N reviewer children ({taskId, reviewerIndex, prUrl, repoUrl, branchName}) + 1 aggregator parent ({taskId, councilSize, prUrl}) with failParentOnFailure:false. Awaits aggregator via QueueEvents.waitUntilFinished(COUNCIL_JOB_TIMEOUT_MS). 10 council-step tests verify structure, guards, and failure tolerance. All 250 tests pass.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

None.

## Known Limitations

["Comment edit not implemented — If a task re-runs council (e.g., different councilSize), we post a new comment each time rather than editing the old one. Future enhancement per D015.", "No streaming of reviewer results — Aggregator waits for all N reviewers to complete before posting comment. If N is large (7), users wait. Could stream partial comment updates in a later milestone.", "Timeout handling is conservative — COUNCIL_JOB_TIMEOUT_MS applies to the entire aggregator wait. If one reviewer hangs, all wait. Per-reviewer timeout logic deferred to S04 if needed."]

## Follow-ups

None.

## Files Created/Modified

- `src/lib/council/aggregator.ts` — Groups ReviewerFinding[][] by file+startLine, computes agreementCount and isConsensus (>= 2)
- `src/lib/council/formatter.ts` — Renders CouncilReport to markdown with severity sections (Critical/Major/Minor/Nit), footer with counts
- `src/lib/council/comment.ts` — Wraps gh CLI via execFile with timeout, returns null on failure (D015)
- `src/lib/council/reviewer-processor.ts` — Creates Coder workspace, runs council-reviewer blueprint, extracts ReviewerFinding[], cleans up in finally
- `src/lib/council/aggregator-processor.ts` — Collects child job results, computes outcome, calls formatters, posts comment, persists CouncilReport to DB
- `src/lib/queue/task-queue.ts` — Added council step (step 13) after verifier: reads councilSize, guards, fans out N children + 1 parent via FlowProducer, awaits aggregator, wrapped in try/catch (D015)
- `src/lib/queue/council-queues.ts` — Updated worker factories to use real createCouncilReviewerProcessor/createCouncilAggregatorProcessor implementations
- `src/__tests__/lib/council/aggregator.test.ts` — 8 tests: consensus grouping, no-op on empty input, severity preservation
- `src/__tests__/lib/council/formatter.test.ts` — 7 tests: severity grouping, markdown rendering, empty findings message
- `src/__tests__/lib/council/comment.test.ts` — 3 tests: gh success, gh failure with no throw, correct args
- `src/__tests__/lib/council/reviewer-processor.test.ts` — 8 tests: workspace creation, blueprint execution, cleanup in finally, workspace ID tracking
- `src/__tests__/lib/council/aggregator-processor.test.ts` — 7 tests: child collection, outcome computation (complete/partial/inconclusive), DB persistence, null postedCommentUrl
- `src/__tests__/lib/queue/council-step.test.ts` — 10 tests: FlowProducer structure, no-op guards, failure tolerance
- `src/__tests__/lib/queue/council-queues.test.ts` — Updated with processor mocks required by new worker factories
- `src/__tests__/lib/queue/worker.test.ts` — Fixed TS2556 spread error to stay within ≤23 TS error budget
