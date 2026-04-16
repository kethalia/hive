---
id: T01
parent: S02
milestone: M006
key_files:
  - src/hooks/useTerminalWebSocket.ts
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/__tests__/lib/terminal/hooks.test.ts
key_decisions:
  - Kept 'failed' ConnectionState type for workspace-offline and future use — only removed the retry-exhaustion path to failed
  - Used shadcn Alert + Button for reconnecting banner to match existing component patterns
duration: 
verification_result: mixed
completed_at: 2026-04-15T15:01:54.977Z
blocker_discovered: false
---

# T01: Remove retry cap for infinite WebSocket reconnection, raise backoff to 60s, add reconnecting banner with attempt count and Reconnect Now button

**Remove retry cap for infinite WebSocket reconnection, raise backoff to 60s, add reconnecting banner with attempt count and Reconnect Now button**

## What Happened

The hook already had MAX_RECONNECT_ATTEMPTS removed and MAX_DELAY_MS raised to 60000 from a prior session, along with reconnectAttempt and reconnect() exposed in the return interface. The remaining work was in InteractiveTerminal.tsx and the test file.

In InteractiveTerminal.tsx: destructured reconnectAttempt and reconnect from the hook. Added a reconnecting banner (Alert with spinning RefreshCw icon) that displays during connectionState === 'reconnecting' showing the current attempt number. Added a "Reconnect Now" Button to both the reconnecting and failed banners. Updated the failed banner text to indicate retries continue automatically. Imported Button from shadcn and RefreshCw from lucide-react.

In the test file: updated the "caps at max delay" test from 30000 to 60000. Extended the backoff sequence to include 32000 and 60000. Added two new tests for attempt=50 and attempt=100 confirming they cap at 60000.

## Verification

All 10 computeBackoff tests pass. grep confirms MAX_RECONNECT_ATTEMPTS is absent from the hook (exit 1) and 60000 is present (exit 0). tsc errors are pre-existing in unrelated files (task-queue.ts, cleanup.ts).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts` | 0 | ✅ pass | 163ms |
| 2 | `pnpm tsc --noEmit` | 2 | ⚠️ pre-existing errors in task-queue.ts/cleanup.ts only | 12000ms |
| 3 | `grep -q MAX_RECONNECT_ATTEMPTS src/hooks/useTerminalWebSocket.ts` | 1 | ✅ pass (constant removed) | 5ms |
| 4 | `grep -q 60000 src/hooks/useTerminalWebSocket.ts` | 0 | ✅ pass | 5ms |

## Deviations

Hook changes (remove MAX_RECONNECT_ATTEMPTS, raise MAX_DELAY_MS, expose reconnectAttempt/reconnect) were already done in a prior session. This execution focused on the InteractiveTerminal banner UI and test updates.

## Known Issues

Pre-existing tsc errors in src/lib/queue/task-queue.ts and src/lib/workspace/cleanup.ts (ioredis version mismatch, Prisma type issues) — unrelated to this task.

## Files Created/Modified

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/lib/terminal/hooks.test.ts`
