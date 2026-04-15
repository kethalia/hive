---
estimated_steps: 44
estimated_files: 4
skills_used: []
---

# T02: Build scrollback hydration hook and wire into InteractiveTerminal with live-data gating

## Description

This is the highest-value deliverable in the slice — even without virtual scrolling, hydration alone restores terminal history on reconnect. Create a `useScrollbackHydration` hook that fetches recent scrollback from the paginated API when the WebSocket connects, writes it into xterm via `terminal.write()`, and gates live WebSocket data until hydration completes.

The critical race condition: if live WebSocket data arrives before hydration fetch completes, users see live output first and then scrollback appears above it (confusing). The hook must suppress live data writes in `onData` until hydration finishes.

**Architecture:** The hook returns a `hydrationState` (idle | loading | hydrated | error) and a `gateLiveData` boolean. InteractiveTerminal passes `gateLiveData` to the WebSocket hook's onData handler — when true, incoming data is buffered. When hydration completes, buffered data is flushed in order, then live data flows normally.

## Steps

1. Create `src/hooks/useScrollbackHydration.ts` with the hook:
   - Takes `reconnectId: string | null`, `terminalRef: React.RefObject<Terminal | null>`, and `isConnected: boolean`
   - State machine: idle → loading (on connect) → hydrated (on success) / error (on failure)
   - On `isConnected` becoming true with a valid reconnectId: fetch `/api/terminal/scrollback?reconnectId=<id>&limit=50` (recent 50 chunks)
   - On success: call `terminal.write(data)` with the binary response, transition to `hydrated`
   - On error: log warning with reconnectId, transition to `error`, show banner via returned state
   - Returns `{ hydrationState, isGatingLiveData }` — `isGatingLiveData` is true during `loading`
2. Modify `src/hooks/useTerminalWebSocket.ts`:
   - Accept new optional `isGatingLiveData?: boolean` in the hook's options/params
   - In the `onmessage` handler: if `isGatingLiveData` is true, push data into a `bufferedDataRef` array instead of calling `onData`
   - Export a `flushBufferedData` function that writes all buffered data via `onData` and clears the buffer
   - When `isGatingLiveData` transitions from true to false, automatically flush
3. Modify `src/components/workspaces/InteractiveTerminal.tsx`:
   - Import and call `useScrollbackHydration` with reconnectId, terminalRef, and connection state
   - Pass `isGatingLiveData` to `useTerminalWebSocket`
   - Add a subtle loading indicator (e.g., "Restoring history..." text) when hydrationState is `loading`
   - Add an "History unavailable" banner when hydrationState is `error` (use existing banner pattern from connection state banners)
   - Log hydration state transitions to console for diagnostics
4. Write tests in `src/__tests__/hooks/useScrollbackHydration.test.ts`:
   - Mock fetch, verify terminal.write() called with scrollback data
   - Verify hydration completes before live data flows (gate logic)
   - Verify error state when fetch fails
   - Verify no fetch when reconnectId is null
5. Run `pnpm tsc --noEmit` to verify no type errors.

## Must-Haves

- [ ] Hydration fetches recent scrollback on WebSocket connect
- [ ] terminal.write() called with scrollback data before any live data
- [ ] Live data gated (buffered) during hydration loading state
- [ ] Buffered live data flushed in order after hydration completes
- [ ] Error state shows banner, does not block live terminal usage
- [ ] No fetch when reconnectId is null
- [ ] Hydration state transitions logged to console

## Verification

- `pnpm vitest run src/__tests__/hooks/useScrollbackHydration.test.ts` — all hydration tests pass
- `pnpm tsc --noEmit` — no type errors

## Observability Impact

- Signals added: console.log for hydration state transitions (idle→loading→hydrated/error), console.warn on hydration fetch failure with reconnectId
- How a future agent inspects this: browser console filtered by 'hydration', React DevTools for hook state
- Failure state exposed: hydrationState='error' renders visible banner in terminal UI

## Inputs

- ``src/app/api/terminal/scrollback/route.ts` — paginated API from T01 (fetched via HTTP, not imported)`
- ``src/hooks/useTerminalWebSocket.ts` — existing WebSocket hook to modify with gating logic`
- ``src/components/workspaces/InteractiveTerminal.tsx` — existing terminal component to wire hydration into`

## Expected Output

- ``src/hooks/useScrollbackHydration.ts` — new hook managing hydration lifecycle and live-data gating`
- ``src/hooks/useTerminalWebSocket.ts` — modified with buffering support when isGatingLiveData is true`
- ``src/components/workspaces/InteractiveTerminal.tsx` — wired with hydration hook, loading/error banners`
- ``src/__tests__/hooks/useScrollbackHydration.test.ts` — tests for hydration fetch, gating, error states`

## Verification

pnpm vitest run src/__tests__/hooks/useScrollbackHydration.test.ts && pnpm tsc --noEmit
