---
estimated_steps: 33
estimated_files: 4
skills_used: []
---

# T04: Add jump-to-bottom button, loading skeletons, and scroll UX polish

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

## Inputs

- ``src/components/workspaces/InteractiveTerminal.tsx` — modified in T03 with history panel integration`
- ``src/components/workspaces/TerminalHistoryPanel.tsx` — history panel from T03 (add loading skeletons)`
- ``src/hooks/useScrollbackPagination.ts` — pagination hook from T03 (isLoading state drives skeletons)`

## Expected Output

- ``src/components/workspaces/JumpToBottom.tsx` — floating jump-to-bottom button component`
- ``src/components/workspaces/TerminalHistoryPanel.tsx` — modified with loading skeleton rows`
- ``src/components/workspaces/InteractiveTerminal.tsx` — modified with jump-to-bottom wiring and scroll debouncing`
- ``src/__tests__/components/JumpToBottom.test.tsx` — button visibility and click tests`

## Verification

pnpm vitest run src/__tests__/components/JumpToBottom.test.tsx && pnpm vitest run && pnpm tsc --noEmit
