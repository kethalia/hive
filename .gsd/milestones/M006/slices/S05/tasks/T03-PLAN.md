---
estimated_steps: 29
estimated_files: 2
skills_used: []
---

# T03: Write TerminalTabManager regression tests confirming session CRUD, tab switching, and M006 feature coexistence

## Description

This task adds regression tests to confirm pre-existing terminal tab features (session create, rename, kill, tab switching) still work correctly with M006 components present (KeepAliveWarning, connection badges with reconnection states, reconnectId localStorage cleanup on kill).

The existing `terminal-tab-manager.test.tsx` has 7 tests for base tab functionality but doesn't exercise M006 additions. This task extends coverage without modifying production code.

## Steps

1. Create `src/__tests__/integration/terminal-tab-manager-regression.test.tsx` with `// @vitest-environment jsdom` header
2. Set up mocks following `terminal-tab-manager.test.tsx` patterns: mock `next/dynamic` so InteractiveTerminal renders as a stub div with data-testid, mock server actions (`createSessionAction`, `renameSessionAction`, `killSessionAction`, `getWorkspaceSessionsAction`), mock `useKeepAliveStatus` to return controllable status
3. **Test group 1 — Session CRUD with M006 present**: Render TerminalTabManager. Verify initial session load via `getWorkspaceSessionsAction`. Create new tab → verify `createSessionAction` called. Rename tab → verify `renameSessionAction` called with correct args. Kill tab → verify `killSessionAction` called.
4. **Test group 2 — Tab switching preserves M006 state**: Create multiple tabs. Switch between them. Verify InteractiveTerminal stubs render with correct session props. Verify display:none/block pattern for inactive/active tabs (the mechanism that ResizeObserver responds to).
5. **Test group 3 — KeepAliveWarning integration**: Mock `useKeepAliveStatus` to return `{ consecutiveFailures: 3 }`. Render TerminalTabManager. Verify KeepAliveWarning banner appears above tab bar. Set failures to 0 → verify banner disappears.
6. **Test group 4 — ReconnectId cleanup on kill**: Set a reconnectId in localStorage for a session (`terminal:reconnect:agentId:sessionName`). Kill that session's tab. Verify the localStorage entry is removed (tests the cleanup path that prevents stale reconnectIds from causing hydration attempts to dead sessions).
7. Run tests and verify full suite passes

## Must-Haves

- [ ] Session create/rename/kill still works with M006 components mounted
- [ ] Tab switching renders correct InteractiveTerminal instances
- [ ] KeepAliveWarning renders in TerminalTabManager context at failure threshold
- [ ] ReconnectId localStorage entry cleaned up on tab kill
- [ ] No regressions in existing 474+ test suite

## Verification

- `pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx` passes with 8+ tests
- `pnpm vitest run` full suite passes with 0 regressions
- `pnpm tsc --noEmit` shows no new TypeScript errors

## Inputs

- `src/components/workspaces/TerminalTabManager.tsx` — Component under test
- `src/__tests__/components/terminal-tab-manager.test.tsx` — Reference for existing mock patterns and test structure
- `src/components/workspaces/KeepAliveWarning.tsx` — M006 warning component mounted in tab manager
- `src/hooks/useKeepAliveStatus.ts` — Hook providing keep-alive failure data
- `src/components/workspaces/InteractiveTerminal.tsx` — Child component (mocked as stub)

## Expected Output

- `src/__tests__/integration/terminal-tab-manager-regression.test.tsx` — New regression test file with 8+ tests

## Inputs

- `src/components/workspaces/TerminalTabManager.tsx`
- `src/__tests__/components/terminal-tab-manager.test.tsx`
- `src/components/workspaces/KeepAliveWarning.tsx`
- `src/hooks/useKeepAliveStatus.ts`
- `src/components/workspaces/InteractiveTerminal.tsx`

## Expected Output

- `src/__tests__/integration/terminal-tab-manager-regression.test.tsx`

## Verification

pnpm vitest run src/__tests__/integration/terminal-tab-manager-regression.test.tsx && pnpm vitest run && pnpm tsc --noEmit
