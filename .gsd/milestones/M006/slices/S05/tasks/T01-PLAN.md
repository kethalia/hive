---
estimated_steps: 30
estimated_files: 4
skills_used: []
---

# T01: Write cross-slice data flow integration tests for hydration gating, scrollback format compatibility, and reconnectId lifecycle

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

## Inputs

- `src/hooks/useTerminalWebSocket.ts`
- `src/hooks/useScrollbackHydration.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/api/terminal/scrollback/route.ts`
- `src/__tests__/hooks/useScrollbackHydration.test.ts`
- `src/__tests__/lib/terminal/reconnect.test.ts`

## Expected Output

- `src/__tests__/integration/terminal-data-flow.test.ts`

## Verification

pnpm vitest run src/__tests__/integration/terminal-data-flow.test.ts && pnpm vitest run
