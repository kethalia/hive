# S06: Live Agent Streaming & Dashboard Results

**Goal:** Dashboard shows live agent activity streamed from workspaces, and completed tasks display PR link, CI status, and verification report.
**Demo:** Open task detail while agent is running → see live text output streaming in real-time. After task completes → see PR link, verification report with outcome badge and expandable logs.

## Must-Haves

- SSE endpoint that streams agent output from a running workspace to the browser
- `streamFromWorkspace()` primitive using `child_process.spawn` for streaming (not `execFile`)
- Agent step tees its stdout to `/tmp/hive-agent-output.log` so the SSE endpoint can tail it
- React client component (`AgentStreamPanel`) consuming SSE and rendering live text + status
- Task detail page shows verification report card (strategy, outcome badge, duration, logs)
- `TaskWithRelations` type includes `verificationReport` field
- SSE connection cleanup on browser disconnect (kill spawned process via AbortSignal)
- Streaming panel only shows when task status is `running`

## Proof Level

- This slice proves: integration
- Real runtime required: no (unit tests with mocked child_process + component rendering tests)
- Human/UAT required: no

## Verification

- `npx vitest run src/__tests__/lib/workspace/stream.test.ts` — stream primitive tests (spawn, JSONL line splitting, cleanup)
- `npx vitest run src/__tests__/app/tasks/stream-route.test.ts` — SSE route handler tests (relay, abort cleanup, workspace lookup)
- `npx vitest run src/__tests__/app/tasks/task-detail-results.test.ts` — verification report + PR display rendering tests
- `npx vitest run` — all existing tests still pass (zero regressions)
- Failure-path check: stream-route tests verify that SSE returns `event: status` with `{"status":"waiting"}` when no running workspace exists, and stream tests verify abort signal kills the child process (covers error/disconnect paths)

## Observability / Diagnostics

- Runtime signals: `[stream]` prefixed console logs for SSE connection lifecycle (connect, data relay, disconnect, error)
- Inspection surfaces: SSE endpoint at `/api/tasks/[id]/stream` returns `text/event-stream`; browser Network tab shows SSE events
- Failure visibility: SSE sends `event: error` with message when workspace not found or stream fails; `event: status` with waiting/connected/ended states
- Redaction constraints: Agent output may contain file contents — no additional redaction needed (solo operator per R024)

## Integration Closure

- Upstream surfaces consumed: `src/lib/workspace/exec.ts` (pattern for coder ssh), `src/lib/api/tasks.ts` (getTask, workspace lookup), `src/lib/verification/report.ts` (VerificationReport type), `src/app/tasks/[id]/task-detail.tsx` (existing detail page with S06 placeholder)
- New wiring introduced in this slice: SSE Route Handler at `app/api/tasks/[id]/stream/route.ts`, `streamFromWorkspace()` in `lib/workspace/stream.ts`, agent step modified to tee output, AgentStreamPanel component replaces placeholder card
- What remains before the milestone is truly usable end-to-end: S07 (workspace lifecycle & pre-warming)

## Tasks

- [x] **T01: Build SSE streaming endpoint and workspace stream primitive** `est:1h`
  - Why: This is the riskiest integration point — proving that agent output can be streamed from a workspace to the browser via SSE. Creates the backend plumbing that the streaming UI will consume.
  - Files: `src/lib/workspace/stream.ts`, `src/app/api/tasks/[id]/stream/route.ts`, `src/lib/blueprint/steps/agent.ts`, `src/__tests__/lib/workspace/stream.test.ts`, `src/__tests__/app/tasks/stream-route.test.ts`
  - Do: (1) Create `streamFromWorkspace()` using `child_process.spawn("coder", ["ssh", workspace, "--", cmd])` that returns a readable stream of text lines with proper buffer splitting on `\n`. (2) Modify agent step to tee Pi stdout to `/tmp/hive-agent-output.log` by appending `| tee /tmp/hive-agent-output.log` to the Pi command. (3) Create SSE Route Handler that looks up the running worker workspace for a task, spawns `coder ssh workspace -- tail -f -n +1 /tmp/hive-agent-output.log`, and relays lines as SSE `data:` events. (4) Handle AbortSignal from request to kill the spawned process on disconnect. (5) Send `event: status` messages for waiting/connected/ended states. (6) Unit test stream primitive and route handler with mocked child_process.
  - Verify: `npx vitest run src/__tests__/lib/workspace/stream.test.ts src/__tests__/app/tasks/stream-route.test.ts`
  - Done when: Stream primitive spawns coder ssh and emits lines; SSE route handler returns text/event-stream; abort signal kills child process; tests pass.

