---
estimated_steps: 5
estimated_files: 4
---

# T03: Build live agent streaming UI panel

**Slice:** S06 — Live Agent Streaming & Dashboard Results
**Milestone:** M001

## Description

Build the `AgentStreamPanel` client component that connects to the SSE endpoint created in T01 and renders live agent output in the task detail page. This replaces the dashed placeholder card ("Live Agent Activity") with a real streaming panel. The panel only shows for tasks with `running` status and displays connection state (connecting/streaming/ended/error) plus the live text output with auto-scroll.

This is the user-facing deliverable for R014 — "Dashboard shows real-time agent activity."

## Steps

1. **Create `src/app/tasks/[id]/agent-stream-panel.tsx`** — Client component that:
   - Accepts `taskId: string` and `status: string` props
   - Only activates EventSource when status is `"running"` — for other statuses, renders nothing or a static message
   - Creates `new EventSource(\`/api/tasks/${taskId}/stream\`)` on mount when running
   - Listens for `message` events (default data lines) and `status` events (waiting/connected/ended)
   - Maintains state: `lines: string[]` (accumulated output), `connectionStatus: "connecting" | "streaming" | "waiting" | "ended" | "error"`
   - On `message` event: append the line to `lines` state
   - On `status` event: parse JSON and update connection status
   - On `error` event: set status to `"error"`, EventSource will auto-reconnect
   - On cleanup (unmount or status change away from running): close the EventSource
   - Renders a Card with:
     - Header: "Live Agent Activity" with a status indicator dot (green=streaming, yellow=connecting/waiting, gray=ended, red=error)
     - Body: ScrollArea with monospace text showing accumulated lines. Auto-scroll to bottom on new lines using a ref + `scrollIntoView`. Max height ~400px.
     - If no lines yet and status is connecting/waiting, show a subtle "Waiting for agent output..." message

2. **Update `src/app/tasks/[id]/task-detail.tsx`** — Replace the dashed placeholder card ("S06 Streaming Placeholder") with the `AgentStreamPanel` component. Import it and render `<AgentStreamPanel taskId={task.id} status={task.status} />` in the same position. The panel handles its own visibility logic (only shows content when running), so it can always be rendered. Remove the old placeholder card entirely.

3. **Create `src/__tests__/app/tasks/agent-stream-panel.test.ts`** — Test with mocked EventSource:
   - Set up a mock EventSource class in the test file that allows triggering events programmatically (onmessage, custom events via addEventListener, onerror, close)
   - Test: panel does not create EventSource when status is "done"
   - Test: panel creates EventSource with correct URL when status is "running"
   - Test: panel renders streamed lines when message events are received
   - Test: panel shows connecting status indicator initially
   - Test: panel shows error state on EventSource error
   - Test: panel closes EventSource on unmount
   
   Use `@testing-library/react` for rendering. Mock EventSource globally via `vi.stubGlobal("EventSource", MockEventSource)`.

4. **Verify integration** — Run `npx vitest run` to confirm all tests pass including the new ones and zero regressions from T01/T02.

5. **Verify the placeholder is fully removed** — `grep -r "future update" src/app/tasks/` should return no matches (the old placeholder text is gone).

## Must-Haves

- [ ] `AgentStreamPanel` connects to SSE endpoint via EventSource
- [ ] Panel only activates for tasks with `running` status
- [ ] Connection status indicator shows connecting/streaming/waiting/ended/error states
- [ ] Accumulated text lines render in monospace scrollable area
- [ ] Auto-scroll to bottom on new output
- [ ] EventSource closed on component unmount
- [ ] Old S06 placeholder card removed from task-detail.tsx
- [ ] Tests cover non-running status, streaming, error, and cleanup

## Verification

- `npx vitest run src/__tests__/app/tasks/agent-stream-panel.test.ts` — panel tests pass
- `npx vitest run` — zero regressions across all test files
- `grep -r "future update" src/app/tasks/` returns no matches (placeholder removed)

## Inputs

- `src/app/api/tasks/[id]/stream/route.ts` (from T01) — SSE endpoint that sends `data:` lines and `event: status` events
- `src/app/tasks/[id]/task-detail.tsx` — Current task detail with placeholder card to replace
- `src/components/ui/card.tsx` — Card component for consistent styling
- `src/components/ui/scroll-area.tsx` — ScrollArea component for scrollable container

## Expected Output

- `src/app/tasks/[id]/agent-stream-panel.tsx` — New client component for live streaming
- `src/app/tasks/[id]/task-detail.tsx` — Modified: placeholder replaced with AgentStreamPanel
- `src/__tests__/app/tasks/agent-stream-panel.test.ts` — 5-6 component tests
