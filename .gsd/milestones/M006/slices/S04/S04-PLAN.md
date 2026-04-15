# S04: Virtual Scrolling & Hydration UI

**Goal:** Scroll up through thousands of lines of persistent history with lazy loading. Close browser, reopen — full scrollback restored via virtual scroll from Postgres.
**Demo:** Scroll up through thousands of lines of persistent history with lazy loading. Close browser, reopen — full scrollback restored via virtual scroll from Postgres.

## Must-Haves

- `pnpm vitest run src/__tests__/app/api/terminal/scrollback` — paginated API tests pass (cursor/limit params, backward compat, boundary conditions)
- `pnpm vitest run src/__tests__/hooks/useScrollbackHydration.test.ts` — hydration hook tests pass (fetch before live data, gate logic, error states)
- `pnpm vitest run src/__tests__/components/TerminalHistoryPanel.test.tsx` — virtual scroll panel renders chunks, lazy-loads on scroll
- `pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx` — button visibility and scroll behavior
- `pnpm tsc --noEmit` — no type errors across the project
- Hydration state machine transitions logged: idle → loading → hydrated/error

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (browser + Postgres for manual verification)
- Human/UAT required: yes (scroll UX between history panel and live terminal)

## Integration Closure

- Upstream surfaces consumed: `GET /api/terminal/scrollback?reconnectId=...` (S03), `ScrollbackChunk` Prisma model (S03), `useTerminalWebSocket` hook (existing), `InteractiveTerminal` component (existing)
- New wiring introduced in this slice: useScrollbackHydration hook gates live WebSocket data until hydration completes, TerminalHistoryPanel rendered above xterm viewport in InteractiveTerminal, paginated API extends existing route with cursor/limit
- What remains before the milestone is truly usable end-to-end: S05 end-to-end integration testing across the full persistence pipeline

## Verification

