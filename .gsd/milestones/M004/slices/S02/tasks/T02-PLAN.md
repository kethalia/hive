---
estimated_steps: 12
estimated_files: 2
skills_used: []
---

# T02: POST /api/templates/[name]/push and GET SSE stream route

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

## Inputs

- `src/lib/templates/push-queue.ts`

## Expected Output

- `src/app/api/templates/[name]/push/route.ts`
- `src/app/api/templates/[name]/push/[jobId]/stream/route.ts`

## Verification

npx vitest run src/__tests__/app/api/templates/
