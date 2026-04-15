---
id: S04
parent: M006
milestone: M006
provides:
  - ["Paginated scrollback API (cursor/limit) for virtual scroll consumption", "useScrollbackHydration hook for reconnect history restoration", "TerminalHistoryPanel component for unbounded scrollback browsing", "useScrollbackPagination hook for cursor-based chunk loading", "JumpToBottom floating button for scroll UX"]
requires:
  - slice: S03
    provides: ScrollbackChunk Prisma model and GET /api/terminal/scrollback route
affects:
  []
key_files:
  - (none)
key_decisions:
  - ["D025: Two-zone scroll architecture — history panel above xterm for unbounded scrollback", "D026: Paginated API returns JSON with per-chunk seqNum + base64; hydration path stays binary", "stateRef + cancelled flag pattern for React strict mode async effects (over AbortController)", "dangerouslySetInnerHTML for ANSI-converted HTML in chunk rows — necessary for ansi-to-html library output", "CSS opacity transitions for JumpToBottom and max-height transitions for history panel — enables smooth animations"]
patterns_established:
  - ["Two-zone scroll: TerminalHistoryPanel (virtual scroll, unbounded) above xterm (live + recent hydrated)", "Live-data gating: isGatingLiveData boolean buffers WebSocket data during async hydration, auto-flushes on completion", "Dual response format: single /api/terminal/scrollback route serves binary (hydration) or JSON (pagination) based on query params", "Cursor-based backward pagination: seqNum < cursor, desc order, reverse before return — stable pagination as new chunks arrive"]
