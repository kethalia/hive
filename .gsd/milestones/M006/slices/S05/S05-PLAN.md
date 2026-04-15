# S05: End-to-End Integration & Regression

**Goal:** Cross-slice integration and regression tests prove the full M006 pipeline works end-to-end — hydration gates live data, scrollback flows from writer through API to xterm, reconnectId lifecycle spans components, and pre-existing terminal features are unbroken.
**Demo:** Run pnpm dev in tmux, close browser, come back next day — full scrollback visible, process still running. All previous terminal features still work.

## Must-Haves

- `pnpm vitest run src/__tests__/integration/` passes with 20+ new tests
- `pnpm vitest run` full suite passes with 0 regressions (474+ frontend tests)
- `cd services/terminal-proxy && pnpm vitest run` passes (88+ proxy tests)
- `pnpm tsc --noEmit` shows no new TypeScript errors
- Cross-slice boundary handoffs are tested: hydration↔WebSocket gating, API format↔hook consumption, reconnectId regeneration↔re-hydration
- Pre-existing session CRUD, tab switching, and rename still work with M006 components mounted

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: no
- Human/UAT required: no

## Integration Closure

- Upstream surfaces consumed: `useScrollbackHydration` (S04), `useTerminalWebSocket` (S02), scrollback API route (S03/S04), `KeepAliveWarning` (S01), `InteractiveTerminal` (S01-S04 wiring), `TerminalTabManager` (M005 base + M006 additions)
- New wiring introduced in this slice: none — tests only, no production code changes
- What remains before the milestone is truly usable end-to-end: nothing — S05 is the final verification slice

## Verification

- Not provided.

## Tasks

- [x] **T01: Write cross-slice data flow integration tests for hydration gating, scrollback format compatibility, and reconnectId lifecycle** `est:45m`
  ## Description

This task writes the highest-value integration tests for M006: tests that prove data flows correctly across component boundaries that individual unit tests mock away.

Three test groups:

1. **Hydration ↔ WebSocket gating** — Prove that when `isGatingLiveData` is true, the WebSocket hook buffers incoming data, and when hydration completes, `flushBufferedData()` drains buffered messages in order before live data resumes. No existing test covers this handoff.

2. **Scrollback API → hydration round-trip** — Prove the API response format (binary concatenated chunks ordered by seqNum) is correctly consumed by the hydration hook and written to xterm via `terminal.write()`. The API tests and hook tests currently mock each other's boundaries.

3. **ReconnectId regeneration → re-hydration trigger** — Prove that when `onReconnectIdExpired` fires (after 3 consecutive failures), a new reconnectId is generated, persisted to localStorage, and causes wsUrl recomputation which triggers fresh hydration.

## Steps

1. Create `src/__tests__/integration/terminal-data-flow.test.ts` with `// @vitest-environment jsdom` header
2. Set up shared mocks: mock `xterm` module (Terminal constructor returning mock with `write`, `dispose`, `onData`, `onResize`, `onScroll`, `loadAddon`, `open` methods), mock `xterm-addon-fit` (FitAddon with `fit`, `dispose`), mock `global.fetch` for scrollback API responses
3. **Test group 1 — Hydration gating**: Import `useTerminalWebSocket` and `useScrollbackHydration` via `renderHook`. Simulate: (a) hydration starts (isGatingLiveData=true), (b) WebSocket messages arrive during hydration, (c) hydration completes (isGatingLiveData=false), (d) verify buffered messages flushed to terminal.write() in order. Test both success path and error path (hydration fails → gating released, buffered data still flushed).
4. **Test group 2 — Format compatibility**: Mock fetch to return binary response matching the format ScrollbackWriter produces (concatenated Uint8Array chunks). Render useScrollbackHydration with a mock terminal ref. Verify terminal.write() receives the correct binary data. Test with multiple chunks, verifying seqNum ordering is preserved.
5. **Test group 3 — ReconnectId lifecycle**: Test `getOrCreateReconnectId` → simulate 3 consecutive WebSocket failures → verify `onReconnectIdExpired` callback fires → verify new UUID in localStorage → verify the new reconnectId would produce a different wsUrl.
6. Run `pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts` and confirm all tests pass

## Must-Haves

- [ ] Hydration gating test proves buffered WebSocket data flushes in order after hydration completes
- [ ] Format compatibility test proves API binary response is correctly written to xterm
- [ ] ReconnectId lifecycle test proves regeneration after 3 failures triggers new localStorage entry
- [ ] All tests pass in jsdom environment without requiring live Postgres or WebSocket server

## Verification