- [x] **T02: Add verification report card and complete task results display** `est:45m`
  - Why: Completed tasks need to show PR link with status context and the verification report (strategy, outcome, logs, duration). This is pure UI wiring — data already exists in the DB.
  - Files: `src/app/tasks/[id]/task-detail.tsx`, `src/app/tasks/[id]/verification-report-card.tsx`, `src/lib/types/tasks.ts`, `src/lib/helpers/format.ts`, `src/__tests__/app/tasks/task-detail-results.test.ts`
  - Do: (1) Add `verificationReport` field to `TaskWithRelations` type matching the `VerificationReport` interface shape (strategy, outcome, logs, durationMs, timestamp). (2) Create `VerificationReportCard` component that renders: strategy badge, outcome badge (green=pass, red=fail, yellow=inconclusive), duration, and expandable/collapsible logs section. (3) Wire `VerificationReportCard` into `task-detail.tsx` — show below PR link when `task.verificationReport` exists. (4) Add outcome-to-badge-variant mapping in format helpers. (5) Write rendering tests for the report card with all three outcome states and for tasks without a report.
  - Verify: `npx vitest run src/__tests__/app/tasks/task-detail-results.test.ts`
  - Done when: Verification report card renders with strategy, outcome badge, duration, and collapsible logs. Task detail page integrates the card. Tests cover pass/fail/inconclusive states.

- [x] **T03: Build live agent streaming UI panel** `est:45m`
  - Why: Replaces the S06 placeholder card with a real streaming panel that connects to the SSE endpoint and renders live agent output. This is the user-facing deliverable for R014.
  - Files: `src/app/tasks/[id]/agent-stream-panel.tsx`, `src/app/tasks/[id]/task-detail.tsx`, `src/__tests__/app/tasks/agent-stream-panel.test.ts`
  - Do: (1) Create `AgentStreamPanel` client component that uses `EventSource` to connect to `/api/tasks/${taskId}/stream`. (2) Render connection status indicator (connecting/streaming/ended/error). (3) Accumulate and render streamed text lines in a scrollable container with auto-scroll to bottom. (4) Show the panel only when task status is `running` — hide for queued/done/failed. (5) Handle EventSource reconnection gracefully (show reconnecting state). (6) Replace the dashed placeholder card in `task-detail.tsx` with `AgentStreamPanel` for running tasks, keeping the placeholder for non-streaming states. (7) Write component tests with mocked EventSource covering streaming, error, and ended states.
  - Verify: `npx vitest run src/__tests__/app/tasks/agent-stream-panel.test.ts`
  - Done when: Agent stream panel connects to SSE, renders live text, shows status indicator, auto-scrolls, replaces placeholder in task detail. Tests pass.

## Files Likely Touched

- `src/lib/workspace/stream.ts` (new — stream primitive)
- `src/app/api/tasks/[id]/stream/route.ts` (new — SSE Route Handler)
- `src/lib/blueprint/steps/agent.ts` (modify — tee output to log file)
- `src/app/tasks/[id]/agent-stream-panel.tsx` (new — streaming UI)
- `src/app/tasks/[id]/verification-report-card.tsx` (new — report card)
- `src/app/tasks/[id]/task-detail.tsx` (modify — integrate panels)
- `src/lib/types/tasks.ts` (modify — add verificationReport)
- `src/lib/helpers/format.ts` (modify — outcome variant mapping)
- `src/__tests__/lib/workspace/stream.test.ts` (new — stream tests)
- `src/__tests__/app/tasks/stream-route.test.ts` (new — route tests)
- `src/__tests__/app/tasks/task-detail-results.test.ts` (new — results tests)
- `src/__tests__/app/tasks/agent-stream-panel.test.ts` (new — panel tests)
