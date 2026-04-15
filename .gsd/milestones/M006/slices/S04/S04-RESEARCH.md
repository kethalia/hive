# S04: Virtual Scrolling & Hydration UI — Research

**Date:** 2026-04-15
**Depth:** Targeted research — known technology (xterm.js v6, React) but novel integration challenge (virtual scrolling over a terminal emulator with Postgres-backed history)

## Summary

S04 must deliver two capabilities: (1) hydrate scrollback from Postgres into xterm.js when a terminal reconnects, and (2) provide virtual/lazy-loaded scrolling so users can browse 100K+ lines of history without loading everything into browser memory.

xterm.js v6 does **not** support virtual scrolling of its internal buffer. The buffer is a flat array of lines — there is no `prepend()` API, no way to page in older content, and no addon that virtualizes the scrollback. The only write path is `terminal.write()`, which appends sequentially. This means true virtual scrolling of arbitrary history depth requires a **separate scroll region above xterm.js** that renders older chunks as text, with xterm handling only the "live" portion and recent history.

The recommended approach is a **two-zone architecture**: a virtual-scrolled history panel (using `@tanstack/react-virtual`) above the xterm viewport for older chunks, and xterm.js itself for the live buffer (recent history + live stream). Hydration on connect writes recent chunks directly into xterm. Scrolling above xterm's buffer transitions into the history panel, which lazy-loads older chunks from a paginated API. A "Jump to bottom" button appears when scrolled away from live output.

## Recommendation

**Two-zone layout with paginated hydration:**

1. **Hydrate on connect** — fetch recent scrollback (last ~50 chunks) from API, write into xterm via `terminal.write()` before live data flows. This gives immediate context on reconnect.
2. **History panel** — a virtual-scrolled div above xterm that lazy-loads older chunks on scroll-up. Uses `@tanstack/react-virtual` for windowed rendering. Each "row" is a chunk rendered as pre-formatted text.
3. **Paginated API** — extend the existing `/api/terminal/scrollback` route with `cursor` (seqNum) and `limit` params for chunk-based pagination. Add a metadata endpoint or response header for total chunk count.
4. **Jump to bottom** — floating button when user is scrolled away from the live terminal viewport.

This approach respects D025 (custom virtual scroll layer over xterm.js with Postgres-backed chunk loading) while working within xterm.js's constraints. The history panel handles unbounded scrollback; xterm handles the live terminal experience.

**Why not just increase xterm scrollback?** Setting scrollback to 100K+ lines works for hydration but defeats the memory-bounded requirement (R046). Each line in xterm's buffer costs ~200-500 bytes of structured objects, so 100K lines ≈ 20-50MB of JS heap per tab. Virtual scrolling keeps memory bounded regardless of history depth.

**Why not a single virtual list replacing xterm?** xterm.js handles ANSI escape sequences, cursor positioning, alternate screen buffers, and terminal emulation. Replacing it with a plain text virtual list would lose all terminal formatting for the live portion. The two-zone approach preserves full terminal emulation for live content while using lightweight rendering for historical scrollback.

## Implementation Landscape

### Key Files

- `src/components/workspaces/InteractiveTerminal.tsx` (256 lines) — Main terminal component. Needs: hydration fetch on connect, history panel integration, jump-to-bottom button. Currently creates xterm with `scrollback: 10000`, handles reconnectId, renders connection state banners.
- `src/hooks/useTerminalWebSocket.ts` (199 lines) — WebSocket hook. Needs: signal when connection is established so hydration can begin before live data. Currently fires `onData` for all incoming messages.
- `src/app/api/terminal/scrollback/route.ts` (57 lines) — Scrollback API. Needs: pagination support (cursor/limit params), chunk count metadata. Currently returns ALL chunks as single binary blob.
- `src/components/workspaces/TerminalTabManager.tsx` (350 lines) — Tab manager. May need minor updates if history panel affects layout, but mostly unchanged.
- `src/lib/terminal/protocol.ts` — Binary frame protocol. No changes needed — hydration data comes via HTTP, not WebSocket.

### New Files (Expected)

- `src/hooks/useScrollbackHydration.ts` — Hook that fetches scrollback from API on connect, manages hydration state (idle/loading/done/error), writes to xterm.
- `src/components/workspaces/TerminalHistoryPanel.tsx` — Virtual-scrolled history panel using @tanstack/react-virtual. Renders older chunks as pre-formatted text with ANSI-to-HTML conversion.
- `src/hooks/useScrollbackPagination.ts` — Hook for paginated chunk loading with cursor-based fetching, loading states, and cache.
- `src/lib/terminal/ansi-to-html.ts` — Lightweight ANSI escape sequence to HTML converter for rendering historical chunks in the history panel (or use existing library like `ansi-to-html`).

### Build Order

**T01: Paginated scrollback API** — Extend the existing route with `cursor` (seqNum-based) and `limit` query params. Add `X-Total-Chunks` response header. This unblocks both hydration and lazy loading. Low risk, straightforward Prisma query changes.

**T02: Scrollback hydration hook + wiring** — `useScrollbackHydration` hook that fetches recent scrollback on WebSocket connect and writes it to xterm before live data flows. Wire into InteractiveTerminal. This is the highest-value deliverable — even without virtual scrolling, hydration alone restores terminal history on reconnect. Must handle: race condition with live data (hydration must complete before live writes), loading indicator, error state with "History unavailable" banner.

