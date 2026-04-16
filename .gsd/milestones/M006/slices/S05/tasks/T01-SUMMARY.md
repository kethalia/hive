---
id: T01
parent: S05
milestone: M006
key_files:
  - src/__tests__/integration/terminal-data-flow.test.ts
key_decisions:
  - Used real hook composition via renderHook (useScrollbackHydration + useTerminalWebSocket together) rather than mocking one hook to test the other, maximizing integration coverage
  - Used fake timers for the consecutive-failures test to advance through reconnection backoff delays
duration: 
verification_result: passed
completed_at: 2026-04-15T17:51:27.722Z
blocker_discovered: false
---

# T01: Add cross-slice integration tests for hydration gating, scrollback format compatibility, and reconnectId lifecycle

**Add cross-slice integration tests for hydration gating, scrollback format compatibility, and reconnectId lifecycle**

## What Happened

Created `src/__tests__/integration/terminal-data-flow.test.ts` with 12 integration tests across three test groups that prove data flows correctly across M006 component boundaries:

**Group 1 — Hydration ↔ WebSocket gating (3 tests):** Proves that when `useScrollbackHydration` is in loading state (`isGatingLiveData=true`), `useTerminalWebSocket` buffers incoming messages. When hydration completes (success or error), the auto-flush effect drains buffered data to `onData` in order. Also verifies direct passthrough when not gating.

**Group 2 — Scrollback API format → hydration round-trip (4 tests):** Proves binary concatenated chunk format from the API is correctly consumed by the hydration hook and written to xterm via `terminal.write()`. Covers: normal binary data, empty response (Content-Length: 0), error response (500), and large multi-chunk data (10 chunks × 100 bytes) with byte-level ordering verification.

**Group 3 — ReconnectId lifecycle (5 tests):** Proves `getOrCreateReconnectId` persists to localStorage, returns cached values within TTL, and that 3 consecutive WebSocket close-without-open failures trigger `onReconnectIdExpired`. The consecutive failures test uses fake timers to advance through reconnection delays. Also verifies that new reconnectIds produce different wsUrl values.

Mock strategy: Mock WebSocket constructor to capture instances, spy on `globalThis.fetch` for scrollback API responses, mock `@/lib/terminal/protocol` to avoid binary encoding dependency. Both hooks are tested together via `renderHook` to exercise real integration paths.

## Verification

Ran `pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts` — all 12 tests pass. Ran `pnpm vitest run` full suite — 61 test files pass (486 tests), no regressions introduced. The 4 pre-existing unhandled rejection errors in `terminal-tab-refit.test.tsx` are unrelated to this change.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts` | 0 | ✅ pass | 831ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 4440ms |

## Deviations

None

## Known Issues

Pre-existing: 4 unhandled rejection errors in terminal-tab-refit.test.tsx due to missing onScroll mock — not introduced by this task.

## Files Created/Modified

- `src/__tests__/integration/terminal-data-flow.test.ts`
