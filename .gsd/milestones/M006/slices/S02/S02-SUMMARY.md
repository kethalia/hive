---
id: S02
parent: M006
milestone: M006
provides:
  - ["infinite-websocket-reconnection", "reconnectid-auto-regeneration", "tab-visibility-refit"]
requires:
  []
affects:
  []
key_files:
  - ["src/hooks/useTerminalWebSocket.ts", "src/components/workspaces/InteractiveTerminal.tsx", "src/__tests__/lib/terminal/hooks.test.ts", "src/__tests__/lib/terminal/reconnect.test.ts", "src/__tests__/components/terminal-tab-refit.test.tsx"]
key_decisions:
  - ["Kept 'failed' ConnectionState type for workspace-offline and future use — only removed the retry-exhaustion path to failed", "Used consecutive-close-without-open counting (3 threshold) rather than inspecting WebSocket close codes for reconnectId expiry detection — more robust since proxy may forward varying upstream codes", "Replaced window resize listener with ResizeObserver — handles both window resizes and tab visibility transitions in a single mechanism, avoiding double-fit"]
patterns_established:
  - ["ResizeObserver for xterm.js re-fit on visibility changes — use this pattern for any future terminal container dimension changes instead of window resize listeners", "Exported getOrCreateReconnectId helper for testable localStorage lifecycle management — extract localStorage access patterns as pure functions for unit testing"]
observability_surfaces:
  - ["[terminal] Reconnect attempt N — logged on every reconnection attempt (no max denominator)", "[terminal] Regenerating reconnectId after N consecutive failures — logged when stale reconnectId is replaced", "Reconnecting banner with attempt count visible in terminal UI", "connectionBadgeProps exposes ConnectionState in tab bar", "consecutiveFailures count available from useTerminalWebSocket hook return"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-15T15:10:15.859Z
blocker_discovered: false
---

# S02: Infinite Reconnection & Session Continuity

**WebSocket reconnection never gives up (infinite retries, 60s backoff cap), reconnectId auto-regenerates after 3 consecutive failures, and ResizeObserver-based tab re-fit preserves scrollback rendering across tab switches.**

## What Happened

## T01: Infinite Retry with Reconnecting Banner

Removed the MAX_RECONNECT_ATTEMPTS constant and the guard that transitioned to "failed" state on retry exhaustion in `useTerminalWebSocket.ts`. Raised MAX_DELAY_MS from 30000 to 60000 for a 60-second backoff cap. Exposed `reconnectAttempt` count and `reconnect()` function from the hook return interface.

In `InteractiveTerminal.tsx`, added a reconnecting banner (shadcn Alert with spinning RefreshCw icon) that displays during `connectionState === 'reconnecting'` showing the current attempt number. Added a "Reconnect Now" Button to both the reconnecting and failed state banners. The "failed" ConnectionState type was kept for workspace-offline and future use — only the retry-exhaustion path was removed.

Updated all computeBackoff tests to expect the new 60000ms cap. Added tests for high attempt counts (50, 100) confirming they cap correctly. All 10 tests pass.

## T02: ReconnectId Auto-Regeneration

Added consecutive failure tracking to `useTerminalWebSocket`: an `openedRef` flag tracks whether `onopen` fired for each connection attempt, and `consecutiveFailuresRef` increments on each close-without-open. When the threshold (3) is reached, the hook calls the `onReconnectIdExpired` callback and resets the counter.

Extracted `getOrCreateReconnectId(agentId, sessionName)` as an exported helper for testability. Changed `reconnectId` from immutable useState to mutable state with a setter. The `handleReconnectIdExpired` callback generates a fresh UUID, persists it to localStorage with a fresh timestamp, and updates state — triggering wsUrl recomputation via the existing useEffect dependency array.

Created 7 tests covering: empty localStorage, cached value within TTL, expired TTL, corrupted JSON, missing fields, different agent/session keys, and timestamp persistence.

## T03: ResizeObserver-Based Tab Re-Fit

Replaced the `window.addEventListener('resize', handleResize)` listener with a `ResizeObserver` on the terminal container element. The observer fires whenever the container's dimensions change — covering both window resizes and tab visibility transitions (display:none → display:block). The callback only calls `fitAddon.fit()` when observed dimensions are non-zero, preventing corrupted terminal state from fitting against a hidden container.

This naturally handles the TerminalTabManager's display:none/block tab switching pattern. The observer is disconnected on component unmount to prevent leaks.

Created 4 tests covering: fit() called on non-zero dimensions, fit() NOT called on 0×0, observer disconnected on unmount, and observer targets the container element.

## Verification

## Slice-Level Verification

All 21 S02 tests pass across 3 test files:
- `src/__tests__/lib/terminal/hooks.test.ts` — 10 tests (backoff cap at 60000, high attempt counts)
- `src/__tests__/lib/terminal/reconnect.test.ts` — 7 tests (reconnectId lifecycle, regeneration, localStorage edge cases)
- `src/__tests__/components/terminal-tab-refit.test.tsx` — 4 tests (ResizeObserver-based re-fit behavior)

Grep assertions confirmed:
- MAX_RECONNECT_ATTEMPTS absent from useTerminalWebSocket.ts
- 60000 present in useTerminalWebSocket.ts
- onReconnectIdExpired present in useTerminalWebSocket.ts
- getOrCreateReconnectId present in InteractiveTerminal.tsx
- ResizeObserver present in InteractiveTerminal.tsx

`pnpm tsc --noEmit` — 20 pre-existing errors in unrelated files (council-queues.ts, task-queue.ts, comment.test.ts, push-queue.test.ts — all ioredis version mismatch). Zero errors from S02 files. These errors exist identically on main branch.

## Requirements Advanced

- R044 — Infinite retries with exponential backoff capped at 60s, reconnecting banner with attempt count and Reconnect Now button — no retry exhaustion path to failed state
- R048 — After 3 consecutive connection failures, reconnectId auto-regenerates with fresh UUID persisted to localStorage, triggering wsUrl recomputation to rejoin the same tmux session
- R052 — ResizeObserver on terminal container calls fit() when transitioning from hidden to visible, preserving scrollback rendering across tab switches

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None.

## Known Limitations

20 pre-existing TypeScript errors in unrelated files (council-queues.ts, task-queue.ts, comment.test.ts, push-queue.test.ts) cause `pnpm tsc --noEmit` to exit non-zero. These are ioredis version mismatch issues on main branch — not introduced by S02.

## Follow-ups

S03 (Scrollback Persistence Backend) is next — writes terminal output to Postgres in real-time chunks. S04 (Virtual Scrolling) depends on S03. S05 (End-to-End Integration) depends on all prior slices.

## Files Created/Modified

- `src/hooks/useTerminalWebSocket.ts` — Removed retry cap, raised backoff to 60s, exposed reconnectAttempt/reconnect(), added consecutiveFailures tracking and onReconnectIdExpired callback
- `src/components/workspaces/InteractiveTerminal.tsx` — Added reconnecting banner with attempt count, Reconnect Now button, getOrCreateReconnectId helper, reconnectId regeneration handler, ResizeObserver for tab re-fit
- `src/__tests__/lib/terminal/hooks.test.ts` — Updated backoff cap tests to 60000, added high-attempt-count tests
- `src/__tests__/lib/terminal/reconnect.test.ts` — New: 7 tests for reconnectId lifecycle and localStorage edge cases
- `src/__tests__/components/terminal-tab-refit.test.tsx` — New: 4 tests for ResizeObserver-based re-fit behavior
