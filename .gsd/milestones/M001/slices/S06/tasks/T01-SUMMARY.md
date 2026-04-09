---
id: T01
parent: S06
milestone: M001
provides:
  - streamFromWorkspace() streaming primitive using child_process.spawn
  - SSE Route Handler at /api/tasks/[id]/stream
  - Agent step tees stdout to /tmp/hive-agent-output.log
key_files:
  - src/lib/workspace/stream.ts
  - src/app/api/tasks/[id]/stream/route.ts
  - src/lib/blueprint/steps/agent.ts
  - src/__tests__/lib/workspace/stream.test.ts
  - src/__tests__/app/tasks/stream-route.test.ts
key_decisions:
  - Use ReadableStream Web API (not Node.js stream) for browser-compatible SSE piping
patterns_established:
  - streamFromWorkspace() pattern: spawn coder ssh, buffer split on newlines, yield complete lines, kill on AbortSignal
  - SSE route pattern: makeSSEStream helper + TextEncoder transform for Response body
observability_surfaces:
  - "[stream]" prefixed console logs for spawn/close/error/abort lifecycle events
  - SSE named events: "status" (waiting/connected/ended), "error" (with JSON message)
  - Agent output persisted to /tmp/hive-agent-output.log for post-mortem inspection
duration: 15m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T01: Build SSE streaming endpoint and workspace stream primitive

**Added streamFromWorkspace() spawn-based streaming primitive and SSE route handler for live agent output relay, with tee-to-logfile in agent step**

## What Happened

Created three pieces of backend infrastructure for streaming agent output from Coder workspaces to the browser:

1. **`streamFromWorkspace()`** in `src/lib/workspace/stream.ts` — Uses `child_process.spawn` (not `execFile`) to get a live readable stream from a workspace via `coder ssh`. Buffers stdout chunks and splits on `\n` to yield complete lines. Handles AbortSignal to kill the child process, flushes remaining buffer on child exit, and logs all lifecycle events with `[stream]` prefix.

2. **SSE Route Handler** at `src/app/api/tasks/[id]/stream/route.ts` — Looks up the running worker workspace for a task via Prisma, constructs the SSH workspace name using the `hive-worker-{taskId.slice(0,8)}` pattern, and uses `streamFromWorkspace` to tail `/tmp/hive-agent-output.log`. Relays lines as SSE `data:` events with named `event: status` messages for lifecycle (waiting/connected/ended) and `event: error` for failures.

3. **Agent step modification** in `src/lib/blueprint/steps/agent.ts` — Appended `| tee /tmp/hive-agent-output.log` to the Pi command and added a pre-flight `echo '' > /tmp/hive-agent-output.log` to ensure the file exists before `tail -f` connects.

## Verification

- Stream primitive tests (6 tests): spawn command, line buffering, partial line handling, abort signal, child exit, buffer flush
- SSE route handler tests (5 tests): SSE headers, waiting status, line relay, ended status with process kill, correct workspace name construction
- Existing agent step tests (5 tests): all pass with the tee modification
- Full test suite: 115 tests across 22 files, all passing

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/workspace/stream.test.ts` | 0 | ✅ pass | 2.6s |
| 2 | `npx vitest run src/__tests__/app/tasks/stream-route.test.ts` | 0 | ✅ pass | 2.6s |
| 3 | `npx vitest run` | 0 | ✅ pass | 3.4s |

## Diagnostics

- **SSE endpoint:** `GET /api/tasks/{taskId}/stream` returns `Content-Type: text/event-stream`. Browser Network tab shows named SSE events.
- **Console logs:** Filter for `[stream]` to see spawn/close/error/abort lifecycle for all streaming connections.
- **Agent output file:** `/tmp/hive-agent-output.log` inside the workspace persists agent output for post-mortem inspection even without SSE connected.
- **Failure states:** SSE returns `event: status {"status":"waiting"}` when no running workspace exists. DB errors produce `event: error` with message.

## Deviations

- Used Web Streams API (`ReadableStream`) instead of Node.js streams for the SSE response body, since Next.js Route Handlers work natively with Web Response objects. This is a better fit than the plan's implicit assumption of Node streams.
- Added a `cancel()` handler on the ReadableStream to kill the child process when the stream consumer disconnects, providing an additional cleanup path beyond AbortSignal.

## Known Issues

None.

## Files Created/Modified

- `src/lib/workspace/stream.ts` — New streaming primitive: `streamFromWorkspace()` using spawn + line buffering
- `src/app/api/tasks/[id]/stream/route.ts` — New SSE Route Handler with workspace lookup and stream relay
- `src/lib/blueprint/steps/agent.ts` — Modified to tee Pi output to `/tmp/hive-agent-output.log`
- `src/__tests__/lib/workspace/stream.test.ts` — 6 tests for stream primitive (spawn, buffering, abort, exit)
- `src/__tests__/app/tasks/stream-route.test.ts` — 5 tests for SSE route (headers, waiting, relay, ended, workspace name)
- `.gsd/milestones/M001/slices/S06/S06-PLAN.md` — Added failure-path verification step
- `.gsd/milestones/M001/slices/S06/tasks/T01-PLAN.md` — Added Observability Impact section
