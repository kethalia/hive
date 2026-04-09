---
estimated_steps: 6
estimated_files: 5
---

# T01: Build SSE streaming endpoint and workspace stream primitive

**Slice:** S06 — Live Agent Streaming & Dashboard Results
**Milestone:** M001

## Description

Create the backend infrastructure for streaming agent output from a Coder workspace to the browser. This has two parts: (1) a `streamFromWorkspace()` function that uses `child_process.spawn` (not `execFile`) to get a live readable stream from a workspace via `coder ssh`, and (2) a Next.js Route Handler that serves SSE events by tailing the agent's output log file inside the workspace. Also modifies the agent step to tee its stdout to a log file so there's something to tail.

This is the riskiest piece of S06 — it proves that workspace-to-browser streaming works through the coder ssh layer.

**Relevant skills:** None needed beyond standard Node.js child_process and Next.js Route Handlers.

## Steps

1. **Create `src/lib/workspace/stream.ts`** — Export `streamFromWorkspace(workspaceName: string, command: string, signal?: AbortSignal): { stdout: ReadableStream<string>, process: ChildProcess }`. Implementation: `spawn("coder", ["ssh", workspaceName, "--", "bash", "-l", "-c", command])`. Accumulate a string buffer from the child's stdout; split on `\n` and yield complete lines. When the AbortSignal fires, kill the child process (SIGTERM). When the child exits, close the stream. Log `[stream]` prefixed messages for lifecycle events.

2. **Modify `src/lib/blueprint/steps/agent.ts`** — In the Pi command construction, append `| tee /tmp/hive-agent-output.log` to the pi command so stdout is both displayed and captured to a file. This is a minimal one-line change to the command string. Before running Pi, also `echo '' > /tmp/hive-agent-output.log` to ensure the file exists (so `tail -f` doesn't fail if SSE connects before Pi starts).

3. **Create `src/app/api/tasks/[id]/stream/route.ts`** — Export a GET handler that:
   - Extracts task ID from the URL params
   - Looks up the task via Prisma to find the associated running worker workspace (`db.workspace.findFirst({ where: { taskId, templateType: "worker", status: "running" } })`)
   - If no running workspace, returns SSE with `event: status` data `{"status":"waiting"}` and closes
   - Uses `streamFromWorkspace(workspaceName, "tail -f -n +1 /tmp/hive-agent-output.log", request.signal)` to stream
   - Relays each line as `data: <line>\n\n` SSE format
   - Sends `event: status` with `{"status":"connected"}` on start and `{"status":"ended"}` on stream close
   - Returns `new Response(readableStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } })`
   - The workspace name for coder ssh must include the agent name. Look up workspace by `coderWorkspaceId`, then construct the SSH name as `hive-worker-{taskId.slice(0,8)}` (matching the pattern in task-queue.ts).

4. **Create `src/__tests__/lib/workspace/stream.test.ts`** — Mock `child_process.spawn`. Test: (a) spawns correct coder ssh command, (b) emits complete lines from buffered chunks, (c) handles partial lines across chunks correctly, (d) kills process on abort signal, (e) closes stream on child exit.

5. **Create `src/__tests__/app/tasks/stream-route.test.ts`** — Mock `@/lib/workspace/stream` and Prisma. Test: (a) returns SSE content-type headers, (b) sends waiting status when no running workspace, (c) relays lines from stream as SSE data events, (d) sends ended status on stream close.

6. **Run all tests** to confirm zero regressions: `npx vitest run`.

## Must-Haves

- [ ] `streamFromWorkspace()` uses `spawn` (not `execFile`) and returns a readable stream
- [ ] Buffer splitting handles partial lines across chunks (no truncated JSON)
- [ ] AbortSignal kills the spawned coder ssh process
- [ ] SSE Route Handler returns `Content-Type: text/event-stream`
- [ ] Agent step tees output to `/tmp/hive-agent-output.log`
- [ ] Route Handler sends status events (waiting/connected/ended)
- [ ] All new tests pass; all existing tests still pass

## Verification

- `npx vitest run src/__tests__/lib/workspace/stream.test.ts` — stream primitive tests pass
- `npx vitest run src/__tests__/app/tasks/stream-route.test.ts` — route handler tests pass
- `npx vitest run` — zero regressions across all test files

## Inputs

- `src/lib/workspace/exec.ts` — Pattern for coder ssh invocation (uses `execFile`; we need `spawn` equivalent)
- `src/lib/blueprint/steps/agent.ts` — Agent step that constructs the Pi command (needs tee addition)
- `src/lib/queue/task-queue.ts` — Shows workspace naming pattern: `hive-worker-${taskId.slice(0, 8)}`
- `prisma/schema.prisma` — Workspace model with taskId, templateType, status, coderWorkspaceId fields

## Expected Output

- `src/lib/workspace/stream.ts` — New streaming primitive exporting `streamFromWorkspace()`
- `src/app/api/tasks/[id]/stream/route.ts` — New SSE Route Handler
- `src/lib/blueprint/steps/agent.ts` — Modified to tee Pi output to log file
- `src/__tests__/lib/workspace/stream.test.ts` — 4-5 tests for stream primitive
- `src/__tests__/app/tasks/stream-route.test.ts` — 3-4 tests for SSE route

## Observability Impact

- **New signals:** `[stream]` prefixed console logs for spawn, stderr relay, close, error, abort, and cancel events in `streamFromWorkspace()`. SSE route logs `[stream] SSE connect/waiting/connected/ended/error` for each connection lifecycle.
- **Inspection:** `GET /api/tasks/[id]/stream` returns `Content-Type: text/event-stream`. Named SSE events (`status`, `error`) carry structured JSON payloads. Browser Network tab shows event stream.
- **Failure visibility:** SSE returns `event: status {"status":"waiting"}` when no running workspace exists. `event: error` with message when DB lookup fails. AbortSignal from client disconnect kills the child process and logs `[stream] aborted`.
- **Agent output capture:** Pi stdout is teed to `/tmp/hive-agent-output.log` inside the workspace, enabling post-mortem inspection even when SSE was not connected.
