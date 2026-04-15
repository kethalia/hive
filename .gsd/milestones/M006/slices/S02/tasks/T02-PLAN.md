---
estimated_steps: 40
estimated_files: 3
skills_used: []
---

# T02: Auto-regenerate expired reconnectId after consecutive failures to rejoin tmux session

## Description

This task implements R048: when the upstream Coder API rejects a stale reconnectId (PTY no longer exists), the client should detect this and generate a fresh reconnectId so the new PTY attaches to the same tmux session (tmux session targeting is handled by the `sessionName` parameter, not reconnectId — reconnectId only identifies the PTY within Coder).

The detection strategy: after 3 consecutive failed connection attempts (WebSocket connects then immediately closes, or fails to open), assume the reconnectId is stale and regenerate it. This is simpler and more robust than trying to detect specific close codes, since the proxy forwards upstream codes which may vary.

Key architectural constraint: `reconnectId` is currently initialized in useState and captured in the wsUrl via useEffect closure. To support regeneration, it must become a ref or state that can be updated, and the wsUrl must be recomputed when it changes. The `connect` callback in useTerminalWebSocket already uses the `url` prop — so regenerating reconnectId in InteractiveTerminal and recomputing wsUrl will trigger a new connection cycle.

## Steps

1. In `src/hooks/useTerminalWebSocket.ts`: add a `consecutiveFailuresRef` that increments when a WebSocket closes without ever reaching `onopen` (i.e., `ws.onclose` fires and `attemptRef.current` was not reset to 0 since the last connect call). Reset consecutiveFailuresRef to 0 in `ws.onopen`. Export a `consecutiveFailures: number` value from the hook return. Add an `onReconnectIdExpired?: () => void` callback prop that the hook calls when `consecutiveFailuresRef.current >= 3`. After calling the callback, reset consecutiveFailuresRef to 0 to avoid repeated triggers.
2. In `src/components/workspaces/InteractiveTerminal.tsx`: change `reconnectId` from `useState(() => ...)` to `useState` with a setter. Extract the reconnectId initialization logic into a helper function `getOrCreateReconnectId(agentId, sessionName)`. Add a `handleReconnectIdExpired` callback that: generates a new UUID, updates localStorage with the new id and timestamp, calls `setReconnectId(newId)`. Pass `onReconnectIdExpired={handleReconnectIdExpired}` to `useTerminalWebSocket`. Since `reconnectId` is in the dependency array of the useEffect that builds wsUrl, changing it will trigger wsUrl recomputation and a fresh connection.
3. Add console log `[terminal] Regenerating reconnectId after N consecutive failures` when regeneration occurs.
4. Write tests in `src/__tests__/lib/terminal/reconnect.test.ts`: test `getOrCreateReconnectId` returns cached value within TTL, generates new value when expired, generates new value when localStorage is empty. Test that the helper correctly writes to localStorage.

## Must-Haves

- [ ] After 3 consecutive connection failures, reconnectId is regenerated
- [ ] New reconnectId is persisted to localStorage with fresh timestamp
- [ ] wsUrl is recomputed with the new reconnectId, triggering a fresh connection
- [ ] consecutiveFailures counter resets on successful connection and after regeneration
- [ ] Regeneration is logged to console with [terminal] prefix
- [ ] getOrCreateReconnectId helper is testable in isolation

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| localStorage | Falls back to generating new UUID (existing behavior) | N/A (synchronous) | Catches JSON.parse error, regenerates (existing behavior) |
| Coder PTY API (via proxy) | WebSocket closes → counted as consecutive failure | Same as error | Same — close event fires regardless |

## Negative Tests

- **Boundary conditions**: exactly 2 consecutive failures should NOT trigger regeneration, 3 should. A successful connection between failures resets the counter.
- **Error paths**: corrupted localStorage entry (non-JSON, missing fields) should not crash — falls back to new UUID

## Verification

- `pnpm vitest run src/__tests__/lib/terminal/reconnect.test.ts` passes
- `pnpm tsc --noEmit` passes
- `grep -q 'onReconnectIdExpired' src/hooks/useTerminalWebSocket.ts` returns exit code 0
- `grep -q 'getOrCreateReconnectId' src/components/workspaces/InteractiveTerminal.tsx` returns exit code 0

## Observability Impact

- Signals added/changed: `[terminal] Regenerating reconnectId after N consecutive failures` log line
- How a future agent inspects this: check browser console for regeneration log, inspect localStorage for updated reconnectId entry
- Failure state exposed: consecutiveFailures count available from hook return value

## Inputs

- `src/hooks/useTerminalWebSocket.ts` — T01 output with infinite retry and reconnectAttempt exposed
- `src/components/workspaces/InteractiveTerminal.tsx` — T01 output with reconnecting banner

## Expected Output

- `src/hooks/useTerminalWebSocket.ts` — consecutiveFailures tracking and onReconnectIdExpired callback
- `src/components/workspaces/InteractiveTerminal.tsx` — reconnectId as mutable state, getOrCreateReconnectId helper, handleReconnectIdExpired callback
- `src/__tests__/lib/terminal/reconnect.test.ts` — tests for reconnectId lifecycle and regeneration

## Inputs

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`

## Expected Output

- `src/hooks/useTerminalWebSocket.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/lib/terminal/reconnect.test.ts`

## Verification

pnpm vitest run src/__tests__/lib/terminal/reconnect.test.ts && pnpm tsc --noEmit && grep -q 'onReconnectIdExpired' src/hooks/useTerminalWebSocket.ts
