---
estimated_steps: 38
estimated_files: 3
skills_used: []
---

# T01: Remove retry cap, raise backoff to 60s, add reconnecting banner with attempt count

## Description

This task implements R044: infinite WebSocket reconnection with visual feedback. Three changes: (1) remove MAX_RECONNECT_ATTEMPTS and the guard that transitions to "failed" state in useTerminalWebSocket.ts, (2) raise MAX_DELAY_MS from 30000 to 60000, (3) expose reconnectAttempt count from the hook and display a reconnecting banner in InteractiveTerminal.tsx with attempt number and a manual "Reconnect Now" button.

The "failed" ConnectionState type is kept for workspace-offline and future use — only the retry-exhaustion path to "failed" is removed. The cleanup in useEffect must remain correct since infinite retries mean an unmounted component could leak if mountedRef isn't checked.

## Steps

1. In `src/hooks/useTerminalWebSocket.ts`: remove the `MAX_RECONNECT_ATTEMPTS` constant. Remove the `if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS)` block (lines 120-126) from ws.onclose. Change `MAX_DELAY_MS` from `30000` to `60000`. Add `reconnectAttempt: number` to the `UseTerminalWebSocketReturn` interface and return `attemptRef.current` from the hook. Remove the log line that references `MAX_RECONNECT_ATTEMPTS`.
2. In `src/components/workspaces/InteractiveTerminal.tsx`: destructure `reconnectAttempt` from `useTerminalWebSocket`. Add a reconnecting banner (using existing Alert/AlertDescription pattern) that shows when `connectionState === 'reconnecting'` — display attempt number. Add a "Reconnect Now" button to the "failed" banner that resets the connection (this requires exposing a `reconnect` function from the hook — add `reconnect: () => void` to UseTerminalWebSocketReturn that calls `connect()` after resetting attemptRef). Change the "failed" banner text to indicate retries will continue automatically or the user can click to retry immediately.
3. In `src/__tests__/lib/terminal/hooks.test.ts`: change the "caps at max delay of 30s" test to expect 60000 instead of 30000. Update the backoff sequence test's expected array to end at 60000. Add a test that computeBackoff works correctly for attempt=50 (should still return 60000). Add a test for attempt=100.

## Must-Haves

- [ ] MAX_RECONNECT_ATTEMPTS removed — no code path transitions to "failed" from retry exhaustion
- [ ] MAX_DELAY_MS is 60000
- [ ] reconnectAttempt exposed from hook and displayed in reconnecting banner
- [ ] "Reconnect Now" button available during both reconnecting and failed states
- [ ] All existing backoff tests updated and passing with new cap
- [ ] Cleanup in useEffect still prevents reconnection after unmount

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| WebSocket server | Triggers onclose → infinite retry with backoff | Same as error — onclose fires | Same — binary/text mismatch handled by onmessage |

## Negative Tests

- **Boundary conditions**: attempt=0 returns base delay, attempt=100 returns capped 60000, attempt after successful reconnect resets to 0
- **Error paths**: unmounted component does not schedule reconnect timers

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts` passes with updated expectations
- `pnpm tsc --noEmit` passes
- `grep -q 'MAX_RECONNECT_ATTEMPTS' src/hooks/useTerminalWebSocket.ts` returns exit code 1 (constant removed)
- `grep -q '60000' src/hooks/useTerminalWebSocket.ts` returns exit code 0

## Observability Impact

- Signals added/changed: `[terminal] Reconnect attempt N` log no longer shows `/MAX` denominator; reconnectAttempt count visible in UI banner
- How a future agent inspects this: check browser console for `[terminal]` prefix logs, inspect ConnectionState badge in tab bar
- Failure state exposed: attempt count in banner, connection state in badge

## Inputs

- `src/hooks/useTerminalWebSocket.ts` — current reconnection logic with MAX_RECONNECT_ATTEMPTS=10 and MAX_DELAY_MS=30000
- `src/components/workspaces/InteractiveTerminal.tsx` — current terminal UI with failed/offline alerts
- `src/__tests__/lib/terminal/hooks.test.ts` — existing computeBackoff tests expecting 30000 cap

## Expected Output

- `src/hooks/useTerminalWebSocket.ts` — infinite retry, 60s cap, reconnectAttempt and reconnect() exposed
- `src/components/workspaces/InteractiveTerminal.tsx` — reconnecting banner with attempt count and Reconnect Now button
- `src/__tests__/lib/terminal/hooks.test.ts` — updated tests for 60000 cap and high attempt counts

## Inputs

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/lib/terminal/hooks.test.ts`

## Expected Output

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/lib/terminal/hooks.test.ts`

## Verification

pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts && pnpm tsc --noEmit && ! grep -q 'MAX_RECONNECT_ATTEMPTS' src/hooks/useTerminalWebSocket.ts && grep -q '60000' src/hooks/useTerminalWebSocket.ts
