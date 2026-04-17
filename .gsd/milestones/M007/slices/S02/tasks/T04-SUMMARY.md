---
id: T04
parent: S02
milestone: M007
key_files:
  - src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx
key_decisions:
  - Added mockFocus spy via vi.hoisted alongside mockFit — same pattern but extended for focus verification
  - Used fireEvent.click/keyDown from testing-library rather than manual DOM event dispatch for consistency with React synthetic event handling
duration: 
verification_result: passed
completed_at: 2026-04-17T05:23:08.478Z
blocker_discovered: false
---

# T04: Add keystroke exclusivity integration tests verifying focus-on-mount, stopPropagation non-bubbling, and click-to-refocus

**Add keystroke exclusivity integration tests verifying focus-on-mount, stopPropagation non-bubbling, and click-to-refocus**

## What Happened

Created `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` with 3 test cases covering R069 keystroke exclusivity requirements:

1. **focus-on-mount** — Verifies that `term.focus()` is called after the InteractiveTerminal mounts and initializes xterm. Uses a `mockFocus` spy on the mocked Terminal class.

2. **keydown non-bubbling** — Wraps InteractiveTerminal in a `stopPropagation` div (mimicking the `terminal-client.tsx` pattern from T02) and a grandparent with a keydown spy. Fires a keydown event on the terminal container and asserts the grandparent spy is never called.

3. **click-to-refocus** — Clears the focus mock after mount, simulates a click on the terminal container div (`.flex-1`), and asserts `mockFocus` is called again via the `onClick` handler added in T02.

All mocks follow the established patterns from `interactive-terminal-integration.test.tsx`, with the addition of `mockFocus` spy and `@/lib/terminal/config` mock.

## Verification

Ran `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — all 3 tests passed (69ms). Verified file exists at the expected path.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` | 0 | ✅ pass | 614ms |
| 2 | `test -f src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` | 0 | ✅ pass | 5ms |

## Deviations

none

## Known Issues

none

## Files Created/Modified

- `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`
