---
estimated_steps: 22
estimated_files: 1
skills_used: []
---

# T03: Add unit tests for council queue infrastructure and verify full suite passes

Write unit tests for the council queue singletons, FlowProducer factory, and worker skeletons. Follow the exact mock pattern from `src/__tests__/lib/queue/worker.test.ts`. Then run the full test suite to confirm nothing is broken.

## Steps

1. Create `src/__tests__/lib/queue/council-queues.test.ts` following the mock pattern from `worker.test.ts`:
   - Mock `ioredis` with default export returning `{ status: 'ready', disconnect: vi.fn(), quit: vi.fn() }`
   - Mock `@/lib/queue/connection` with `getRedisConnection` returning the mock
   - Mock `bullmq` with `Queue`, `Worker`, and `FlowProducer` constructors (vi.fn().mockImplementation)
   - Import the functions under test from `@/lib/queue/council-queues`

2. Write these test cases:
   - `getCouncilReviewerQueue()` — returns a Queue constructed with name 'council-reviewer' and connection option
   - `getCouncilAggregatorQueue()` — returns a Queue constructed with name 'council-aggregator' and connection option
   - `getCouncilFlowProducer()` — returns a FlowProducer constructed with connection option
   - `getCouncilReviewerQueue()` is a singleton — calling twice returns same instance
   - `getCouncilAggregatorQueue()` is a singleton — calling twice returns same instance
   - `getCouncilFlowProducer()` is a singleton — calling twice returns same instance
   - `createCouncilReviewerWorker()` — Worker constructed with 'council-reviewer' queue name
   - `createCouncilAggregatorWorker()` — Worker constructed with 'council-aggregator' queue name

3. Run `npx vitest run src/__tests__/lib/queue/council-queues.test.ts` — all tests pass.

4. Run `npx vitest run` — full test suite passes (existing tests unbroken).

## Must-Haves
- All 8 test cases pass
- Mock pattern matches existing worker.test.ts conventions
- Full test suite passes with no regressions

## Inputs

- ``src/lib/queue/council-queues.ts` — module under test (from T01)`
- ``src/lib/constants.ts` — queue name constants (from T01)`
- ``src/__tests__/lib/queue/worker.test.ts` — mock pattern reference`

## Expected Output

- ``src/__tests__/lib/queue/council-queues.test.ts` — unit tests for council queue infrastructure`

## Verification

npx vitest run src/__tests__/lib/queue/council-queues.test.ts && npx vitest run
