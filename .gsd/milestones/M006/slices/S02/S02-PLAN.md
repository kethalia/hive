# S02: Infinite Reconnection & Session Continuity

**Goal:** WebSocket reconnection never gives up (infinite retries with exponential backoff capped at 60s), a visible reconnecting banner shows attempt count, expired reconnectIds are auto-regenerated to rejoin the same tmux session, and tab switching preserves all scrollback without rendering glitches.
**Demo:** Disconnect network, reconnect — terminal resumes seamlessly with reconnecting banner, no manual refresh needed. Tab switching preserves all scrollback.

## Must-Haves

- ## Must-Haves
- Infinite retry with exponential backoff capped at 60s — no attempt limit, no permanent "failed" state from retry exhaustion (R044)
- Reconnecting banner appears during reconnection with attempt count and manual "Reconnect Now" button (R044)
- After 3 consecutive failed reconnections with the same reconnectId, auto-regenerate a fresh reconnectId and update localStorage so the new PTY attaches to the same tmux session (R048)
- Tab switching calls fit() on the newly-visible terminal so scrollback renders correctly with no data loss (R052)
- All existing tests pass; new tests cover 60s backoff cap, high attempt counts, reconnectId regeneration logic, and tab re-fit behavior
- ## Threat Surface
- **Abuse**: reconnectId is a client-generated UUID passed as a query parameter — no privilege escalation risk since it maps to a user-scoped PTY. Rapid reconnection attempts are self-throttled by exponential backoff.
- **Data exposure**: reconnectId stored in localStorage with 24h TTL — same-origin only, no PII, no tokens
- **Input trust**: reconnectId is validated as UUID format by the proxy before forwarding to Coder API — no injection surface
- ## Requirement Impact
- **Requirements touched**: R044, R048, R052
- **Re-verify**: WebSocket connection lifecycle (connect, disconnect, reconnect), terminal tab switching, reconnectId localStorage management
- **Decisions revisited**: none (D023 is being implemented, not revisited)
- ## Proof Level
- This slice proves: integration
- Real runtime required: yes (WebSocket reconnection behavior requires a running terminal-proxy)
- Human/UAT required: yes (visual banner appearance, tab switching scrollback)
- ## Verification
- `pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts` — backoff cap at 60000, high attempt counts work
- `pnpm vitest run src/__tests__/lib/terminal/reconnect.test.ts` — reconnectId regeneration after consecutive failures
- `pnpm vitest run src/__tests__/components/terminal-tab-refit.test.ts` — tab visibility triggers fit()
- `pnpm tsc --noEmit` — no type errors
- Manual: disconnect network, observe reconnecting banner with attempt count, reconnect — terminal resumes
- Manual: switch between two terminal tabs, verify scrollback preserved in both
- ## Observability / Diagnostics
- Runtime signals: `[terminal] Connection state: reconnecting`, `[terminal] Reconnect attempt N` (no cap logged), `[terminal] Regenerating reconnectId after N consecutive failures`
- Inspection surfaces: browser console logs with `[terminal]` prefix, ConnectionState exposed via `connectionBadgeProps` in UI
- Failure visibility: attempt count visible in reconnecting banner, connection state badge in tab bar
- Redaction constraints: none (reconnectId is a UUID, not a secret)
- ## Integration Closure
- Upstream surfaces consumed: `useTerminalWebSocket` hook (reconnection logic), `InteractiveTerminal` component (UI + reconnectId), `TerminalTabManager` (tab switching)
- New wiring introduced in this slice: reconnectAttempt count exposed from hook to UI, reconnectId regeneration callback, ResizeObserver for tab visibility
- What remains before the milestone is truly usable end-to-end: S03 (scrollback persistence to Postgres), S04 (virtual scrolling), S05 (server-side keep-alive robustness)

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: Remove retry cap, raise backoff to 60s, add reconnecting banner with attempt count** `est:1h`
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
  - Files: `src/hooks/useTerminalWebSocket.ts`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/__tests__/lib/terminal/hooks.test.ts`
  - Verify: pnpm vitest run src/__tests__/lib/terminal/hooks.test.ts && pnpm tsc --noEmit && ! grep -q 'MAX_RECONNECT_ATTEMPTS' src/hooks/useTerminalWebSocket.ts && grep -q '60000' src/hooks/useTerminalWebSocket.ts

- [ ] **T02: Auto-regenerate expired reconnectId after consecutive failures to rejoin tmux session** `est:1h`
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
  - Files: `src/hooks/useTerminalWebSocket.ts`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/__tests__/lib/terminal/reconnect.test.ts`
  - Verify: pnpm vitest run src/__tests__/lib/terminal/reconnect.test.ts && pnpm tsc --noEmit && grep -q 'onReconnectIdExpired' src/hooks/useTerminalWebSocket.ts

