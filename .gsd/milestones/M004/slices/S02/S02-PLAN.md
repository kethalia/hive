# S02: Push Job Worker & SSE Streaming Route

**Goal:** BullMQ push queue/worker that spawns coder templates push as a child process and tees output to a log file. POST and SSE API routes for triggering and streaming push jobs.
**Demo:** curl POST starts a push job; curl SSE endpoint streams coder output in real time; template version updates in Coder.

## Must-Haves

- POST enqueues job and returns jobId. SSE streams all output and closes cleanly. End-to-end push succeeds against live Coder instance.

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: Template push queue, worker, and job processor** `est:45min`
  Create src/lib/templates/push-queue.ts:
- Define templatePushQueue (BullMQ Queue) and templatePushWorker (BullMQ Worker)
- Job data: { templateName: string, jobId: string }
- Processor:
  1. Resolves path to coder CLI binary (which coder or fallback)
  2. Spawns child process: coder templates push <name> --directory templates/<name> --yes
  3. Injects CODER_URL and CODER_SESSION_TOKEN from process.env into child env
  4. Tees stdout+stderr to /tmp/template-push-<jobId>.log (append mode)
  5. Writes final exit line '\n[exit: 0]\n' or '\n[exit: 1]\n' to log on close
  6. Resolves on exit 0, rejects on non-zero exit
- Register worker in src/lib/queue/index.ts alongside existing workers
  - Files: `src/lib/templates/push-queue.ts`, `src/lib/queue/index.ts`
  - Verify: npx vitest run src/__tests__/lib/templates/push-queue.test.ts

- [x] **T02: POST /api/templates/[name]/push and GET SSE stream route** `est:45min`
  Create two Next.js Route Handlers:

1. src/app/api/templates/[name]/push/route.ts (POST)
   - Validates template name is one of the known 4
   - Generates a jobId (nanoid)
   - Enqueues job to templatePushQueue
   - Returns { jobId }

2. src/app/api/templates/[name]/push/[jobId]/stream/route.ts (GET)
   - Opens /tmp/template-push-<jobId>.log for reading (wait up to 5s for file to appear)
   - Returns SSE Response (Content-Type: text/event-stream)
   - Tails the file: reads new lines, emits as SSE data events
   - Detects '[exit: 0]' or '[exit: 1]' line, emits a 'status' event with success/failure, then closes
   - Cleans up on client disconnect
  - Files: `src/app/api/templates/[name]/push/route.ts`, `src/app/api/templates/[name]/push/[jobId]/stream/route.ts`
  - Verify: npx vitest run src/__tests__/app/api/templates/

- [ ] **T03: Unit tests for push routes and worker processor** `est:30min`
  Create tests:

1. src/__tests__/lib/templates/push-queue.test.ts
   - Mock child_process.spawn
   - Verify log file is written with stdout+stderr
   - Verify exit line appended on process close
   - Verify job resolves on exit 0, rejects on exit 1
   - Verify CODER_URL and CODER_SESSION_TOKEN injected into child env

2. src/__tests__/app/api/templates/push.test.ts
   - POST with valid name returns { jobId }
   - POST with invalid name returns 400
   - Mock queue enqueue

3. src/__tests__/app/api/templates/stream.test.ts
   - SSE stream emits lines from log file
   - Emits status event on exit line detection
   - Closes after exit line
  - Files: `src/__tests__/lib/templates/push-queue.test.ts`, `src/__tests__/app/api/templates/push.test.ts`, `src/__tests__/app/api/templates/stream.test.ts`
  - Verify: npx vitest run src/__tests__/app/api/templates/ && npx vitest run

## Files Likely Touched

- src/lib/templates/push-queue.ts
- src/lib/queue/index.ts
- src/app/api/templates/[name]/push/route.ts
- src/app/api/templates/[name]/push/[jobId]/stream/route.ts
- src/__tests__/lib/templates/push-queue.test.ts
- src/__tests__/app/api/templates/push.test.ts
- src/__tests__/app/api/templates/stream.test.ts
