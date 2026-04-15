---
estimated_steps: 24
estimated_files: 2
skills_used: []
---

# T03: Add ResizeObserver-based re-fit on tab visibility to preserve scrollback rendering

## Description

This task implements R052: tab switching preserves scrollback in both tabs with no rendering glitches. The DOM architecture already preserves terminal instances (display:none instead of unmount), so scrollback data is retained. The issue is that when a tab becomes visible again, xterm.js may not re-render correctly because FitAddon.fit() was never called after the container transitioned from display:none to display:block.

The solution is a ResizeObserver inside InteractiveTerminal that watches the container element. When the container's dimensions change from 0x0 (hidden) to non-zero (visible), call fitAddon.fit(). This is self-contained within InteractiveTerminal — no changes needed to TerminalTabManager.

Key constraint: calling fit() on a terminal whose container has display:none produces zero dimensions and can corrupt the terminal state. The ResizeObserver approach naturally avoids this because it only fires when dimensions actually change, and we only call fit() when the new dimensions are non-zero.

## Steps

1. In `src/components/workspaces/InteractiveTerminal.tsx`: inside the async useEffect that initializes the terminal (after `term.open(containerRef.current)`), add a ResizeObserver on `containerRef.current`. In the observer callback, check if the observed entry's `contentRect.width > 0 && contentRect.height > 0`, and if so, call `fitRef.current?.fit()`. Store the observer in a ref or local variable and disconnect it in the cleanup function.
2. Remove or keep the existing `window.addEventListener('resize', handleResize)` — the ResizeObserver will handle both window resizes and tab visibility changes, so the window resize listener is redundant. However, keeping it is harmless and provides a fallback. Decision: remove it to avoid double-fitting on window resize.
3. Write tests in `src/__tests__/components/terminal-tab-refit.test.ts`: mock ResizeObserver, verify that when the observer callback fires with non-zero dimensions, fit() is called. Verify that when dimensions are 0x0, fit() is NOT called.

## Must-Haves

- [ ] ResizeObserver attached to terminal container element
- [ ] fit() called when container transitions from hidden to visible (non-zero dimensions)
- [ ] fit() NOT called when container has zero dimensions
- [ ] Observer disconnected on component unmount (no leak)
- [ ] Tab switching between two terminals preserves scrollback in both

## Verification

- `pnpm vitest run src/__tests__/components/terminal-tab-refit.test.ts` passes
- `pnpm tsc --noEmit` passes
- `grep -q 'ResizeObserver' src/components/workspaces/InteractiveTerminal.tsx` returns exit code 0

## Inputs

- `src/components/workspaces/InteractiveTerminal.tsx` — T02 output with reconnectId regeneration
- `src/components/workspaces/TerminalTabManager.tsx` — tab switching with display:none/block (read-only reference, no changes needed)

## Expected Output

- `src/components/workspaces/InteractiveTerminal.tsx` — ResizeObserver for tab visibility re-fit
- `src/__tests__/components/terminal-tab-refit.test.ts` — tests for ResizeObserver-based re-fit behavior

## Inputs

- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/components/workspaces/TerminalTabManager.tsx`

## Expected Output

- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/__tests__/components/terminal-tab-refit.test.ts`

## Verification

pnpm vitest run src/__tests__/components/terminal-tab-refit.test.ts && pnpm tsc --noEmit && grep -q 'ResizeObserver' src/components/workspaces/InteractiveTerminal.tsx
