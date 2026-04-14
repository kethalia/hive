# S02: Push Job Worker & SSE Streaming Route — UAT

**Milestone:** M004
**Written:** 2026-04-13T23:13:42.851Z

# S02 UAT: Push Job Worker & SSE Streaming Route

## Preconditions
- Hive dev server running (`pnpm dev`)
- Redis running (BullMQ dependency)
- `CODER_URL` and `CODER_SESSION_TOKEN` set in environment
- Coder CLI binary available on PATH

## Test Cases

### TC1: POST enqueues a push job for a valid template
1. Send `curl -X POST http://localhost:3000/api/templates/hive/push`
2. **Expected:** 200 response with `{ "jobId": "<uuid>" }`
3. Verify jobId is a valid UUID format

### TC2: POST rejects unknown template name
1. Send `curl -X POST http://localhost:3000/api/templates/nonexistent/push`
2. **Expected:** 400 response with error message about unknown template

### TC3: SSE stream emits coder push output in real time
1. POST to `/api/templates/hive/push` to get a jobId
2. Open SSE connection: `curl -N http://localhost:3000/api/templates/hive/push/<jobId>/stream`
3. **Expected:** Response headers include `Content-Type: text/event-stream`
4. **Expected:** Lines from coder CLI output appear as `data: <line>` SSE events
5. **Expected:** On completion, a named `event: status` event is emitted with `data: {"status":"success"}` or `data: {"status":"failure"}`
6. **Expected:** Stream closes after status event

### TC4: SSE stream handles exit:1 (push failure)
1. Trigger a push for a template that will fail (e.g., invalid template directory)
2. Stream the job output via SSE
3. **Expected:** `event: status` with `data: {"status":"failure"}` is emitted
4. **Expected:** Stream closes cleanly after failure status

### TC5: SSE rejects invalid jobId format
1. Send `curl http://localhost:3000/api/templates/hive/push/not-a-uuid/stream`
2. **Expected:** 400 response with error about invalid jobId

### TC6: Log file persistence
1. POST to start a push job, note the jobId
2. After job completes, verify `/tmp/template-push-<jobId>.log` exists
3. **Expected:** Log contains coder CLI output lines and ends with `[exit:0]` or `[exit:1]`

### TC7: Multiple SSE clients on same job
1. POST to start a push job
2. Open two concurrent SSE connections to the same jobId stream
3. **Expected:** Both clients receive the same output events

## Edge Cases
- SSE connection opened before worker starts processing (log file doesn't exist yet) — stream should wait up to 30s for file to appear
- Client disconnects mid-stream — server should clean up without errors
- Redis unavailable — POST should return 500, not hang
