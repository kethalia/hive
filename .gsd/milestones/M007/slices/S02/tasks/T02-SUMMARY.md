---
id: T02
parent: S02
milestone: M007
key_files:
  - src/app/workspaces/[id]/terminal/terminal-client.tsx
  - src/components/workspaces/InteractiveTerminal.tsx
  - src/app/workspaces/[id]/terminal/page.tsx
key_decisions:
  - Used negative margins (-m-6 -mt-14) with explicit h-[100vh] w-[calc(100%+3rem)] to cancel layout padding rather than restructuring the layout — matches existing pattern and avoids touching shared layout.tsx
duration: 
verification_result: passed
completed_at: 2026-04-17T05:20:09.840Z
blocker_discovered: false
---

# T02: Make terminal page full-viewport with keystroke exclusivity via negative margins, stopPropagation, and xterm auto-focus

**Make terminal page full-viewport with keystroke exclusivity via negative margins, stopPropagation, and xterm auto-focus**

## What Happened

Changed terminal-client.tsx to use `-m-6 -mt-14 h-[100vh] w-[calc(100%+3rem)]` on the terminal wrapper, waiting-for-session fallback, and Suspense fallback — fully cancelling the root layout's `p-6 pt-14` padding. Added `onKeyDown={(e) => e.stopPropagation()}` on the terminal wrapper to prevent keystroke bubbling to sidebar or layout.

In InteractiveTerminal.tsx, added `term.focus()` immediately after `term.open(containerRef.current)` for auto-focus on mount. Added `onClick={() => termRef.current?.focus()}` on the container div so clicking anywhere in the terminal area re-focuses xterm.

Updated page.tsx error state container to use the same full-viewport sizing classes instead of the old calc-based inline style.

## Verification

Ran 4 verification checks: grep for term.focus in InteractiveTerminal.tsx (pass), grep for stopPropagation in terminal-client.tsx (pass), grep for -mt-14 in terminal-client.tsx (pass), and pnpm tsc --noEmit filtered for terminal errors returning 0 (pass).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -q 'term.focus' src/components/workspaces/InteractiveTerminal.tsx` | 0 | ✅ pass | 50ms |
| 2 | `grep -q 'stopPropagation' src/app/workspaces/[id]/terminal/terminal-client.tsx` | 0 | ✅ pass | 50ms |
| 3 | `grep -q '-mt-14' src/app/workspaces/[id]/terminal/terminal-client.tsx` | 0 | ✅ pass | 50ms |
| 4 | `pnpm tsc --noEmit | grep terminal | grep -c 'error TS'` | 0 | ✅ pass (0 errors) | 15000ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/workspaces/[id]/terminal/page.tsx`
