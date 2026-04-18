---
estimated_steps: 29
estimated_files: 6
skills_used: []
---

# T03: Rewire BullMQ task and council workers to resolve per-user credentials per-job

Update task creation to accept userId and store it on the Task record (R095). Rewire task worker and council worker to resolve the submitting user's decrypted API key per-job instead of using injected shared CoderClient (R094). Propagate userId through the council dispatch chain.

Steps:
1. In `src/lib/api/tasks.ts`: add `userId: string` parameter to `createTask()`. Store userId on the Task record insert. Include `userId` in the TaskJobData enqueued to BullMQ.
2. In `src/lib/queue/task-queue.ts`: add `userId: string` to the `TaskJobData` interface. Change `createTaskWorker(coderClient: CoderClient)` signature to `createTaskWorker()` (no parameter). Inside the processor, resolve credentials per-job: `const coderClient = await getCoderClientForUser(job.data.userId)`. Update all internal uses of `coderClient` — it's now resolved inside the processor, not injected.
3. Update the `cleanupWorkspace` helper call to use the per-job coderClient.
4. In `src/lib/council/dispatch.ts`: update `CouncilDispatchParams` to include `userId: string`. Pass userId through to `CouncilReviewerJobData` when dispatching reviewer jobs.
5. In `src/lib/queue/council-queues.ts`: add `userId: string` to `CouncilReviewerJobData`. Change `createCouncilReviewerWorker(coderClient: CoderClient)` to `createCouncilReviewerWorker()`. Resolve credentials per-job via `getCoderClientForUser(job.data.userId)`.
6. In `src/lib/queue/task-queue.ts`: update the `dispatchCouncilReview()` call inside the task worker processor to pass `userId: job.data.userId`.
7. Update callers of `createTask()` to pass userId — search for `createTask(` usage across the codebase. The primary caller is likely a server action that should get userId from `ctx.user.id`.
8. If `src/instrumentation.ts` calls `createTaskWorker(coderClient)`, update it to `createTaskWorker()` (no argument). Currently only template push worker is started there.
9. Write/update tests: mock getCoderClientForUser in worker tests, verify userId flows from createTask → job data → worker → council dispatch → council worker.

Must-haves:
- [ ] createTask accepts userId and stores it on Task record
- [ ] TaskJobData includes userId
- [ ] Task worker resolves CoderClient per-job via getCoderClientForUser
- [ ] Task worker signature changed to createTaskWorker() (no coderClient param)
- [ ] CouncilReviewerJobData includes userId
- [ ] Council reviewer worker resolves CoderClient per-job
- [ ] userId propagated through dispatch chain: createTask → TaskJobData → worker → dispatchCouncilReview → CouncilReviewerJobData → council worker
- [ ] Tests verify per-job credential resolution

Failure Modes:
| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| getCoderClientForUser (in worker) | Job fails, task status set to 'error', errorMessage describes token issue | Prisma timeout → job retry | N/A |
| Prisma (Task insert with userId) | createTask throws, caller handles | Default Prisma timeout | N/A |

Negative Tests:
- Job with userId that has no CoderToken → job fails with clear error about re-authentication
- Job with userId that doesn't exist → job fails with USER_NOT_FOUND
- Null userId on legacy tasks → worker handles gracefully (skip or fail with message)

## Inputs

- ``src/lib/coder/user-client.ts` — getCoderClientForUser factory from T01`
- ``src/lib/api/tasks.ts` — existing createTask function`
- ``src/lib/queue/task-queue.ts` — existing task worker with CoderClient injection`
- ``src/lib/queue/council-queues.ts` — existing council worker with CoderClient injection`
- ``src/lib/council/dispatch.ts` — existing council dispatch`
- ``prisma/schema.prisma` — Task model with userId FK from T01`

## Expected Output

- ``src/lib/api/tasks.ts` — createTask accepting userId parameter`
- ``src/lib/queue/task-queue.ts` — task worker with per-job credential resolution`
- ``src/lib/queue/council-queues.ts` — council worker with per-job credential resolution`
- ``src/lib/council/dispatch.ts` — dispatch propagating userId`
- ``src/__tests__/queue/task-queue.test.ts` — worker tests with mocked getCoderClientForUser`
- ``src/__tests__/queue/council-queues.test.ts` — council worker tests`

## Verification

pnpm vitest run src/__tests__/queue/ && rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/queue/ src/lib/api/tasks.ts src/lib/council/dispatch.ts | grep -v test; test $? -eq 1
