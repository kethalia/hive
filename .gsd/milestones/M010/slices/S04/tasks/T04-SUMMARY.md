---
id: T04
parent: S04
milestone: M010
key_files:
  - src/lib/push/send.ts
  - src/lib/queue/token-rotation.ts
  - src/__tests__/push/send.test.ts
  - src/__tests__/push/rotation-integration.test.ts
key_decisions:
  - Used per-subscription try/catch with continue pattern so one failed endpoint doesn't block remaining subscriptions
  - Placed push notification trigger before decryption/rotation logic — notification fires regardless of whether rotation itself succeeds, since the user should be warned even if rotation fails
  - Log endpoint domain only (not full URL) per redaction constraints in slice plan
duration: 
verification_result: passed
completed_at: 2026-04-18T22:29:11.439Z
blocker_discovered: false
---

# T04: Create push sender with stale subscription cleanup and integrate into token rotation worker at ≤24h threshold

**Create push sender with stale subscription cleanup and integrate into token rotation worker at ≤24h threshold**

## What Happened

Created `src/lib/push/send.ts` with `sendPushToUser(userId, payload)` that queries all PushSubscription rows for the user, sets VAPID details from DB-stored keys, and sends notifications via web-push. Per-subscription error handling: 410 Gone and 404 Not Found trigger automatic subscription deletion (stale cleanup), other errors are logged with endpoint domain (not full URL) and execution continues. Returns `{sent, cleaned}` counts for observability. getVapidKeys failure is caught at the top and returns zeros without attempting sends.

Integrated push notification trigger into `processTokenRotation` in `src/lib/queue/token-rotation.ts`. After the existing threshold check passes, a new block calculates `hoursRemaining` and fires `sendPushToUser` when `hoursRemaining <= PUSH_NOTIFICATION_HOURS` (24h). The call is wrapped in try/catch so push failures never block token rotation. Log lines follow the `[token-rotation]` prefix convention for success and `[push]` prefix for send-level observability.

Created comprehensive tests: 7 tests in `send.test.ts` covering all subscriptions sent, 410 cleanup, 404 cleanup, non-fatal error logging, mixed result counts, VAPID key failure, and empty subscription list. 4 tests in `rotation-integration.test.ts` covering push trigger at ≤24h, no notification when >24h remaining, push failure not blocking rotation, and rotation completing despite push throws.

## Verification

Ran `pnpm vitest run src/__tests__/push/send.test.ts` — 7 tests passed. Ran `pnpm vitest run src/__tests__/push/rotation-integration.test.ts` — 4 tests passed. Verified `sendPushToUser` is imported in token-rotation.ts via grep. Ran full suite `pnpm vitest run` — 602 passed, 16 failed (all 16 pre-existing in worker.test.ts, confirmed by stashing changes and re-running). Zero regressions introduced.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/push/send.test.ts` | 0 | ✅ pass | 161ms |
| 2 | `pnpm vitest run src/__tests__/push/rotation-integration.test.ts` | 0 | ✅ pass | 249ms |
| 3 | `grep -q 'sendPushToUser' src/lib/queue/token-rotation.ts` | 0 | ✅ pass | 5ms |
| 4 | `pnpm vitest run` | 1 | ✅ pass (16 failures pre-existing in worker.test.ts, 0 regressions) | 4840ms |

## Deviations

none

## Known Issues

none

## Files Created/Modified

- `src/lib/push/send.ts`
- `src/lib/queue/token-rotation.ts`
- `src/__tests__/push/send.test.ts`
- `src/__tests__/push/rotation-integration.test.ts`