**T03: History panel with virtual scrolling** — Build the TerminalHistoryPanel component using @tanstack/react-virtual. Lazy-loads older chunks via the paginated API. Renders ANSI content as HTML. Appears above xterm when user scrolls to top of xterm's buffer. This is the most complex task — scroll coordination between xterm's viewport and the history panel.

**T04: Jump-to-bottom button + scroll UX polish** — Floating "Jump to bottom" button when scrolled away from live output. Smooth scroll transitions between history panel and live terminal. Loading skeletons for chunks being fetched.

**T01 → T02 → T03 → T04** is the dependency chain. T01 is foundational. T02 is highest value (hydration works without virtual scrolling). T03 is highest complexity. T04 is polish.

### Verification Approach

- **T01**: Unit tests for paginated API — test cursor/limit params, empty results, boundary conditions. Verify backward compatibility (no params = all chunks, existing behavior).
- **T02**: Unit test for hydration hook — mock fetch, verify xterm.write() called with scrollback data before live data. Manual test: connect terminal, run some commands, disconnect, reconnect — verify scrollback appears.
- **T03**: Unit test for history panel rendering — mock chunk data, verify virtual list renders correct visible rows. Manual test: generate 10K+ lines of output, scroll up past xterm buffer — verify history panel appears with lazy-loaded chunks.
- **T04**: Manual test: scroll up, verify jump-to-bottom button appears. Click it, verify smooth scroll to live output. Verify loading skeletons during chunk fetch.
- **Integration**: Run `seq 1 50000` in terminal, close browser, reopen — verify scrollback hydrated and scrollable through full history.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Virtual list rendering | `@tanstack/react-virtual` | Battle-tested windowed rendering, handles dynamic row heights, already found via skill search (283 installs). React-native compatible, tiny bundle. |
| ANSI escape → HTML | `ansi-to-html` npm package | Handles SGR codes (colors, bold, underline), cursor sequences. Writing a correct ANSI parser is error-prone. |

## Constraints

- **xterm.js has no prepend API** — cannot insert content before the existing buffer. Hydration must happen before live data starts flowing, or use the two-zone approach for older history.
- **xterm.js scrollback is in-memory** — setting `scrollback: N` allocates structured line objects for N lines. Memory scales linearly. R046 requires bounded memory regardless of history depth.
- **Binary chunk format** — the API returns raw PTY output (binary). For xterm hydration this is perfect (`terminal.write(data)`). For the history panel, chunks need ANSI-to-HTML conversion since we're rendering in a div, not a terminal emulator.
- **Chunk boundaries don't align to lines** — chunks are batched by time/size in ScrollbackWriter, not by newlines. A single ANSI escape sequence or line could span two chunks. The history panel must handle partial sequences at chunk boundaries.
- **reconnectId is the chunk key** — when reconnectId rotates (after consecutive failures), old scrollback is orphaned under the old ID. Hydration should attempt the current reconnectId first, but may need to fall back to the previous one if the current has no chunks yet.

## Common Pitfalls

- **Hydration race with live data** — If live WebSocket data arrives before hydration fetch completes, the terminal shows live output first, then scrollback appears above it (confusing). Must gate live data writes until hydration completes, or use a two-phase approach: (1) hydrate, (2) open WebSocket.
- **ANSI state across chunk boundaries** — A color escape like `\x1b[31m` (red) at the end of chunk N applies to text in chunk N+1. The history panel must track ANSI state across chunk boundaries or re-parse from the beginning of the visible window. The `ansi-to-html` library handles streaming state if chunks are fed sequentially.
- **Scroll coordination between zones** — The history panel and xterm have independent scroll contexts. Transitioning between them seamlessly (no jump, no gap) requires careful CSS and scroll event handling. The simplest approach: history panel is a fixed-height div that expands on demand, pushing xterm down — but this changes xterm's viewport position. Alternative: overlay approach with absolute positioning.
- **FitAddon re-fit on layout change** — If the history panel changes the terminal container height, FitAddon must re-fit to avoid rendering artifacts. The existing ResizeObserver handles this, but verify it fires when the history panel toggles.

## Open Risks

- **Chunk boundary ANSI parsing** — rendering historical chunks as HTML requires handling ANSI state that spans chunks. If this proves too fragile, fallback option: render historical chunks in a hidden xterm instance and screenshot/serialize the output. This is expensive but guarantees correct rendering.
- **Scroll UX between two zones** — seamless scrolling between a virtual list and xterm.js is novel. If the two-zone scroll feels janky, fallback option: single xterm with large scrollback (50K lines) + hydration, sacrificing memory-bounded guarantee for UX quality. D025 is explicitly revisable for this reason.
- **Large hydration payload** — a session with days of output could have megabytes of scrollback. The paginated API and chunked hydration mitigate this, but the initial hydration (recent N chunks) must be size-bounded to avoid slow reconnects. Recommend capping initial hydration at 500KB or ~50 chunks.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| @tanstack/react-virtual | tanstack-skills/tanstack-skills@tanstack-virtual | available (283 installs) |
| xterm.js | — | none found |
| virtual scrolling (generic) | sickn33/antigravity-awesome-skills@scroll-experience | available (819 installs, but generic — evaluate relevance) |
