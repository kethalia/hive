---
id: S06
parent: M001
milestone: M001
provides:
  - streamFromWorkspace() spawn-based streaming primitive with line buffering and abort cleanup
  - SSE Route Handler at /api/tasks/[id]/stream relaying live agent output
  - Agent step tees stdout to /tmp/hive-agent-output.log for streaming and post-mortem
  - AgentStreamPanel client component with EventSource SSE, connection status indicator, auto-scroll
  - VerificationReportCard with strategy/outcome badges, duration, and collapsible logs
  - VerificationReportData type and outcomeVariant/formatDuration helpers
requires:
  - slice: S02
    provides: task-detail.tsx page structure with placeholder card for streaming
  - slice: S03
    provides: agent step (agent.ts) and execInWorkspace pattern for coder ssh commands
affects:
  - S07 (workspace lifecycle — no code dependency, but streaming cleanup interacts with workspace deletion)
key_files:
  - src/lib/workspace/stream.ts
  - src/app/api/tasks/[id]/stream/route.ts
  - src/lib/blueprint/steps/agent.ts
  - src/app/tasks/[id]/agent-stream-panel.tsx
  - src/app/tasks/[id]/verification-report-card.tsx
  - src/app/tasks/[id]/task-detail.tsx
  - src/lib/types/tasks.ts
  - src/lib/helpers/format.ts
key_decisions:
  - Use custom React components consuming SSE instead of pi-web-ui Lit components (D009)
  - Agent output via tee-to-logfile + coder ssh tail, not Pi RPC or Redis pub/sub (D010)
  - Use Web Streams API (ReadableStream) for SSE response, not Node.js streams
  - Use data-testid attributes consistently for component testing in jsdom
patterns_established:
  - streamFromWorkspace() pattern — spawn coder ssh, buffer on newlines, yield complete lines, kill on AbortSignal
  - SSE route pattern — makeSSEStream helper + TextEncoder for Response body, named events for lifecycle
  - EventSource mock pattern — class with _emitMessage/_emitStatus/_emitError helpers for testing
  - Component testing pattern — vitest-environment jsdom directive + @testing-library/react + cleanup
  - outcomeVariant/statusVariant Record mapping pattern for badge styling
observability_surfaces:
  - "[stream]" prefixed console logs for spawn/close/error/abort lifecycle
  - SSE named events — "status" (waiting/connected/ended), "error" (JSON message)
  - /tmp/hive-agent-output.log persisted in workspace for post-mortem
  - AgentStreamPanel renders colored status dot (green/yellow/gray/red) with label
  - VerificationReportCard shows strategy badge, color-coded outcome badge, collapsible logs
drill_down_paths:
  - .gsd/milestones/M001/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S06/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001/slices/S06/tasks/T03-SUMMARY.md
duration: 33m
verification_result: passed
completed_at: 2026-03-20
---

# S06: Live Agent Streaming & Dashboard Results

**SSE-based live agent output streaming from workspaces to browser, plus verification report and PR display on completed tasks**

## What Happened

This slice connected the last major user-facing gap: seeing what the agent is doing while it works, and seeing what it produced when done.

**T01 — Backend streaming plumbing.** Created `streamFromWorkspace()` in `src/lib/workspace/stream.ts` — a spawn-based primitive that runs `coder ssh workspace -- command` and yields complete text lines with proper newline-boundary buffering. Built the SSE Route Handler at `/api/tasks/[id]/stream` that looks up the running worker workspace, spawns `tail -f /tmp/hive-agent-output.log` via coder ssh, and relays lines as SSE `data:` events with named `event: status` messages for lifecycle (waiting/connected/ended). Modified the agent step to tee Pi stdout to the log file. AbortSignal and ReadableStream cancel() both kill the child process on disconnect.

**T02 — Verification report display.** Added `VerificationReportData` type to `TaskWithRelations`, created `VerificationReportCard` component with strategy badge, color-coded outcome badge (green=pass, red=fail, yellow=inconclusive), formatted duration, and a collapsible logs section. Wired into task-detail.tsx. Added `outcomeVariant` mapping and `formatDuration()` helpers.

**T03 — Live streaming UI.** Built `AgentStreamPanel` client component using EventSource to connect to the SSE endpoint. Renders connection status with a colored dot, accumulates output in a monospace scrollable area with auto-scroll, and returns null for non-running tasks. Replaced the S06 placeholder card in task-detail.tsx.

## Verification

- **Stream primitive tests** (6): spawn command construction, line buffering, partial line handling, abort signal kills process, child exit cleanup, buffer flush on close
- **SSE route handler tests** (5): correct Content-Type headers, waiting status for missing workspace, line relay as SSE data events, ended status with process cleanup, workspace name construction
- **Task detail results tests** (16): outcomeVariant mapping (3), formatDuration (5), VerificationReportCard rendering (8 — strategy badge, three outcome states, duration, collapsed/expanded logs, different strategies)
- **Agent stream panel tests** (8): no EventSource for non-running tasks, URL construction, line rendering, connecting state, error state, cleanup on unmount, streaming transition, waiting status
- **Full suite**: 139 tests across 24 files, all passing, zero regressions
- **Placeholder removal**: `grep -r "future update" src/app/tasks/` returns no matches

