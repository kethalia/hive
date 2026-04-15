---
estimated_steps: 30
estimated_files: 2
skills_used: []
---

# T02: Write InteractiveTerminal component integration tests verifying M006 hook wiring and UI state coordination

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

## Inputs

- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/components/terminal-tab-refit.test.tsx`
- `src/__tests__/hooks/useScrollbackHydration.test.ts`
- `src/components/workspaces/TerminalHistoryPanel.tsx`
- `src/components/workspaces/JumpToBottom.tsx`

## Expected Output

- `src/__tests__/integration/interactive-terminal-integration.test.tsx`

## Verification

pnpm vitest run src/__tests__/integration/interactive-terminal-integration.test.tsx && pnpm vitest run
