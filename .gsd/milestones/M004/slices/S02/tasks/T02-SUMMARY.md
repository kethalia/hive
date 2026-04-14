---
id: T02
parent: S02
milestone: M004
key_files:
  - src/app/api/templates/[name]/push/route.ts
  - src/app/api/templates/[name]/push/[jobId]/stream/route.ts
  - src/__tests__/app/api/templates/push-routes.test.ts
key_decisions:
  - Used top-level vi.mock for fs with per-test mockReturnValue configuration instead of vi.doMock, since doMock with dynamic imports was unreliable for resetting fs mocks between test groups
duration: 
verification_result: passed
completed_at: 2026-04-13T23:11:16.351Z
blocker_discovered: false
---

# T02: Add POST /api/templates/[name]/push and GET SSE stream routes with 9 tests

**Add POST /api/templates/[name]/push and GET SSE stream routes with 9 tests**

## What Happened

Both route files were already implemented from a prior session. The POST route validates the template name against KNOWN_TEMPLATES, generates a UUID jobId, enqueues to the BullMQ templatePushQueue, and returns { jobId }. The SSE stream route validates template name and jobId format, waits up to 30s for the log file to appear, then polls it with byte-offset reads emitting lines as SSE data events, detecting [exit:0]/[exit:1] sentinels to emit a named "status" event before closing.

The main work in this task was creating the test file `src/__tests__/app/api/templates/push-routes.test.ts` with 9 tests covering both routes:

POST route (4 tests): rejects unknown template with 400, enqueues job and returns jobId for valid template, returns 500 when queue.add fails, accepts ai-dev as valid template.

SSE stream route (5 tests): rejects unknown template with 400, rejects invalid jobId format with 400, returns correct SSE headers, streams log lines as data events and emits success status on exit:0, emits failure status on exit:1.

Mocking strategy: BullMQ queue mocked with captured add(); fs.existsSync/statSync/createReadStream mocked at module level with per-test configuration via mockReturnValue; staleness module mocked with known template list.

## Verification

Ran `npx vitest run src/__tests__/app/api/templates/` — all 9 tests pass covering POST validation, enqueueing, error handling, SSE headers, log streaming, and exit sentinel detection.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/app/api/templates/` | 0 | ✅ pass | 185ms |

## Deviations

Both route files already existed from a prior session. Task focused on creating the missing test file rather than the source routes.

## Known Issues

None

## Files Created/Modified

- `src/app/api/templates/[name]/push/route.ts`
- `src/app/api/templates/[name]/push/[jobId]/stream/route.ts`
- `src/__tests__/app/api/templates/push-routes.test.ts`
