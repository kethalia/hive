---
estimated_steps: 60
estimated_files: 6
skills_used: []
---

# T03: Build virtual-scrolled history panel with ANSI rendering and lazy chunk loading

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

## Inputs

- ``src/app/api/terminal/scrollback/route.ts` — paginated API with cursor/limit from T01`
- ``src/components/workspaces/InteractiveTerminal.tsx` — modified in T02 with hydration wiring`
- ``src/hooks/useScrollbackHydration.ts` — hydration hook from T02 (coexists, different lifecycle)`
- ``package.json` — @tanstack/react-virtual and ansi-to-html installed in T01`

## Expected Output

- ``src/lib/terminal/ansi-to-html.ts` — ANSI-to-HTML converter wrapper with streaming support`
- ``src/hooks/useScrollbackPagination.ts` — cursor-based pagination hook for lazy chunk loading`
- ``src/components/workspaces/TerminalHistoryPanel.tsx` — virtual-scrolled history panel component`
- ``src/components/workspaces/InteractiveTerminal.tsx` — modified to show history panel on scroll-to-top`
- ``src/__tests__/components/TerminalHistoryPanel.test.tsx` — history panel rendering and loading tests`
- ``src/__tests__/hooks/useScrollbackPagination.test.ts` — pagination hook tests`

## Verification

pnpm vitest run src/__tests__/components/TerminalHistoryPanel.test.tsx && pnpm vitest run src/__tests__/hooks/useScrollbackPagination.test.ts && pnpm tsc --noEmit