- `pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts` passes with 8+ tests
- `pnpm vitest run` full suite still passes (no regressions)

## Inputs

- `src/hooks/useTerminalWebSocket.ts` — WebSocket hook with isGatingLiveData buffering and flushBufferedData
- `src/hooks/useScrollbackHydration.ts` — Hydration hook with state machine and fetch logic
- `src/components/workspaces/InteractiveTerminal.tsx` — Contains getOrCreateReconnectId helper and reconnectId state management
- `src/app/api/terminal/scrollback/route.ts` — API route format reference (binary concatenation for hydration path)
- `src/__tests__/hooks/useScrollbackHydration.test.ts` — Reference for mock patterns and act() usage
- `src/__tests__/lib/terminal/reconnect.test.ts` — Reference for reconnectId test patterns

## Expected Output

- `src/__tests__/integration/terminal-data-flow.test.ts` — New integration test file with 8+ tests covering cross-slice data flow
  - Files: `src/__tests__/integration/terminal-data-flow.test.ts`, `src/hooks/useTerminalWebSocket.ts`, `src/hooks/useScrollbackHydration.ts`, `src/components/workspaces/InteractiveTerminal.tsx`
  - Verify: pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts && pnpm vitest run

- [ ] **T02: Write InteractiveTerminal component integration tests verifying M006 hook wiring and UI state coordination** `est:45m`
  ## Description

This task renders InteractiveTerminal with mocked dependencies and verifies that M006 hooks are correctly wired to UI elements. No existing test renders InteractiveTerminal and checks that hydration state changes flow through to banners, that scroll position controls history panel visibility, or that connection state banners show attempt counts.

The key challenge is mocking xterm.js (dynamically imported via next/dynamic) and the hooks while keeping enough real wiring to test the integration. Follow the pattern from `terminal-tab-refit.test.tsx` for xterm mocking.

## Steps

1. Create `src/__tests__/integration/interactive-terminal-integration.test.tsx` with `// @vitest-environment jsdom` header
2. Mock `xterm` and `xterm-addon-fit` modules following the pattern in `src/__tests__/components/terminal-tab-refit.test.tsx` — Terminal constructor returns mock with write/dispose/onData/onResize/onScroll/loadAddon/open methods, FitAddon returns mock with fit/dispose
3. Mock `useScrollbackHydration` to return controllable hydrationState and isGatingLiveData values. Mock `useTerminalWebSocket` to return controllable connectionState, reconnectAttempt, consecutiveFailures, and expose send/resize/reconnect/flushBufferedData functions.
4. Mock `useScrollbackPagination` for history panel integration. Mock `@tanstack/react-virtual` useVirtualizer if needed.
5. Mock `next/dynamic` to render InteractiveTerminal synchronously (or mock the dynamic import to return the real component).
6. **Test group 1 — Hydration banners**: Render InteractiveTerminal. Set hydrationState to 'loading' → verify 'Restoring history...' text visible. Set to 'error' → verify 'History unavailable' text visible. Set to 'hydrated' → verify no hydration banner.
7. **Test group 2 — Connection state banners**: Set connectionState to 'reconnecting' with reconnectAttempt=5 → verify reconnecting banner shows attempt count. Set to 'failed' → verify failed banner with Reconnect Now button. Verify clicking Reconnect Now calls reconnect().
8. **Test group 3 — History panel and scroll UX**: Simulate xterm onScroll callback with viewportY=0 → verify history panel becomes visible (showHistoryPanel state). Simulate scroll away from bottom → verify JumpToBottom becomes visible. Click JumpToBottom → verify scroll restored.
9. Run tests and verify all pass with no regressions

## Must-Haves

- [ ] Hydration loading/error/success banners render based on hydrationState
- [ ] Reconnecting banner shows attempt count from useTerminalWebSocket
- [ ] Reconnect Now button calls reconnect() function
- [ ] History panel visibility controlled by scroll position
- [ ] JumpToBottom visibility controlled by isAtBottom state

## Verification

- `pnpm vitest run src/__tests__/integration/interactive-terminal-integration.test.tsx` passes with 8+ tests
- `pnpm vitest run` full suite still passes

## Inputs

- `src/components/workspaces/InteractiveTerminal.tsx` — Component under test, contains all M006 wiring
- `src/__tests__/components/terminal-tab-refit.test.tsx` — Reference for xterm mock setup and ResizeObserver patterns
- `src/__tests__/hooks/useScrollbackHydration.test.ts` — Reference for hydration state values
- `src/components/workspaces/TerminalHistoryPanel.tsx` — History panel component (may need mock)
- `src/components/workspaces/JumpToBottom.tsx` — Jump-to-bottom component

