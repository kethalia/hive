---
estimated_steps: 15
estimated_files: 3
skills_used: []
---

# T03: Unit tests for push routes and worker processor

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

## Inputs

- `src/lib/templates/push-queue.ts`
- `src/app/api/templates/[name]/push/route.ts`
- `src/app/api/templates/[name]/push/[jobId]/stream/route.ts`

## Expected Output

- `src/__tests__/lib/templates/push-queue.test.ts`
- `src/__tests__/app/api/templates/push.test.ts`
- `src/__tests__/app/api/templates/stream.test.ts`

## Verification

npx vitest run src/__tests__/app/api/templates/ && npx vitest run