## New Requirements Surfaced

- None

## Deviations

- Used Web Streams API (`ReadableStream`) instead of Node.js streams for the SSE response body. Next.js Route Handlers work natively with Web Response, making this a better fit.
- Used custom React components instead of pi-web-ui Lit components for streaming display. This consciously retires the pi-web-ui integration risk by sidestepping it — documented as D009.
- Installed `@testing-library/react`, `@testing-library/jest-dom`, and `jsdom` as devDependencies for component testing (not present before S06).

## Known Limitations

- **No Pi RPC integration** — Streaming shows raw text output, not structured agent events (messages, tool calls, progress). R014 asked for pi-web-ui Lit components over RPC; this slice delivers SSE text streaming instead. Sufficient for MVP visibility but lacks structured event rendering.
- **Single-workspace streaming** — SSE endpoint tails from one workspace. If a task has both worker and verifier running, only the worker stream is shown.
- **No reconnection persistence** — EventSource reconnects automatically, but accumulated output is lost on page refresh. The log file persists in the workspace for post-mortem but isn't re-fetched on reconnection.

## Follow-ups

- S07 must ensure workspace cleanup doesn't kill the streaming child process mid-stream — the grace period should account for active SSE connections.
- Consider adding structured event parsing if Pi's stdout includes JSONL markers — the line-splitting infrastructure supports it.

## Files Created/Modified

- `src/lib/workspace/stream.ts` — New: streamFromWorkspace() spawn-based streaming primitive
- `src/app/api/tasks/[id]/stream/route.ts` — New: SSE Route Handler with workspace lookup and stream relay
- `src/lib/blueprint/steps/agent.ts` — Modified: tee Pi output to /tmp/hive-agent-output.log
- `src/app/tasks/[id]/agent-stream-panel.tsx` — New: EventSource SSE client with connection status and auto-scroll
- `src/app/tasks/[id]/verification-report-card.tsx` — New: strategy/outcome badges with collapsible logs
- `src/app/tasks/[id]/task-detail.tsx` — Modified: replaced placeholder with AgentStreamPanel and VerificationReportCard
- `src/lib/types/tasks.ts` — Modified: added VerificationReportData interface and field on TaskWithRelations
- `src/lib/helpers/format.ts` — Modified: added outcomeVariant mapping and formatDuration()
- `src/__tests__/lib/workspace/stream.test.ts` — New: 6 stream primitive tests
- `src/__tests__/app/tasks/stream-route.test.ts` — New: 5 SSE route handler tests
- `src/__tests__/app/tasks/task-detail-results.test.ts` — New: 16 verification report tests
- `src/__tests__/app/tasks/agent-stream-panel.test.ts` — New: 8 streaming panel tests

## Forward Intelligence

### What the next slice should know
- The SSE endpoint at `/api/tasks/[id]/stream` spawns a child process (`coder ssh ... tail -f`). This child process must be killed when the workspace is deleted. If S07's cleanup scheduler deletes a workspace while a browser is streaming, the child process will get SIGPIPE and the SSE will send `event: status {"status":"ended"}` — this is handled gracefully.
- `@testing-library/react` and jsdom are now available as devDependencies. Use the `// @vitest-environment jsdom` per-file directive for component tests.

### What's fragile
- The workspace name construction in the SSE route uses `hive-worker-${taskId.slice(0,8)}` — this must stay in sync with the workspace naming in `src/lib/coder/client.ts`. If the naming convention changes, streaming breaks silently (returns "waiting" forever).
- AbortSignal cleanup depends on the browser properly closing the EventSource connection. If a browser tab crashes without clean disconnect, the coder ssh child process may linger until the workspace is deleted.

### Authoritative diagnostics
- Filter console for `[stream]` — all streaming lifecycle events (spawn, data relay, close, error, abort) are logged with this prefix.
- SSE endpoint at `/api/tasks/{id}/stream` — open in browser Network tab to see raw SSE event flow.
- `/tmp/hive-agent-output.log` inside any worker workspace — contains full agent output regardless of whether SSE was connected.

### What assumptions changed
- **Original:** pi-web-ui Lit components over RPC for agent activity display. **Actual:** Custom React components over SSE with text streaming. Simpler, avoids SSR friction, sufficient for MVP. D009 documents the decision.
- **Original:** Agent output streaming via Pi RPC endpoint. **Actual:** Agent step tees to log file, SSE tails the file via coder ssh. D010 documents this as upgradeable.
