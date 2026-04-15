---
estimated_steps: 48
estimated_files: 5
skills_used: []
---

# T03: Add unit tests for WorkspaceToolPanel and getWorkspaceAction

## Description

Validates component behavior and the new server action without a running Coder instance. Tests cover tab switching, popup-out, error fallback, disabled state, and the getWorkspaceAction server action.

### What to test

**1. `workspace-tool-panel.test.tsx`** — component tests using @testing-library/react:
- Renders filebrowser iframe by default (check iframe src contains 'filebrowser')
- Tab switching: click kasmvnc tab, iframe src changes to kasmvnc URL
- Pop Out button calls `window.open` with the correct URL
- Dashboard link-out renders as anchor with correct href and `target="_blank"`
- Disabled state: when workspace status is 'stopped', renders message instead of iframe, tab buttons are disabled
- Error fallback: when error state is triggered, shows fallback link UI instead of iframe

**Mock strategy:**
- Mock `src/lib/workspaces/urls.ts` to return predictable URLs: `{ filebrowser: 'https://fb.test', kasmvnc: 'https://kasm.test', dashboard: 'https://dash.test' }`
- Mock `window.open` as `vi.fn()`
- Create a test workspace fixture matching `CoderWorkspace` type with `latest_build.status: 'running'`
- For disabled state test, use `latest_build.status: 'stopped'`

**2. Add to `actions.test.ts`** — server action test:
- Add test for `getWorkspaceAction`: mock `CoderClient.prototype.getWorkspace` to return a workspace object, call the action with a workspace ID, verify it returns the workspace
- Follow the existing test pattern in the file (vi.resetModules + dynamic import for module isolation)

## Steps

1. Read `src/__tests__/components/terminal-tab-manager.test.tsx` for the component testing pattern (mocking, rendering, assertions)
2. Read `src/__tests__/lib/workspaces/actions.test.ts` for the server action testing pattern
3. Read `src/components/workspaces/WorkspaceToolPanel.tsx` to understand the exact component API and DOM structure (data-testid attributes, element roles)
4. Create `src/__tests__/components/workspace-tool-panel.test.tsx` with 6-8 tests
5. Add 1-2 tests to `src/__tests__/lib/workspaces/actions.test.ts` for getWorkspaceAction
6. Run `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx` to verify
7. Run `pnpm vitest run` to verify zero regressions

## Must-Haves

- [ ] WorkspaceToolPanel test file exists with 6+ passing tests
- [ ] Tests cover: default tab render, tab switching, popup-out, dashboard link, disabled state, error fallback
- [ ] getWorkspaceAction test added to existing actions test file
- [ ] Full test suite passes with zero regressions

## Negative Tests

- **Disabled state**: workspace with status 'stopped' — no iframe rendered, tabs disabled
- **Error fallback**: simulated iframe error state — fallback links shown instead of iframe
- **Missing coderUrl**: empty string coderUrl prop — component handles gracefully (no crash)

## Verification

- `pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx` — all tests pass
- `pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts` — all tests pass (existing + new)
- `pnpm vitest run` — full suite passes, zero regressions

## Inputs

- `src/components/workspaces/WorkspaceToolPanel.tsx` — T01 output, component under test
- `src/lib/actions/workspaces.ts` — T01 output, server action under test
- `src/__tests__/components/terminal-tab-manager.test.tsx` — testing pattern reference
- `src/__tests__/lib/workspaces/actions.test.ts` — existing test file to extend
- `src/lib/coder/types.ts` — CoderWorkspace type for test fixtures

## Expected Output

- `src/__tests__/components/workspace-tool-panel.test.tsx` — new test file with 6+ tests
- `src/__tests__/lib/workspaces/actions.test.ts` — modified with getWorkspaceAction test

## Inputs

- `src/components/workspaces/WorkspaceToolPanel.tsx`
- `src/lib/actions/workspaces.ts`
- `src/__tests__/components/terminal-tab-manager.test.tsx`
- `src/__tests__/lib/workspaces/actions.test.ts`
- `src/lib/coder/types.ts`

## Expected Output

- `src/__tests__/components/workspace-tool-panel.test.tsx`
- `src/__tests__/lib/workspaces/actions.test.ts`

## Verification

pnpm vitest run src/__tests__/components/workspace-tool-panel.test.tsx && pnpm vitest run src/__tests__/lib/workspaces/actions.test.ts && pnpm vitest run
