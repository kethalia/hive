---
id: T03
parent: S02
milestone: M006
key_files:
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/__tests__/components/terminal-tab-refit.test.tsx
key_decisions:
  - Replaced window resize listener with ResizeObserver — handles both window resizes and tab visibility transitions in a single mechanism, avoiding double-fit on window resize
duration: 
verification_result: passed
completed_at: 2026-04-15T15:07:56.788Z
blocker_discovered: false
---

# T03: Add ResizeObserver-based re-fit on tab visibility to preserve scrollback rendering

**Add ResizeObserver-based re-fit on tab visibility to preserve scrollback rendering**

## What Happened

Replaced the `window.addEventListener('resize', handleResize)` listener in InteractiveTerminal with a `ResizeObserver` on the terminal container element. The observer fires whenever the container's dimensions change — covering both window resizes and tab visibility transitions (display:none → display:block). The callback only calls `fitAddon.fit()` when the observed dimensions are non-zero, preventing corrupted terminal state from fitting against a hidden container.

The ResizeObserver is created synchronously in the useEffect (outside the async Terminal init IIFE) and observes `containerRef.current`. It is disconnected in the cleanup function to prevent memory leaks.

This approach naturally handles the TerminalTabManager's display:none/block tab switching pattern: when a tab becomes visible, the container transitions from 0×0 to real dimensions, triggering the observer which calls fit() to re-render xterm.js correctly with all scrollback preserved.

## Verification

- `pnpm vitest run src/__tests__/components/terminal-tab-refit.test.tsx` — 4/4 tests pass: fit() called on non-zero dimensions, fit() NOT called on 0×0, observer disconnected on unmount, observer targets the container element.
- `grep -q 'ResizeObserver' src/components/workspaces/InteractiveTerminal.tsx` — exit code 0, confirms ResizeObserver present.
- `pnpm tsc --noEmit` — 20 pre-existing errors in council-queues.ts / comment.test.ts / push-queue.test.ts; zero errors from task files.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/terminal-tab-refit.test.tsx` | 0 | ✅ pass | 642ms |
| 2 | `grep -q 'ResizeObserver' src/components/workspaces/InteractiveTerminal.tsx` | 0 | ✅ pass | 10ms |
| 3 | `pnpm tsc --noEmit` | 2 | ✅ pass (20 pre-existing errors, 0 from task files) | 15000ms |

## Deviations

None

## Known Issues

20 pre-existing TypeScript errors in council-queues.ts and related test files (ioredis version mismatch) — unrelated to this task.

## Files Created/Modified

- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/components/terminal-tab-refit.test.tsx`
