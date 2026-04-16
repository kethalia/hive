---
id: T02
parent: S05
milestone: M006
key_files:
  - src/__tests__/integration/interactive-terminal-integration.test.tsx
  - src/__tests__/components/terminal-tab-refit.test.tsx
key_decisions:
  - Used vi.hoisted() for mock state shared between vi.mock factories and test bodies, enabling per-test control of hook return values without module reimport
  - Mocked TerminalHistoryPanel and JumpToBottom as thin data-attribute stubs to test prop wiring without pulling in their dependency chains (useScrollbackPagination, react-virtual, ansi-to-html)
  - Captured xterm onScroll callback from mock Terminal to test scroll-driven state (showHistoryPanel, isAtBottom) with 150ms wait past the 100ms debounce
duration: 
verification_result: passed
completed_at: 2026-04-15T17:55:47.567Z
blocker_discovered: false
---

# T02: Add InteractiveTerminal component integration tests verifying hydration banners, connection state banners, reconnect button wiring, and scroll-driven history panel/JumpToBottom visibility

**Add InteractiveTerminal component integration tests verifying hydration banners, connection state banners, reconnect button wiring, and scroll-driven history panel/JumpToBottom visibility**

## What Happened

Created `src/__tests__/integration/interactive-terminal-integration.test.tsx` with 10 integration tests across 3 groups:

**Hydration banners (3 tests):** Verifies that hydrationState='loading' renders "Restoring history…", hydrationState='error' renders "History unavailable", and hydrationState='hydrated' shows no banner. Uses controllable mock of useScrollbackHydration via vi.hoisted().

**Connection state banners (3 tests):** Verifies reconnecting state shows attempt count, failed state shows "Connection failed" with Reconnect Now button, and clicking Reconnect Now calls the reconnect() function from useTerminalWebSocket.

**History panel and scroll UX (4 tests):** Captures the xterm onScroll callback from the mock Terminal, then triggers scroll events with controlled buffer.active.viewportY/baseY values. Verifies: history panel becomes visible when viewportY=0 (scrolled to top), JumpToBottom becomes visible when viewportY < baseY (not at bottom), clicking JumpToBottom calls terminal.scrollToBottom() and hides both panel and button, and reconnecting banner's Reconnect Now button triggers reconnect in that state too.

Also fixed pre-existing issues in `terminal-tab-refit.test.tsx` where the mock Terminal was missing `onScroll` and `scrollToBottom` methods (added in M006 but mock not updated), and added missing mocks for `useScrollbackHydration`, `TerminalHistoryPanel`, and `JumpToBottom` that the refit test implicitly depended on through InteractiveTerminal's imports. This eliminated 4 unhandled rejection errors from the full suite.

## Verification

Ran `pnpm vitest run src/__tests__/integration/interactive-terminal-integration.test.tsx` — 10 tests pass in 610ms. Ran `pnpm vitest run` full suite — 62 files, 496 tests pass, 0 errors.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/integration/interactive-terminal-integration.test.tsx` | 0 | ✅ pass | 1170ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 4500ms |

## Deviations

Fixed pre-existing mock gaps in terminal-tab-refit.test.tsx (missing onScroll/scrollToBottom on mock Terminal, missing useScrollbackHydration/TerminalHistoryPanel/JumpToBottom mocks) that were causing 4 unhandled rejection errors in the full suite. This was not in the task plan but necessary for a clean full-suite run.

## Known Issues

none

## Files Created/Modified

- `src/__tests__/integration/interactive-terminal-integration.test.tsx`
- `src/__tests__/components/terminal-tab-refit.test.tsx`
