---
id: T02
parent: S02
milestone: M006
key_files:
  - src/hooks/useTerminalWebSocket.ts
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/__tests__/lib/terminal/reconnect.test.ts
key_decisions:
  - Used consecutive-close-without-open counting (3 threshold) rather than inspecting WebSocket close codes — more robust since proxy may forward varying upstream codes
  - Extracted getOrCreateReconnectId as exported function for testability rather than testing through React component rendering
duration: 
verification_result: passed
completed_at: 2026-04-15T15:05:02.878Z
blocker_discovered: false
---

# T02: Auto-regenerate expired reconnectId after 3 consecutive WebSocket failures to rejoin tmux session

**Auto-regenerate expired reconnectId after 3 consecutive WebSocket failures to rejoin tmux session**

## What Happened

Added consecutive failure tracking to `useTerminalWebSocket`: an `openedRef` flag tracks whether `onopen` fired for each connection attempt, and `consecutiveFailuresRef` increments on each close-without-open. When the threshold (3) is reached, the hook calls `onReconnectIdExpired` and resets the counter.

In `InteractiveTerminal`, extracted the reconnectId initialization logic into an exported `getOrCreateReconnectId(agentId, sessionName)` helper. Changed `reconnectId` from immutable `useState` to mutable state with a setter. Added `handleReconnectIdExpired` callback that generates a fresh UUID, persists it to localStorage with a fresh timestamp, and updates state — which triggers wsUrl recomputation via the existing useEffect dependency array, starting a fresh connection cycle.

Both the hook and the component log regeneration events with `[terminal]` prefix for observability.

Created 7 tests in `reconnect.test.ts` covering: empty localStorage, cached value within TTL, expired TTL, corrupted JSON, missing fields, different agent/session keys, and timestamp persistence.

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/reconnect.test.ts` — 7/7 tests pass
- `pnpm vitest run src/__tests__/lib/terminal/` — all 30 terminal tests pass (hooks, protocol, reconnect)
- `pnpm tsc --noEmit` — no errors in task files (20 pre-existing errors in unrelated council-queues/test files)
- `grep -q 'onReconnectIdExpired' src/hooks/useTerminalWebSocket.ts` — PASS
- `grep -q 'getOrCreateReconnectId' src/components/workspaces/InteractiveTerminal.tsx` — PASS

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/reconnect.test.ts` | 0 | ✅ pass | 626ms |
| 2 | `pnpm vitest run src/__tests__/lib/terminal/` | 0 | ✅ pass | 644ms |
| 3 | `pnpm tsc --noEmit (filtered to task files)` | 0 | ✅ pass — no errors in task files | 15000ms |
| 4 | `grep -q 'onReconnectIdExpired' src/hooks/useTerminalWebSocket.ts` | 0 | ✅ pass | 5ms |
| 5 | `grep -q 'getOrCreateReconnectId' src/components/workspaces/InteractiveTerminal.tsx` | 0 | ✅ pass | 5ms |

## Deviations

None — implementation followed the task plan as specified.

## Known Issues

20 pre-existing TypeScript errors in unrelated files (src/lib/queue/council-queues.ts, src/lib/queue/task-queue.ts, src/lib/workspace/cleanup.ts, and two test files) cause `pnpm tsc --noEmit` to exit non-zero. These are ioredis version mismatch issues unrelated to this task.

## Files Created/Modified

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/lib/terminal/reconnect.test.ts`
