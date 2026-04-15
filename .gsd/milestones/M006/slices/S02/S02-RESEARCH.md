# S02 Research: Infinite Reconnection & Session Continuity

## Summary

The current WebSocket reconnection logic in `useTerminalWebSocket.ts` uses a hard limit of `MAX_RECONNECT_ATTEMPTS = 10` with exponential backoff capped at 30s (`MAX_DELAY_MS = 30000`). When the limit is reached, the state transitions to `"failed"` and the user sees a static "Connection failed after multiple attempts. Refresh the page to try again." alert. The backoff formula (`computeBackoff`) uses base 1000ms, factor 2, jitter +/-500ms, and is already well-structured — the changes needed are: remove the attempt cap, raise the delay cap from 30s to 60s, and add a visible "reconnecting" banner with attempt count/countdown.

The `reconnectId` is generated client-side in `InteractiveTerminal.tsx` using `crypto.randomUUID()` and persisted to `localStorage` with a 24-hour TTL keyed by `terminal:reconnect:{agentId}:{sessionName}`. It is passed as a URL query parameter through the terminal-proxy to the upstream Coder PTY endpoint (`/api/v2/workspaceagents/{agentId}/pty?reconnect={id}`). The proxy (`proxy.ts`) is a stateless pass-through — it validates the reconnectId format but does not track session state itself. When the upstream Coder API rejects an expired/unknown reconnectId, the upstream WebSocket closes, which cascades to the browser. Currently there is no special handling for this case — the client just retries with the same stale reconnectId forever (or until the 10-attempt cap). R048 requires detecting this and generating a fresh reconnectId to create a new PTY on the same tmux session.

Tab switching in `TerminalTabManager.tsx` uses `display: none` / `display: block` with `pointer-events-none` on inactive tabs (line 333-334). Each tab mounts its own `InteractiveTerminal` component which persists in the DOM. The xterm.js Terminal instance has `scrollback: 10000` configured. Since inactive terminals are hidden via CSS (not unmounted), their xterm instances and scrollback buffers remain intact. R052 (tab switching preserves scrollback) should already work by default with this architecture — the main risk is if `FitAddon.fit()` is not called when a tab becomes visible again after being hidden, which could cause rendering glitches but not data loss.

## Recommendation

This slice is well-scoped and can be delivered in 3 focused changes: (1) modify `useTerminalWebSocket.ts` to remove the attempt cap and raise MAX_DELAY_MS to 60000, (2) add a reconnecting banner in `InteractiveTerminal.tsx` and handle expired reconnectId by regenerating it, (3) add a re-fit on tab visibility change in `TerminalTabManager.tsx`. The proxy layer needs no changes.

## Implementation Landscape

### Key Files

| File | Role | Key Functions/Lines |
|------|------|-------------------|
| `src/hooks/useTerminalWebSocket.ts` | WebSocket reconnection logic | `computeBackoff()` (L21-28), `connect()` (L73-140), `MAX_RECONNECT_ATTEMPTS=10` (L18), `MAX_DELAY_MS=30000` (L15), `ws.onclose` handler (L108-135) |
| `src/components/workspaces/InteractiveTerminal.tsx` | Terminal UI + reconnectId management | `reconnectId` state init (L71-91), `connectionBadgeProps()` (L45-60), failed/offline alerts (L201-216), `wsUrl` construction (L168-175) |
| `src/components/workspaces/TerminalTabManager.tsx` | Tab switching + display:none preservation | `SET_ACTIVE` dispatch (L259), tab render with display:none (L330-344), `connStates` tracking (L91-95) |
| `services/terminal-proxy/src/proxy.ts` | Stateless WS proxy to Coder PTY | `handleUpgrade()` (L39-115), `connectUpstream()` (L117-201) — passes reconnectId through, no session state |
| `services/terminal-proxy/src/protocol.ts` | URL builder for upstream PTY | `buildPtyUrl()` (L11-38) — maps `reconnectId` to `reconnect` query param |
| `src/lib/terminal/protocol.ts` | Client-side frame encoding | `encodeInput()`, `encodeResize()` — no changes needed |
| `src/__tests__/lib/terminal/hooks.test.ts` | Existing tests for `computeBackoff` | 8 tests covering backoff math (L1-65) — must update cap expectation from 30000 to 60000 |

### Build Order

