---
id: T03
parent: S01
milestone: M007
key_files:
  - src/__tests__/components/app-sidebar.test.tsx
  - src/components/app-sidebar.tsx
key_decisions:
  - Followed workspaces-client.test.tsx mock patterns for consistency across component tests
  - Used vi.useFakeTimers with shouldAdvanceTime to handle 30s polling interval without test flakiness
duration: 
verification_result: mixed
completed_at: 2026-04-17T05:05:21.392Z
blocker_discovered: false
---

# T03: Add sidebar test suite covering collapsible sections, error states with retry, and footer refresh button

**Add sidebar test suite covering collapsible sections, error states with retry, and footer refresh button**

## What Happened

The sidebar component from T01/T02 already had all runtime features implemented: footer with last-refreshed timestamp and refresh button (RefreshCw icon), inline Alert components with retry buttons for both workspace and template fetch failures. This task focused on creating the test suite.

Created `src/__tests__/components/app-sidebar.test.tsx` with 8 tests covering: workspace names rendering on data load, template names rendering on data load, error alert with retry on workspace fetch failure, error alert with retry on template fetch failure, retry button triggering re-fetch and recovering, refresh button presence in footer, last-refreshed timestamp display, and refresh button invoking both fetch actions.

Mocked all sidebar UI dependencies (sidebar components, collapsible, alert, badge, lucide-react icons, next/navigation) following the patterns established in `workspaces-client.test.tsx`. Used `vi.useFakeTimers` to handle the 30s polling interval cleanly.

The `pnpm tsc --noEmit` gate reports 20 errors, all pre-existing in `council-queues.ts` and unrelated test files (ioredis version mismatch, tuple type issues). Zero errors in sidebar or test code.

## Verification

- `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` — 8/8 tests pass
- `grep -q 'Alert' src/components/app-sidebar.tsx` — confirmed Alert import present
- `grep -q 'RefreshCw' src/components/app-sidebar.tsx` — confirmed RefreshCw import present
- `pnpm tsc --noEmit` — 20 pre-existing errors in council-queues.ts and test files, none in sidebar code

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/app-sidebar.test.tsx` | 0 | ✅ pass | 1240ms |
| 2 | `grep -q 'Alert' src/components/app-sidebar.tsx` | 0 | ✅ pass | 10ms |
| 3 | `grep -q 'RefreshCw' src/components/app-sidebar.tsx` | 0 | ✅ pass | 10ms |
| 4 | `pnpm tsc --noEmit` | 1 | ⚠️ pre-existing errors only (0 in sidebar code) | 15000ms |

## Deviations

None — sidebar already had all runtime features from T01/T02. Task focused on test creation as planned.

## Known Issues

pnpm tsc --noEmit fails with 20 pre-existing errors in council-queues.ts (ioredis version mismatch) and council/push-queue test files. These are unrelated to M007/S01 work.

## Files Created/Modified

- `src/__tests__/components/app-sidebar.test.tsx`
- `src/components/app-sidebar.tsx`