- [ ] **T03: Add ResizeObserver-based re-fit on tab visibility to preserve scrollback rendering** `est:45m`
  ## Description

This task implements R052: tab switching preserves scrollback in both tabs with no rendering glitches. The DOM architecture already preserves terminal instances (display:none instead of unmount), so scrollback data is retained. The issue is that when a tab becomes visible again, xterm.js may not re-render correctly because FitAddon.fit() was never called after the container transitioned from display:none to display:block.

The solution is a ResizeObserver inside InteractiveTerminal that watches the container element. When the container's dimensions change from 0x0 (hidden) to non-zero (visible), call fitAddon.fit(). This is self-contained within InteractiveTerminal — no changes needed to TerminalTabManager.

Key constraint: calling fit() on a terminal whose container has display:none produces zero dimensions and can corrupt the terminal state. The ResizeObserver approach naturally avoids this because it only fires when dimensions actually change, and we only call fit() when the new dimensions are non-zero.

## Steps

1. In `src/components/workspaces/InteractiveTerminal.tsx`: inside the async useEffect that initializes the terminal (after `term.open(containerRef.current)`), add a ResizeObserver on `containerRef.current`. In the observer callback, check if the observed entry's `contentRect.width > 0 && contentRect.height > 0`, and if so, call `fitRef.current?.fit()`. Store the observer in a ref or local variable and disconnect it in the cleanup function.
2. Remove or keep the existing `window.addEventListener('resize', handleResize)` — the ResizeObserver will handle both window resizes and tab visibility changes, so the window resize listener is redundant. However, keeping it is harmless and provides a fallback. Decision: remove it to avoid double-fitting on window resize.
3. Write tests in `src/__tests__/components/terminal-tab-refit.test.ts`: mock ResizeObserver, verify that when the observer callback fires with non-zero dimensions, fit() is called. Verify that when dimensions are 0x0, fit() is NOT called.

## Must-Haves

- [ ] ResizeObserver attached to terminal container element
- [ ] fit() called when container transitions from hidden to visible (non-zero dimensions)
- [ ] fit() NOT called when container has zero dimensions
- [ ] Observer disconnected on component unmount (no leak)
- [ ] Tab switching between two terminals preserves scrollback in both

## Verification

- `pnpm vitest run src/__tests__/components/terminal-tab-refit.test.ts` passes
- `pnpm tsc --noEmit` passes
- `grep -q 'ResizeObserver' src/components/workspaces/InteractiveTerminal.tsx` returns exit code 0

## Inputs

- `src/components/workspaces/InteractiveTerminal.tsx` — T02 output with reconnectId regeneration
- `src/components/workspaces/TerminalTabManager.tsx` — tab switching with display:none/block (read-only reference, no changes needed)

## Expected Output

- `src/components/workspaces/InteractiveTerminal.tsx` — ResizeObserver for tab visibility re-fit
- `src/__tests__/components/terminal-tab-refit.test.ts` — tests for ResizeObserver-based re-fit behavior
  - Files: `src/components/workspaces/InteractiveTerminal.tsx`, `src/__tests__/components/terminal-tab-refit.test.ts`
  - Verify: pnpm vitest run src/__tests__/components/terminal-tab-refit.test.ts && pnpm tsc --noEmit && grep -q 'ResizeObserver' src/components/workspaces/InteractiveTerminal.tsx

## Files Likely Touched

- src/hooks/useTerminalWebSocket.ts
- src/components/workspaces/InteractiveTerminal.tsx
- src/__tests__/lib/terminal/hooks.test.ts
- src/__tests__/lib/terminal/reconnect.test.ts
- src/__tests__/components/terminal-tab-refit.test.ts