## Expected Output

- `src/__tests__/integration/interactive-terminal-integration.test.tsx` — New integration test file with 8+ tests covering InteractiveTerminal UI state coordination
  - Files: `src/__tests__/integration/interactive-terminal-integration.test.tsx`, `src/components/workspaces/InteractiveTerminal.tsx`
  - Verify: pnpm vitest run src/__tests__/integration/interactive-terminal-integration.test.tsx && pnpm vitest run

- [ ] **T03: Write TerminalTabManager regression tests confirming session CRUD, tab switching, and M006 feature coexistence** `est:40m`
  ## Description

This task adds regression tests to confirm pre-existing terminal tab features (session create, rename, kill, tab switching) still work correctly with M006 components present (KeepAliveWarning, connection badges with reconnection states, reconnectId localStorage cleanup on kill).

The existing `terminal-tab-manager.test.tsx` has 7 tests for base tab functionality but doesn't exercise M006 additions. This task extends coverage without modifying production code.

## Steps

1. Create `src/__tests__/integration/terminal-tab-manager-regression.test.tsx` with `// @vitest-environment jsdom` header
2. Set up mocks following `terminal-tab-manager.test.tsx` patterns: mock `next/dynamic` so InteractiveTerminal renders as a stub div with data-testid, mock server actions (`createSessionAction`, `renameSessionAction`, `killSessionAction`, `getWorkspaceSessionsAction`), mock `useKeepAliveStatus` to return controllable status
3. **Test group 1 — Session CRUD with M006 present**: Render TerminalTabManager. Verify initial session load via `getWorkspaceSessionsAction`. Create new tab → verify `createSessionAction` called. Rename tab → verify `renameSessionAction` called with correct args. Kill tab → verify `killSessionAction` called.
4. **Test group 2 — Tab switching preserves M006 state**: Create multiple tabs. Switch between them. Verify InteractiveTerminal stubs render with correct session props. Verify display:none/block pattern for inactive/active tabs (the mechanism that ResizeObserver responds to).
5. **Test group 3 — KeepAliveWarning integration**: Mock `useKeepAliveStatus` to return `{ consecutiveFailures: 3 }`. Render TerminalTabManager. Verify KeepAliveWarning banner appears above tab bar. Set failures to 0 → verify banner disappears.
6. **Test group 4 — ReconnectId cleanup on kill**: Set a reconnectId in localStorage for a session (`terminal:reconnect:agentId:sessionName`). Kill that session's tab. Verify the localStorage entry is removed (tests the cleanup path that prevents stale reconnectIds from causing hydration attempts to dead sessions).
7. Run tests and verify full suite passes

## Must-Haves

- [ ] Session create/rename/kill still works with M006 components mounted
- [ ] Tab switching renders correct InteractiveTerminal instances
- [ ] KeepAliveWarning renders in TerminalTabManager context at failure threshold
- [ ] ReconnectId localStorage entry cleaned up on tab kill
- [ ] No regressions in existing 474+ test suite

## Verification

- `pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx` passes with 8+ tests
- `pnpm vitest run` full suite passes with 0 regressions
- `pnpm tsc --noEmit` shows no new TypeScript errors

## Inputs

- `src/components/workspaces/TerminalTabManager.tsx` — Component under test
- `src/__tests__/components/terminal-tab-manager.test.tsx` — Reference for existing mock patterns and test structure
- `src/components/workspaces/KeepAliveWarning.tsx` — M006 warning component mounted in tab manager
- `src/hooks/useKeepAliveStatus.ts` — Hook providing keep-alive failure data
- `src/components/workspaces/InteractiveTerminal.tsx` — Child component (mocked as stub)

## Expected Output

- `src/__tests__/integration/terminal-tab-manager-regression.test.tsx` — New regression test file with 8+ tests
  - Files: `src/__tests__/integration/terminal-tab-manager-regression.test.tsx`, `src/components/workspaces/TerminalTabManager.tsx`
  - Verify: pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx && pnpm vitest run && pnpm tsc --noEmit

## Files Likely Touched

- src/__tests__/integration/terminal-data-flow.test.ts
- src/hooks/useTerminalWebSocket.ts
- src/hooks/useScrollbackHydration.ts
- src/components/workspaces/InteractiveTerminal.tsx
- src/__tests__/integration/interactive-terminal-integration.test.tsx
- src/__tests__/integration/terminal-tab-manager-regression.test.tsx
- src/components/workspaces/TerminalTabManager.tsx