**Step 1 — Infinite backoff in `useTerminalWebSocket.ts`**
- Remove `MAX_RECONNECT_ATTEMPTS` constant and the `if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS)` guard (L120-126)
- Change `MAX_DELAY_MS` from `30000` to `60000`
- Remove `"failed"` state transition from the onclose handler (it can never be reached if retries are infinite)
- Keep the `"failed"` ConnectionState type for workspace-offline or future use
- Export `attemptRef.current` or add a `reconnectAttempt` to the return value so the UI can display attempt count
- Update `computeBackoff` tests to expect 60000 cap

**Step 2 — Reconnecting banner in `InteractiveTerminal.tsx`**
- Add a new banner for `connectionState === "reconnecting"` using the existing `Alert` + `AlertDescription` pattern (matching L201-216)
- Display attempt number and/or a countdown timer
- Use yellow/warning styling consistent with `connectionBadgeProps` reconnecting state (bg-yellow-600)
- The `"failed"` banner text should change to indicate the user can wait (since retries are now infinite) or offer a manual "Reconnect Now" button

**Step 3 — Expired reconnectId handling (R048)**
- In `InteractiveTerminal.tsx`, change `reconnectId` from `useState` to `useState` + a setter, or use `useRef` with a forceUpdate
- When the WebSocket closes with a code indicating the upstream rejected the reconnectId (likely 1011 "upstream error" from proxy, or a specific close code), regenerate the reconnectId and update localStorage
- The proxy currently forwards upstream close codes (L168-174 in proxy.ts: `browserWs.close(code, reason)`). Need to identify which close code Coder sends for expired reconnectId — likely 1011 or a 4xxx code
- Alternative simpler approach: after N consecutive failures (e.g., 3), automatically regenerate reconnectId assuming the old PTY is gone

**Step 4 — Tab switch re-fit (R052)**
- In `TerminalTabManager.tsx`, when `activeTabId` changes, call `fitAddon.fit()` on the newly-visible terminal
- This requires exposing a `refit()` method from `InteractiveTerminal` via `useImperativeHandle` / `forwardRef`, or using a prop-based trigger
- Alternatively, add a ResizeObserver inside `InteractiveTerminal` that fires `fit()` when the container becomes visible (simpler, self-contained)

### Verification Approach

1. **Unit tests**: Update `src/__tests__/lib/terminal/hooks.test.ts` — change cap expectation to 60000, add test that `computeBackoff` works for attempt counts > 100
2. **Unit tests**: Add tests for reconnectId regeneration logic
3. **Integration test**: Verify that killing the terminal-proxy process causes the client to show the reconnecting banner and keep retrying, then reconnect when the proxy restarts
4. **Manual test**: Open two terminal tabs, type in both, switch between them, verify scrollback is preserved
5. **Manual test**: Stop the proxy for > 60s, verify banner shows and retries continue indefinitely at 60s intervals

## Constraints

- The terminal-proxy is stateless — it does not track reconnectIds. All session state is managed by the upstream Coder API. This means the proxy cannot tell the client "your reconnectId expired" — it just forwards the upstream close.
- The Coder PTY API uses the `reconnect` query parameter (not `reconnectId`) — the mapping happens in `buildPtyUrl()`.
- `ConnectionState` type already includes `"reconnecting"` — no type changes needed for the banner.
- The `"failed"` state is still useful for workspace-offline scenarios — do not remove it from the type union.

## Common Pitfalls

- **Stale closure in `connect()`**: The `connect` function is a `useCallback` with `[url, updateState, clearReconnectTimer]` deps. Adding reconnectId regeneration must not create a stale closure where the old reconnectId is captured. Using a ref for reconnectId avoids this.
- **Memory leak on unmount**: The cleanup in the `useEffect` (L146-155) nullifies `mountedRef` and clears timers. With infinite retries, it is critical that this cleanup remains correct — otherwise an unmounted component will keep reconnecting forever.
- **FitAddon on hidden elements**: Calling `fit()` on a terminal whose container has `display: none` produces zero dimensions. The re-fit must happen after the container becomes visible.
- **localStorage quota**: The reconnectId entries are small (~80 bytes each) but never cleaned up except on tab kill. Not a practical concern but worth noting.
- **Backoff reset**: `attemptRef.current` is reset to 0 on successful connection (L95). This is correct — after a successful reconnect, the next disconnect starts fresh.
