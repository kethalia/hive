---
id: T03
parent: S04
milestone: M006
key_files:
  - src/lib/terminal/ansi-to-html.ts
  - src/hooks/useScrollbackPagination.ts
  - src/components/workspaces/TerminalHistoryPanel.tsx
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/app/api/terminal/scrollback/route.ts
  - src/__tests__/hooks/useScrollbackPagination.test.ts
  - src/__tests__/components/TerminalHistoryPanel.test.tsx
  - src/__tests__/app/api/terminal/scrollback/route.test.ts
key_decisions:
  - Extended paginated API path to return JSON with per-chunk seqNum + base64 data instead of concatenated binary — required for cursor-based pagination and per-chunk virtual rendering; non-paginated hydration path unchanged
  - Used dangerouslySetInnerHTML for ANSI-converted HTML output in chunk rows — necessary because ansi-to-html produces HTML strings with inline styles
duration: 
verification_result: passed
completed_at: 2026-04-15T17:33:17.907Z
blocker_discovered: false
---

# T03: Build virtual-scrolled history panel with ANSI rendering, lazy chunk loading, and paginated JSON API

**Build virtual-scrolled history panel with ANSI rendering, lazy chunk loading, and paginated JSON API**

## What Happened

Built the TerminalHistoryPanel component with @tanstack/react-virtual for windowed rendering of scrollback chunks. Created three new modules:

1. **ansi-to-html.ts** — Wrapper around the ansi-to-html library with streaming mode support. Exports `convertChunkToHtml` for one-shot conversion and `createAnsiConverter` factory for stateful streaming across chunk boundaries. Falls back to raw text on conversion errors.

2. **useScrollbackPagination.ts** — Cursor-based backward pagination hook. Manages chunk accumulation, deduplication by seqNum, loading/error states, and hasMore tracking. Uses AbortController with 10s timeout. Fetches from the paginated JSON API endpoint.

3. **TerminalHistoryPanel.tsx** — Virtual-scrolled panel using useVirtualizer. Renders each chunk as a `<pre>` element with ANSI-to-HTML converted content via dangerouslySetInnerHTML. Shows loading indicator at top during fetches, error messages on failure, and "No older history" empty state. Scroll-to-top triggers loadMore, scroll-to-bottom fires onScrollToBottom callback. Styled to match xterm background (#0a0a0a) and font.

**API modification:** Extended the paginated path of `/api/terminal/scrollback` to return JSON with individual chunks (seqNum + base64-encoded data) and totalChunks, instead of concatenated binary. The non-paginated hydration path (used by useScrollbackHydration from T02) remains binary for backward compatibility.

**InteractiveTerminal integration:** Added showHistoryPanel state triggered by xterm's onScroll event when viewportY reaches 0. TerminalHistoryPanel renders above the xterm container. Scrolling to the bottom of the history panel hides it and returns to xterm scroll context.

## Verification

- All 35 tests pass across 3 test files (scrollback API route, pagination hook, history panel component)
- pnpm tsc --noEmit reports 0 new type errors (20 pre-existing errors in unrelated files: council-queues, task-queue, push-queue, cleanup.ts, comment.test)
- Pagination hook tests verify: cursor advancement, chunk accumulation, deduplication by seqNum, hasMore transitions, fetch error handling, non-ok response handling, null reconnectId guard
- History panel tests verify: hidden when not visible, empty state, loading indicator, error display, loadMore triggered on mount, virtual container structure
- API tests updated for JSON response format in paginated path while preserving all backward-compatibility tests for non-paginated path

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/TerminalHistoryPanel.test.tsx` | 0 | ✅ pass | 668ms |
| 2 | `pnpm vitest run src/__tests__/hooks/useScrollbackPagination.test.ts` | 0 | ✅ pass | 589ms |
| 3 | `pnpm vitest run src/__tests__/app/api/terminal/scrollback/route.test.ts` | 0 | ✅ pass | 684ms |
| 4 | `pnpm tsc --noEmit (filtered for new errors)` | 0 | ✅ pass (0 new errors, 20 pre-existing) | 45000ms |

## Deviations

Modified the scrollback API's paginated response format from binary octet-stream to JSON with per-chunk seqNum and base64-encoded data. The original API (T01) returned concatenated binary for both paths, but the pagination hook needs individual chunk boundaries and seqNums for cursor tracking and virtual row rendering. Updated corresponding T01 test cases for the new format.

## Known Issues

Virtual list in jsdom doesn't render actual chunk content due to zero-height containers — component tests verify structure and state rather than rendered text content. Full rendering verification requires browser testing.

## Files Created/Modified

- `src/lib/terminal/ansi-to-html.ts`
- `src/hooks/useScrollbackPagination.ts`
- `src/components/workspaces/TerminalHistoryPanel.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/api/terminal/scrollback/route.ts`
- `src/__tests__/hooks/useScrollbackPagination.test.ts`
- `src/__tests__/components/TerminalHistoryPanel.test.tsx`
- `src/__tests__/app/api/terminal/scrollback/route.test.ts`
