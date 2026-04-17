---
estimated_steps: 46
estimated_files: 4
skills_used: []
---

# T03: Add stale entry error handling with sidebar force-refresh

---
estimated_steps: 4
estimated_files: 4
skills_used: []
---

# T03: Add stale entry error handling with sidebar force-refresh

**Slice:** S02 — Terminal Integration & Session Management
**Milestone:** M007

## Description

When a sidebar entry points to a workspace/session that no longer exists, clicking it must show an error and trigger the sidebar to refresh its data (R068). The terminal page already has basic error handling for missing agents — this task extends it to dispatch a `hive:sidebar-refresh` custom event that the sidebar listens for.

## Steps

1. In `src/app/workspaces/[id]/terminal/page.tsx`:
   - The page is a server component, so it cannot dispatch browser events directly. Instead, create a small client component `StaleEntryAlert` that renders the error Alert AND dispatches `window.dispatchEvent(new CustomEvent('hive:sidebar-refresh'))` in a `useEffect` on mount.
   - Replace the current inline error JSX with `<StaleEntryAlert workspaceId={workspaceId} />`.
   - The `StaleEntryAlert` component should show the existing "Could not find a running agent" message plus a Link back to `/workspaces` (or `/tasks` as the home route).
   - Keep the component in the same file or a co-located file like `stale-entry-alert.tsx`.

2. In `src/app/workspaces/[id]/terminal/terminal-client.tsx`:
   - In the `TerminalInner` component, when `!session` (no session param), add a `useEffect` that dispatches `hive:sidebar-refresh` to trigger sidebar data reload. This handles the case where a stale link has no session param.

3. In `src/components/app-sidebar.tsx`:
   - Add a `useEffect` that listens for the `hive:sidebar-refresh` custom event on `window`.
   - When received, call `fetchAll()` to re-fetch workspaces and templates.
   - Clean up the event listener on unmount.

4. Extend `src/__tests__/components/app-sidebar.test.tsx`:
   - Add a test: dispatch `hive:sidebar-refresh` custom event, verify `fetchAll` (both mock actions) is called again.

## Must-Haves

- [ ] Terminal page error state dispatches `hive:sidebar-refresh` event
- [ ] Missing session param dispatches `hive:sidebar-refresh` event
- [ ] Sidebar listens for `hive:sidebar-refresh` and calls fetchAll
- [ ] Error state includes navigation link back to home
- [ ] Event listener cleaned up on sidebar unmount
- [ ] Test verifies custom event triggers sidebar refresh

## Verification

- `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/page.tsx` — event dispatched on error
- `grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx` — sidebar listens for event
- `grep -q 'hive:sidebar-refresh' src/app/workspaces/[id]/terminal/terminal-client.tsx` — missing session dispatches event
- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — all tests pass including new custom event test

## Inputs

- `src/app/workspaces/[id]/terminal/page.tsx` — server component with existing error handling for missing agent
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — client component with session param handling
- `src/components/app-sidebar.tsx` — sidebar component (from T01 output) to add event listener
- `src/__tests__/components/app-sidebar.test.tsx` — test suite (from T01 output) to extend

## Expected Output

- `src/app/workspaces/[id]/terminal/page.tsx` — uses StaleEntryAlert client component that dispatches refresh event
- `src/app/workspaces/[id]/terminal/terminal-client.tsx` — dispatches refresh event when no session param
- `src/components/app-sidebar.tsx` — listens for hive:sidebar-refresh event
- `src/__tests__/components/app-sidebar.test.tsx` — new test for custom event listener

## Inputs

- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/components/app-sidebar.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`

## Expected Output

- `src/app/workspaces/[id]/terminal/page.tsx`
- `src/app/workspaces/[id]/terminal/terminal-client.tsx`
- `src/components/app-sidebar.tsx`
- `src/__tests__/components/app-sidebar.test.tsx`

## Verification

grep -q 'hive:sidebar-refresh' src/components/app-sidebar.tsx && pnpm vitest run src/__tests__/components/app-sidebar.test.tsx
