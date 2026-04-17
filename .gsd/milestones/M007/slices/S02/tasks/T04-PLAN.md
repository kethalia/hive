---
estimated_steps: 41
estimated_files: 1
skills_used: []
---

# T04: Write keystroke exclusivity integration test

---
estimated_steps: 4
estimated_files: 1
skills_used: []
---

# T04: Write keystroke exclusivity integration test

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

Create an integration test that verifies terminal keystroke exclusivity (R069). The test must confirm that: (1) `term.focus()` is called after mount, (2) keyboard events on the terminal container don't bubble to parent elements, and (3) clicking the terminal container re-triggers focus. Follow mock patterns from `src/__tests__/integration/interactive-terminal-integration.test.tsx`.

## Steps

1. Create `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` with the standard vitest-environment jsdom header.

2. Set up mocks following `interactive-terminal-integration.test.tsx` patterns:
   - Use `vi.hoisted` for `mockFit` and `mockFocus` spies
   - Mock `@xterm/xterm` Terminal class with `focus: mockFocus`, `open`, `loadAddon`, `onData`, `onResize`, `dispose`, `write`, `rows: 24`, `cols: 80`
   - Mock `@xterm/addon-fit` FitAddon with `fit: mockFit`
   - Mock `@/hooks/useTerminalWebSocket` returning `{ send: vi.fn(), resize: vi.fn(), connectionState: 'disconnected' }`
   - Mock `@/lib/terminal/protocol`, `@/lib/utils`, `@/components/ui/alert`, `lucide-react`, `@/styles/xterm.css`
   - Mock `@/lib/terminal/config` with `TERMINAL_THEME: {}`, `TERMINAL_FONT_FAMILY: 'monospace'`, `loadTerminalFont: () => Promise.resolve()`
   - Set up `ResizeObserver` mock, `requestAnimationFrame` mock, `document.fonts.ready`, and `NEXT_PUBLIC_TERMINAL_WS_URL` env var in `beforeEach`

3. Write the `renderTerminal` helper (same pattern as existing integration test — dynamic import of InteractiveTerminal, render with act, await tick).

4. Write test cases:
   - **"calls term.focus() after mount"**: render terminal, assert `mockFocus` was called at least once
   - **"keydown events on container do not bubble to parent"**: render terminal inside a parent div with a keydown spy. The `InteractiveTerminal` component itself doesn't stopPropagation (that's in `terminal-client.tsx`), so this test should wrap the terminal in a div with `onKeyDown={e => e.stopPropagation()}` mimicking the terminal-client wrapper, fire a keydown on the terminal container, and assert the grandparent spy was NOT called.
   - **"clicking terminal container calls term.focus()"**: render terminal, clear mockFocus, simulate click on the terminal container div, assert mockFocus was called. The InteractiveTerminal has an `onClick` handler added in T02 that calls `termRef.current?.focus()`.

## Must-Haves

- [ ] Test file created at `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`
- [ ] Uses same mock patterns as existing integration tests
- [ ] Tests focus-on-mount behavior
- [ ] Tests keystroke non-bubbling with stopPropagation wrapper
- [ ] Tests click-to-refocus behavior
- [ ] All tests pass

## Verification

- `pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — all tests pass
- `test -f src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — file exists

## Inputs

- `src/__tests__/integration/interactive-terminal-integration.test.tsx` — reference for mock patterns and test structure
- `src/components/workspaces/InteractiveTerminal.tsx` — component under test (with focus management from T02)
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — reference for stopPropagation wrapper pattern (from T02)

## Expected Output

- `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx` — new integration test file with 3 test cases for keystroke exclusivity

## Inputs

- `src/__tests__/integration/interactive-terminal-integration.test.tsx`
- `src/components/workspaces/InteractiveTerminal.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`

## Expected Output

- `src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx`

## Verification

pnpm vitest run src/__tests__/integration/terminal-keystroke-exclusivity.test.tsx
