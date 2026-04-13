---
id: T01
parent: S02
milestone: M004
key_files:
  - src/lib/templates/push-queue.ts
  - src/__tests__/lib/templates/push-queue.test.ts
  - src/lib/queue/index.ts
key_decisions:
  - Used real Writable stream in test mock (not plain object) because child_process.pipe() requires stream.on() method
duration: 
verification_result: passed
completed_at: 2026-04-13T23:08:45.187Z
blocker_discovered: false
---

# T01: Add BullMQ template push queue, worker with coder CLI child process, and log tee with exit sentinels

**Add BullMQ template push queue, worker with coder CLI child process, and log tee with exit sentinels**

## What Happened

The implementation was already complete from a prior session — `src/lib/templates/push-queue.ts` existed with the full queue, worker, coder binary resolution, child process spawning, log tee, and exit sentinel logic. The re-export in `src/lib/queue/index.ts` was also already wired.

The main work in this task was creating the test file `src/__tests__/lib/templates/push-queue.test.ts` with 8 tests covering:
- `pushLogPath` helper returns correct `/tmp/template-push-<jobId>.log` path
- `getTemplatePushQueue` returns a singleton Queue instance
- `createTemplatePushWorker` captures the processor function
- Processor spawns `coder templates push` with correct args and `--yes` flag
- `CODER_URL` and `CODER_SESSION_TOKEN` are injected into the child process env
- `createWriteStream` is called with append mode for the log file
- `[exit:0]` sentinel written on successful exit, `[exit:1]` on failure
- Spawn errors are caught, written to log with sentinel, and reject the job promise

Mocking strategy: BullMQ Queue/Worker mocked to capture processor; `child_process.spawn` mocked with real `Readable` streams; `fs.createWriteStream` mocked with a real `Writable` to support `.pipe()`; `execFile` mocked to simulate `which coder` resolution via promisify.

## Verification

Ran `npx vitest run src/__tests__/lib/templates/push-queue.test.ts` — all 8 tests pass. Tests cover queue creation, worker creation, correct spawn args/env, log file tee, exit sentinels for success and failure, and spawn error handling.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/templates/push-queue.test.ts` | 0 | ✅ pass | 420ms |

## Deviations

Implementation was already complete from a prior session. Task focused on creating the missing test file rather than the source module.

## Known Issues

Pre-existing ioredis dual-install type mismatch requires @ts-ignore on BullMQ Queue/Worker constructors (same pattern as council-queues.ts).

## Files Created/Modified

- `src/lib/templates/push-queue.ts`
- `src/__tests__/lib/templates/push-queue.test.ts`
- `src/lib/queue/index.ts`
