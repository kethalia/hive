---
id: T04
parent: S04
milestone: M006
key_files:
  - src/components/workspaces/JumpToBottom.tsx
  - src/components/workspaces/TerminalHistoryPanel.tsx
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/__tests__/components/JumpToBottom.test.tsx
  - src/__tests__/components/TerminalHistoryPanel.test.tsx
  - src/__tests__/components/terminal-tab-refit.test.tsx
key_decisions:
  - Used CSS opacity + pointer-events-none for JumpToBottom visibility instead of conditional rendering — enables fade transition
  - Used CSS max-height transition on history panel instead of conditional return null — enables smooth expand/collapse animation
  - Debounced xterm onScroll at 100ms to prevent flicker during rapid scrolling
duration: 
verification_result: passed
completed_at: 2026-04-15T17:36:47.821Z
blocker_discovered: false
---

# T04: Add jump-to-bottom button, loading skeletons, and scroll UX polish for terminal history panel

**Add jump-to-bottom button, loading skeletons, and scroll UX polish for terminal history panel**

## What Happened

Created a floating JumpToBottom button component using shadcn Button with ArrowDown icon that appears when the user is scrolled away from live output (either in the history panel or scrolled up in xterm). Clicking it hides the history panel and scrolls xterm to bottom.

Replaced the text-based loading indicator in TerminalHistoryPanel with pulsing skeleton rows (4 gray bars with animate-pulse) that match terminal line height for a polished loading state.

Added smooth show/hide transitions to the history panel using CSS max-height transition (300ms ease-in-out) instead of conditional rendering, so the panel expands/collapses smoothly rather than popping in.

Debounced the xterm onScroll handler (100ms) to avoid flicker when rapidly scrolling, and added isAtBottom state tracking to control JumpToBottom visibility.

Updated existing tests: TerminalHistoryPanel test now checks for skeleton divs instead of loading text, terminal-tab-refit test mock now includes ArrowDown and Loader2 from lucide-react.

## Verification

- `pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx` — 3 tests pass (visibility, hidden state, click handler)
- `pnpm vitest run` — 60 test files, 474 tests all pass, no regressions
- `pnpm tsc --noEmit` — no type errors in task files (pre-existing errors in council-queues.ts and push-queue tests are unrelated)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx` | 0 | ✅ pass | 627ms |
| 2 | `pnpm vitest run` | 0 | ✅ pass | 4700ms |
| 3 | `pnpm tsc --noEmit` | 1 | ✅ pass (no errors in task files; pre-existing errors in council-queues.ts, push-queue tests) | 15000ms |

## Deviations

Changed TerminalHistoryPanel to return null only when !visible AND chunks.length === 0 (instead of just !visible) so the CSS max-height transition can animate the collapse. This is a minor behavioral refinement, not a plan deviation.

## Known Issues

Pre-existing TypeScript errors in council-queues.ts (ioredis version mismatch) and push-queue test files (tuple type mismatches) — unrelated to this task.

## Files Created/Modified

- `src/components/workspaces/JumpToBottom.tsx`
- `src/components/workspaces/TerminalHistoryPanel.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/components/JumpToBottom.test.tsx`
- `src/__tests__/components/TerminalHistoryPanel.test.tsx`
- `src/__tests__/components/terminal-tab-refit.test.tsx`
