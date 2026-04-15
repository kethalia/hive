---
id: T02
parent: S04
milestone: M006
key_files:
  - src/hooks/useScrollbackHydration.ts
  - src/hooks/useTerminalWebSocket.ts
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/__tests__/hooks/useScrollbackHydration.test.ts
key_decisions:
  - Used stateRef + closure cancelled flag instead of AbortController for React strict mode compatibility — strict mode double-fires effects, aborting the first fetch; the stateRef reset in cleanup allows the second invocation to proceed correctly
  - Gating implemented via isGatingRef in WebSocket hook rather than modifying onData callback — avoids breaking existing onData consumers and keeps buffering logic encapsulated
duration: 
verification_result: passed
completed_at: 2026-04-15T17:27:14.236Z
blocker_discovered: false
---

# T02: Build useScrollbackHydration hook with live-data gating and wire into InteractiveTerminal

**Build useScrollbackHydration hook with live-data gating and wire into InteractiveTerminal**

## What Happened

Created `useScrollbackHydration` hook that fetches recent scrollback from the paginated API (`/api/terminal/scrollback?reconnectId=<id>&limit=50`) when the terminal connects. The hook implements a state machine (idle → loading → hydrated/error) with console logging at each transition. On success, scrollback data is written to xterm via `terminal.write()` before any live data flows. The hook returns `isGatingLiveData` (true during loading) which gates the WebSocket hook's incoming data.

Modified `useTerminalWebSocket` to accept an `isGatingLiveData` prop. When true, incoming WebSocket messages are buffered in a ref array instead of being passed to `onData`. Added a `flushBufferedData` function and an auto-flush effect that drains the buffer in order when `isGatingLiveData` transitions to false. This ensures scrollback history appears before any live terminal output.

Wired hydration into `InteractiveTerminal`: imports the hook, passes `isGatingLiveData` to the WebSocket hook, and renders a "Restoring history…" banner during loading and a "History unavailable" banner on error (following existing Alert/AlertDescription pattern).

Key implementation detail: the hook uses a `stateRef` + closure `cancelled` flag pattern instead of `AbortController` to handle React strict mode's double-effect firing correctly. In strict mode, the cleanup resets `stateRef` to idle so the second effect invocation can proceed, while the first effect's cancelled flag prevents stale state updates.

## Verification

Ran 9 vitest tests covering: idle state when not connected, no fetch when reconnectId is null, successful fetch with terminal.write(), empty scrollback handling, fetch failure → error state, non-OK response → error state, single-fetch guarantee across rerenders, console log assertions for state transitions, and isGatingLiveData correctness during loading vs hydrated. All 9 pass. TypeScript check shows 20 pre-existing errors (council-queues, task-queue, push-queue, comment.test, cleanup.ts) — zero new errors from T02 files.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/hooks/useScrollbackHydration.test.ts` | 0 | ✅ pass — 9 tests pass | 616ms |
| 2 | `pnpm tsc --noEmit` | 2 | ✅ pass — no new errors, 20 pre-existing errors in council-queues/task-queue/push-queue/comment.test/cleanup.ts | 8000ms |

## Deviations

None

## Known Issues

Pre-existing TypeScript errors in task-queue.ts, council-queues.ts, push-queue.test.ts, comment.test.ts, and cleanup.ts (ioredis version mismatch, WorkspaceWhereUniqueInput type issue) — unrelated to this task.

## Files Created/Modified

- `src/hooks/useScrollbackHydration.ts`
- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/hooks/useScrollbackHydration.test.ts`
