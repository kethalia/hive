---
id: T04
parent: S03
milestone: M010
key_files:
  - src/lib/auth/actions.ts
  - src/components/token-expiry-banner.tsx
  - src/app/(dashboard)/layout.tsx
  - src/__tests__/components/token-expiry-banner.test.tsx
key_decisions:
  - (none)
duration: 
verification_result: passed
completed_at: 2026-04-18T21:02:37.536Z
blocker_discovered: false
---

# T04: Add in-app token expiry banner to dashboard layout with server action

**Add in-app token expiry banner to dashboard layout with server action**

## What Happened

Created the TokenExpiryBanner component and wired it into the dashboard layout via a server action. The implementation follows the plan exactly:

1. **Server action** (`src/lib/auth/actions.ts`): Added `getTokenStatusAction` using `authActionClient` that calls `getTokenStatus` from the T02 token-status service.

2. **TokenExpiryBanner component** (`src/components/token-expiry-banner.tsx`): Server component that receives `TokenStatusResult` as a prop. Renders destructive Alert with AlertCircle icon for `expired` and `key_mismatch` statuses, default Alert with Clock icon for `expiring` status (showing hours remaining), and returns null for `valid` status. Uses shadcn Alert components per project conventions.

3. **Dashboard layout** (`src/app/(dashboard)/layout.tsx`): Made the layout an async server component, calls `getTokenStatusAction()` wrapped in try/catch (fails silently if no session), renders `TokenExpiryBanner` above `{children}` inside `<main>` when data is available.

4. **Tests** (`src/__tests__/components/token-expiry-banner.test.tsx`): 5 test cases covering all status variants — valid (renders nothing), expired (destructive alert), key_mismatch (destructive alert with re-auth message), expiring (default alert with hours remaining), and singular hour grammar.

## Verification

Ran banner component tests (5/5 pass) and full slice verification suite (51/51 pass across 5 test files). Verified TokenExpiryBanner is referenced in the dashboard layout via grep.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/components/token-expiry-banner.test.tsx` | 0 | ✅ pass | 612ms |
| 2 | `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts src/__tests__/auth/token-status.test.ts src/__tests__/queue/token-rotation.test.ts src/__tests__/queue/task-queue-preflight.test.ts src/__tests__/components/token-expiry-banner.test.tsx` | 0 | ✅ pass (51 tests, 5 files) | 669ms |
| 3 | `grep -q TokenExpiryBanner src/app/(dashboard)/layout.tsx` | 0 | ✅ pass | 10ms |

## Deviations

none

## Known Issues

none

## Files Created/Modified

- `src/lib/auth/actions.ts`
- `src/components/token-expiry-banner.tsx`
- `src/app/(dashboard)/layout.tsx`
- `src/__tests__/components/token-expiry-banner.test.tsx`
