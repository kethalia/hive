---
id: T03
parent: S06
milestone: M001
provides:
  - AgentStreamPanel client component with EventSource-based SSE streaming
  - Live agent output display in task detail page for running tasks
key_files:
  - src/app/tasks/[id]/agent-stream-panel.tsx
  - src/app/tasks/[id]/task-detail.tsx
  - src/__tests__/app/tasks/agent-stream-panel.test.ts
key_decisions:
  - Use data-testid attributes consistently for testability (following T02 pattern)
patterns_established:
  - EventSource mock pattern: class with _emitMessage/_emitStatus/_emitError helpers and static instances array for test assertions
  - SSE client pattern: useEffect with EventSource, status/message/error handlers, cleanup on unmount
observability_surfaces:
  - AgentStreamPanel renders status dot (green/yellow/gray/red) and label for connection state
  - Panel only renders for running tasks — null for other statuses
  - Auto-scroll keeps latest output visible
duration: 8m
verification_result: passed
completed_at: 2026-03-20
blocker_discovered: false
---

# T03: Build live agent streaming UI panel

**Added AgentStreamPanel client component that connects to SSE endpoint and renders live agent output with connection status indicator, replacing the placeholder card**

## What Happened

Built the user-facing streaming panel for R014 across three files:

1. **AgentStreamPanel** (`src/app/tasks/[id]/agent-stream-panel.tsx`) — Client component that creates an EventSource connection to `/api/tasks/{taskId}/stream` when task status is `running`. Handles three SSE event types: default `message` events (appends lines), named `status` events (updates connection state), and `error` events. Renders a Card with a color-coded status dot (green=streaming, yellow=connecting/waiting, gray=ended, red=error), monospace output area in a 400px ScrollArea with auto-scroll via ref + scrollIntoView, and a waiting message when no output has arrived yet. Returns null for non-running tasks.

2. **task-detail.tsx update** — Replaced the dashed placeholder card ("S06 Streaming Placeholder") with `<AgentStreamPanel taskId={task.id} status={task.status} />`. The component handles its own visibility logic.

3. **Tests** (`src/__tests__/app/tasks/agent-stream-panel.test.ts`) — 8 tests using a MockEventSource class with programmatic event emission helpers. Covers: no EventSource for done status, correct URL construction, line rendering on message events, initial connecting state, error state, cleanup on unmount, connected→streaming transition, and waiting status display.

## Verification

- 8 agent-stream-panel tests pass
- 139 total tests across 24 files pass with zero regressions
- All slice-level verification checks pass (stream primitive, SSE route, task-detail-results, full suite)
- `grep -r "future update" src/app/tasks/` returns no matches — placeholder fully removed

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/app/tasks/agent-stream-panel.test.ts` | 0 | ✅ pass | 0.6s |
| 2 | `npx vitest run` | 0 | ✅ pass | 1.4s |
| 3 | `grep -r "future update" src/app/tasks/` | 1 | ✅ pass (no matches) | <0.1s |
| 4 | `npx vitest run src/__tests__/lib/workspace/stream.test.ts` | 0 | ✅ pass | 0.4s |
| 5 | `npx vitest run src/__tests__/app/tasks/stream-route.test.ts` | 0 | ✅ pass | 0.4s |
| 6 | `npx vitest run src/__tests__/app/tasks/task-detail-results.test.ts` | 0 | ✅ pass | 0.9s |

## Diagnostics

- **Panel visibility:** The AgentStreamPanel only renders when `task.status === "running"`. For all other statuses it returns null — no DOM output.
- **Connection status indicator:** The colored dot and label in the card header reflect the current EventSource state. Green dot = actively receiving data. Yellow = connecting or waiting for workspace. Red = error (EventSource will auto-reconnect). Gray = stream ended.
- **Stream output inspection:** The monospace `<pre>` block with `data-testid="stream-output"` accumulates all lines received from SSE. Auto-scrolls to bottom via a sentinel div ref.
- **Browser Network tab:** SSE connection visible as a long-lived request to `/api/tasks/{taskId}/stream` with `Content-Type: text/event-stream`.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/app/tasks/[id]/agent-stream-panel.tsx` — New client component: EventSource SSE connection, connection status display, monospace output with auto-scroll
- `src/app/tasks/[id]/task-detail.tsx` — Replaced S06 placeholder card with AgentStreamPanel import and render
- `src/__tests__/app/tasks/agent-stream-panel.test.ts` — 8 tests with MockEventSource covering all connection states and cleanup