- Runtime signals: hydration state transitions (idle/loading/hydrated/error) logged to console, chunk fetch timing, total chunks hydrated count
- Inspection surfaces: browser console logs for hydration lifecycle, network tab for paginated API calls, React DevTools for hydration/pagination hook state
- Failure visibility: hydration error banner in terminal UI, console.warn on fetch failure with reconnectId and error message, pagination error state in hook
- Redaction constraints: reconnectId is a UUID (not sensitive), chunk data is raw PTY output (may contain user commands — no special redaction needed in logs, but don't log chunk contents)

## Tasks

- [x] **T01: Extend scrollback API with cursor-based pagination and install UI dependencies** `est:45m`
  ## Description

The existing scrollback API returns ALL chunks as a single binary blob. S04 needs two capabilities from the API: (1) paginated fetching for the history panel's lazy loading, and (2) a total chunk count for scroll position calculation. This task extends the route with `cursor` (seqNum-based) and `limit` query params, adds an `X-Total-Chunks` response header, and maintains backward compatibility (no params = all chunks, existing behavior).

Also installs `@tanstack/react-virtual` and `ansi-to-html` as project dependencies — both needed by T03.

## Threat Surface

- **Abuse**: cursor/limit params are integers from query string — validate as positive integers, cap limit at 200 to prevent unbounded queries
- **Data exposure**: chunks contain raw PTY output (user commands + output), already scoped by reconnectId — no new exposure
- **Input trust**: cursor and limit are user-supplied query params reaching Prisma query — must validate types

## Negative Tests

- **Malformed inputs**: non-numeric cursor, negative limit, limit=0, cursor pointing to non-existent seqNum
- **Boundary conditions**: cursor at first chunk, cursor at last chunk, limit larger than available chunks, empty result set

## Steps

1. Install `@tanstack/react-virtual` and `ansi-to-html` via pnpm.
2. Modify `src/app/api/terminal/scrollback/route.ts`: parse optional `cursor` (number, seqNum to start BEFORE — for backward pagination) and `limit` (number, default 50, max 200) query params. When cursor is provided, add `where: { seqNum: { lt: cursor } }` to the Prisma query. Always apply `orderBy: { seqNum: 'desc' }` for cursor-based pagination (most recent first), then reverse the result array before concatenation so chunks are in ascending order.
3. Add a separate count query: `prisma.scrollbackChunk.count({ where: { reconnectId } })` and set `X-Total-Chunks` response header.
4. Maintain backward compat: when no cursor/limit params, return all chunks ascending (existing behavior).
5. Update existing tests and add new tests for pagination: cursor/limit combinations, boundary conditions, backward compat, malformed params (non-numeric cursor returns 400), X-Total-Chunks header present.
6. Run `pnpm tsc --noEmit` to verify no type errors.

## Must-Haves

- [ ] cursor param filters chunks by seqNum (less than cursor value, for backward pagination)
- [ ] limit param caps result size (default 50, max 200)
- [ ] X-Total-Chunks header on all successful responses
- [ ] No params = all chunks ascending (backward compatible with S03 behavior)
- [ ] Invalid cursor/limit returns 400
- [ ] @tanstack/react-virtual and ansi-to-html installed

## Verification

- `pnpm vitest run src/__tests__/app/api/terminal/scrollback` — all pagination tests pass
- `pnpm tsc --noEmit` — no type errors
- `node -e "require('@tanstack/react-virtual')"` — dependency installed

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Prisma (count query) | Return 500 with error message | Same as error | N/A (Prisma returns typed results) |
| Query params | Return 400 with validation error | N/A | Return 400 with specific message |
  - Files: `src/app/api/terminal/scrollback/route.ts`, `src/__tests__/app/api/terminal/scrollback/route.test.ts`, `package.json`
  - Verify: pnpm vitest run src/__tests__/app/api/terminal/scrollback && pnpm tsc --noEmit

- [ ] **T02: Build scrollback hydration hook and wire into InteractiveTerminal with live-data gating** `est:1h`
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
  - Files: `src/hooks/useScrollbackHydration.ts`, `src/hooks/useTerminalWebSocket.ts`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/__tests__/hooks/useScrollbackHydration.test.ts`
  - Verify: pnpm vitest run src/__tests__/hooks/useScrollbackHydration.test.ts && pnpm tsc --noEmit

- [ ] **T03: Build virtual-scrolled history panel with ANSI rendering and lazy chunk loading** `est:1h30m`
  ## Description

This is the most complex task — it delivers R046 (virtual scrolling for scrollback). Build a TerminalHistoryPanel component that renders older scrollback chunks in a virtual-scrolled div above xterm. Uses `@tanstack/react-virtual` for windowed rendering and `ansi-to-html` for converting raw PTY data to styled HTML. Chunks are lazy-loaded from the paginated API via a `useScrollbackPagination` hook.

**Two-zone architecture (D025):** The history panel handles unbounded scrollback above xterm's viewport. xterm handles the live terminal + recent history (hydrated in T02). When the user scrolls to the top of xterm's buffer, the history panel becomes visible and starts loading older chunks.

**Chunk boundary challenge:** Chunks are batched by time/size in ScrollbackWriter, not by newlines. ANSI escape sequences can span chunk boundaries. The `ansi-to-html` library handles streaming state when chunks are fed sequentially — use its streaming mode.

## Steps

1. Create `src/lib/terminal/ansi-to-html.ts`:
   - Wrapper around the `ansi-to-html` npm package
   - Export a `convertChunkToHtml(data: Uint8Array): string` function that decodes binary to UTF-8 and converts ANSI escapes to HTML spans with inline styles
   - Use the library's streaming mode to handle state across chunks — export a `createAnsiConverter()` factory that returns a stateful converter instance
2. Create `src/hooks/useScrollbackPagination.ts`:
   - Takes `reconnectId: string | null` and `enabled: boolean`
   - Manages cursor-based backward pagination state: `chunks` array, `isLoading`, `hasMore`, `error`
   - `loadMore()` function: fetches `/api/terminal/scrollback?reconnectId=<id>&cursor=<lowestSeqNum>&limit=50`, prepends results to chunks array, updates cursor
   - Reads `X-Total-Chunks` header to determine `hasMore`
   - Deduplicates chunks by seqNum (in case of overlapping fetches)
3. Create `src/components/workspaces/TerminalHistoryPanel.tsx`:
   - Receives `reconnectId`, `visible` (boolean — shown when user scrolls to top of xterm), and `onScrollToBottom` callback
   - Uses `@tanstack/react-virtual` `useVirtualizer` for the chunk list
   - Each virtual row renders one chunk's HTML via `convertChunkToHtml`, wrapped in a `<pre>` with terminal-matching font/colors (use xterm.css variables where possible)
   - Scroll-to-top triggers `loadMore()` from useScrollbackPagination
   - Loading indicator at top when fetching older chunks
   - Empty state: "No older history available"
   - Match xterm's background color and font for visual continuity
4. Modify `src/components/workspaces/InteractiveTerminal.tsx`:
   - Add state: `showHistoryPanel` (boolean), triggered when xterm viewport is scrolled to the very top
   - Listen to xterm's `onScroll` event — when `terminal.buffer.active.viewportY === 0`, set `showHistoryPanel = true`
   - Render `TerminalHistoryPanel` in a div above the xterm container within the same flex column
   - History panel gets a fixed max-height (e.g., 60% of container) with overflow-y scroll
   - When user scrolls history panel to bottom, transition back to xterm scroll context
   - Ensure FitAddon re-fits when history panel toggles (existing ResizeObserver should handle this)
5. Write tests in `src/__tests__/components/TerminalHistoryPanel.test.tsx`:
   - Mock useScrollbackPagination, verify virtual list renders visible chunks
   - Verify loadMore called on scroll-to-top
   - Verify ANSI conversion produces styled HTML
   - Verify empty state when no chunks
6. Write tests in `src/__tests__/hooks/useScrollbackPagination.test.ts`:
   - Mock fetch, verify cursor advances, chunks accumulate, hasMore updates from X-Total-Chunks
   - Verify deduplication by seqNum
7. Run `pnpm tsc --noEmit`.

## Must-Haves

- [ ] TerminalHistoryPanel renders chunks via @tanstack/react-virtual
- [ ] ANSI escape sequences rendered as styled HTML (colors, bold, underline)
- [ ] Lazy loading: scroll-to-top triggers fetch of older chunks via paginated API
- [ ] History panel appears when xterm scrolled to top of its buffer
- [ ] Visual continuity: history panel matches xterm background/font
- [ ] Loading indicator when fetching older chunks
- [ ] useScrollbackPagination manages cursor state and deduplication

## Verification

- `pnpm vitest run src/__tests__/components/TerminalHistoryPanel.test.tsx` — history panel tests pass
- `pnpm vitest run src/__tests__/hooks/useScrollbackPagination.test.ts` — pagination hook tests pass
- `pnpm tsc --noEmit` — no type errors

## Load Profile

- **Shared resources**: paginated API hits Prisma/Postgres — each loadMore() is one DB query
- **Per-operation cost**: 1 Prisma findMany + 1 count query per page load, ~50 chunks × ~10KB avg = ~500KB per fetch
- **10x breakpoint**: 10 concurrent tabs each scrolling rapidly could generate many parallel queries — mitigated by the pagination limit (50 chunks max per request) and browser's natural request serialization within a single tab

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Paginated API fetch | Show error state in panel, keep existing chunks visible | Abort after 10s, show retry prompt | Ignore malformed chunk, continue with valid chunks |
| ansi-to-html conversion | Fall back to raw text (TextDecoder UTF-8) | N/A (synchronous) | Show raw text |
  - Files: `src/lib/terminal/ansi-to-html.ts`, `src/hooks/useScrollbackPagination.ts`, `src/components/workspaces/TerminalHistoryPanel.tsx`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/__tests__/components/TerminalHistoryPanel.test.tsx`, `src/__tests__/hooks/useScrollbackPagination.test.ts`
  - Verify: pnpm vitest run src/__tests__/components/TerminalHistoryPanel.test.tsx && pnpm vitest run src/__tests__/hooks/useScrollbackPagination.test.ts && pnpm tsc --noEmit

- [ ] **T04: Add jump-to-bottom button, loading skeletons, and scroll UX polish** `est:45m`
  ## Description

Polish the scroll experience with a floating "Jump to bottom" button that appears when the user is scrolled away from live output, loading skeleton placeholders while chunks are being fetched, and smooth transitions between the history panel and live terminal.

This task completes the slice by making the two-zone scroll UX feel cohesive rather than jarring.

## Steps

1. Create a `JumpToBottom` button component (can be inline in InteractiveTerminal or a small separate component at `src/components/workspaces/JumpToBottom.tsx`):
   - Floating button positioned at bottom-right of the terminal container
   - Shows when: user is in the history panel OR xterm is scrolled away from the bottom
   - On click: hide history panel, scroll xterm to bottom (`terminal.scrollToBottom()`)
   - Use shadcn Button component with an arrow-down icon
   - Subtle fade-in/fade-out animation via CSS transition
2. Add loading skeletons to TerminalHistoryPanel:
   - When `isLoading` from useScrollbackPagination is true, render 3-5 skeleton rows at the top of the virtual list
   - Skeleton rows: pulsing gray bars matching terminal line height and approximate width
   - Use Tailwind `animate-pulse` on gray divs
3. Improve scroll transitions in InteractiveTerminal:
   - When history panel hides (user clicks jump-to-bottom or scrolls panel to bottom), smooth transition via CSS `max-height` animation
   - When history panel shows (xterm scrolled to top), expand smoothly rather than popping in
   - Debounce the xterm `onScroll` handler that triggers history panel visibility (100ms) to avoid flicker
4. Write tests in `src/__tests__/components/JumpToBottom.test.tsx`:
   - Button renders when `visible` prop is true, hidden when false
   - onClick callback fires on click
5. Run full test suite: `pnpm vitest run` to verify no regressions.
6. Run `pnpm tsc --noEmit`.

## Must-Haves

- [ ] Jump-to-bottom button visible when scrolled away from live output
- [ ] Button click scrolls to live terminal bottom and hides history panel
- [ ] Loading skeletons shown while chunks are being fetched
- [ ] History panel show/hide transitions are smooth (no layout pop-in)
- [ ] No regressions in existing terminal tests

## Verification

- `pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx` — button tests pass
- `pnpm vitest run` — full test suite passes with no regressions
- `pnpm tsc --noEmit` — no type errors
  - Files: `src/components/workspaces/JumpToBottom.tsx`, `src/components/workspaces/TerminalHistoryPanel.tsx`, `src/components/workspaces/InteractiveTerminal.tsx`, `src/__tests__/components/JumpToBottom.test.tsx`
  - Verify: pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx && pnpm vitest run && pnpm tsc --noEmit

## Files Likely Touched

- src/app/api/terminal/scrollback/route.ts
- src/__tests__/app/api/terminal/scrollback/route.test.ts
- package.json
- src/hooks/useScrollbackHydration.ts
- src/hooks/useTerminalWebSocket.ts
- src/components/workspaces/InteractiveTerminal.tsx
- src/__tests__/hooks/useScrollbackHydration.test.ts
- src/lib/terminal/ansi-to-html.ts
- src/hooks/useScrollbackPagination.ts
- src/components/workspaces/TerminalHistoryPanel.tsx
- src/__tests__/components/TerminalHistoryPanel.test.tsx
- src/__tests__/hooks/useScrollbackPagination.test.ts
- src/components/workspaces/JumpToBottom.tsx
- src/__tests__/components/JumpToBottom.test.tsx