observability_surfaces:
  - ["Console: hydration state transitions (idle → loading → hydrated/error)", "Console: warn on hydration fetch failure with reconnectId", "UI: 'Restoring history...' banner during hydration loading", "UI: 'History unavailable' banner on hydration error", "Network: paginated API calls visible with cursor/limit params and X-Total-Chunks header"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-15T17:39:29.513Z
blocker_discovered: false
---

# S04: Virtual Scrolling & Hydration UI

**Delivered virtual-scrolled terminal history panel with ANSI rendering, cursor-based pagination API, scrollback hydration on reconnect, and polished scroll UX with jump-to-bottom and loading skeletons.**

## What Happened

## What This Slice Delivered

S04 builds the browser-side UI for consuming Postgres-backed scrollback (written by S03). It delivers two complementary capabilities: (1) **scrollback hydration** — on WebSocket reconnect, recent history is fetched and written to xterm before any live data flows, so the user sees their terminal exactly as they left it; and (2) **virtual-scrolled history panel** — older scrollback beyond xterm's buffer is rendered in a lazy-loaded panel above xterm, allowing the user to scroll through thousands of lines without loading everything into memory.

### T01: Paginated Scrollback API
Extended `GET /api/terminal/scrollback` with cursor-based backward pagination. Added `cursor` (seqNum to paginate before) and `limit` (default 50, max 200) query params. Added `X-Total-Chunks` response header via parallel count query. Backward compatible: no params returns all chunks ascending (S03 behavior). Input validation returns 400 for malformed params. Installed `@tanstack/react-virtual` and `ansi-to-html` dependencies.

### T02: Scrollback Hydration Hook
Created `useScrollbackHydration` hook implementing a state machine (idle → loading → hydrated/error). On WebSocket connect with a valid reconnectId, fetches recent 50 chunks and writes them to xterm via `terminal.write()`. Modified `useTerminalWebSocket` to accept `isGatingLiveData` — when true, incoming WebSocket data is buffered; on hydration completion, buffered data flushes in order. This prevents the race condition where live data appears before history. Wired into InteractiveTerminal with "Restoring history..." and "History unavailable" banners.

### T03: Virtual-Scrolled History Panel
Built TerminalHistoryPanel with `@tanstack/react-virtual` for windowed rendering. Created `ansi-to-html.ts` wrapper with streaming mode for cross-chunk ANSI state. Created `useScrollbackPagination` hook managing cursor-based backward pagination with deduplication by seqNum. Modified the paginated API path to return JSON with per-chunk objects (seqNum + base64 data) instead of concatenated binary (D026) — the hydration path remains binary. History panel appears when xterm's viewportY reaches 0; scroll-to-top triggers loadMore; scroll-to-bottom returns to xterm context. Styled to match xterm background (#0a0a0a) and monospace font.

### T04: Scroll UX Polish
Added floating JumpToBottom button (shadcn Button + ArrowDown icon) with CSS opacity fade transition. Replaced loading text with pulsing skeleton rows. Added CSS max-height transition for smooth history panel show/hide. Debounced xterm onScroll at 100ms to prevent flicker.

## Patterns Established

- **Two-zone scroll architecture (D025):** History panel handles unbounded scrollback above xterm viewport; xterm handles live terminal + recent hydrated history. The boundary is xterm's viewportY=0.
- **Dual response format API:** Single route, two paths — binary for hydration (bulk write to xterm), JSON with per-chunk metadata for pagination (virtual scroll needs seqNum boundaries).
- **Live-data gating:** Hook returns `isGatingLiveData` boolean consumed by WebSocket hook to buffer incoming data during async hydration. Buffered data flushed in order on completion.
- **stateRef + cancelled flag** for React strict mode safe async effects (avoids AbortController double-fire issues).

## Test Coverage

39 new tests across 5 test files: scrollback API pagination (20), hydration hook (9), history panel (7), jump-to-bottom (3). Full suite: 474 tests across 60 files, all passing. No regressions.

## Verification

## Verification Results

All slice-level must-haves verified:

| Check | Result |
|-------|--------|
| `pnpm vitest run src/__tests__/app/api/terminal/scrollback` | ✅ 20 tests pass |
| `pnpm vitest run src/__tests__/hooks/useScrollbackHydration.test.ts` | ✅ 9 tests pass |
| `pnpm vitest run src/__tests__/components/TerminalHistoryPanel.test.tsx` | ✅ 7 tests pass |
| `pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx` | ✅ 3 tests pass |
| `pnpm vitest run` (full suite) | ✅ 474 tests, 60 files, 0 failures |
| `pnpm tsc --noEmit` | ✅ No new type errors (pre-existing errors in task-queue.ts, cleanup.ts, council-queues.ts are ioredis version mismatch — unrelated) |

### Observability Surfaces Confirmed
- Hydration state transitions logged to console (idle → loading → hydrated/error)
- console.warn on hydration fetch failure with reconnectId
- "Restoring history..." banner during loading state
- "History unavailable" banner on error state
- Network tab shows paginated API calls with cursor/limit params

## Requirements Advanced

- R046 — Virtual scrolling implemented via @tanstack/react-virtual with cursor-based pagination from Postgres. Chunks lazy-loaded on scroll-up, never full history in browser memory. 39 tests pass.
- R047 — Scrollback hydration hook fetches recent chunks on reconnect and writes to xterm before live data. Live-data gating prevents race conditions. Hydration state machine with error recovery.

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

Virtual list in jsdom renders zero-height containers — component tests verify structure and state, not rendered text content. Full rendering verification requires browser testing (covered in UAT). Pre-existing TypeScript errors in task-queue.ts, cleanup.ts, council-queues.ts (ioredis version mismatch) remain unrelated to S04.

## Follow-ups

S05 end-to-end integration testing across the full persistence pipeline (S01-S04). The terminal-tab-refit.test.tsx mock needs onScroll added to suppress unhandled rejection warnings (cosmetic, tests still pass).

## Files Created/Modified

- `src/app/api/terminal/scrollback/route.ts` — Extended with cursor/limit pagination, X-Total-Chunks header, JSON response for paginated path
- `src/hooks/useScrollbackHydration.ts` — New hook: fetches recent scrollback on connect, gates live data during hydration
- `src/hooks/useTerminalWebSocket.ts` — Added isGatingLiveData buffering and auto-flush logic
- `src/hooks/useScrollbackPagination.ts` — New hook: cursor-based backward pagination with deduplication
- `src/lib/terminal/ansi-to-html.ts` — New wrapper: ANSI escape to HTML conversion with streaming mode
- `src/components/workspaces/TerminalHistoryPanel.tsx` — New component: virtual-scrolled history panel with lazy chunk loading
- `src/components/workspaces/JumpToBottom.tsx` — New component: floating jump-to-bottom button with fade animation
- `src/components/workspaces/InteractiveTerminal.tsx` — Wired hydration, history panel, jump-to-bottom, scroll detection
- `package.json` — Added @tanstack/react-virtual and ansi-to-html dependencies
