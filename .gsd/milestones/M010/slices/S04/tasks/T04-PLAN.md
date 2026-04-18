---
estimated_steps: 58
estimated_files: 4
skills_used: []
---

# T04: Create push sender and integrate into token rotation worker

## Description

Completes R104 by creating the server-side push notification sender and integrating it into the token rotation worker. When the rotation processor detects a token with ≤24h remaining, it fires a push notification to all of that user's subscribed browsers. Stale subscriptions (410 Gone from the push service) are automatically cleaned up.

This is the final task — after it, the full PWA + push notification flow is operational end-to-end.

## Steps

1. Create `src/lib/push/send.ts` with `sendPushToUser(userId: string, payload: {title: string, body: string, tag: string})` function:
   - Import web-push, call getVapidKeys() for VAPID credentials
   - Query all PushSubscription rows for the user
   - For each subscription: call webpush.sendNotification() with {endpoint, keys: {p256dh, auth}} and JSON.stringify(payload)
   - Set webpush.setVapidDetails('mailto:noreply@hive.local', publicKey, privateKey) before sending
   - Catch errors per-subscription: if statusCode === 410 or 404, delete the subscription row from DB (stale). Log other errors and continue.
   - Return {sent: number, cleaned: number} for observability
2. Add push notification trigger to `src/lib/queue/token-rotation.ts`:
   - Import sendPushToUser and PUSH_NOTIFICATION_HOURS from constants
   - After the expiry detection loop (where it checks if token needs rotation), add a check: if token has ≤24h remaining (using PUSH_NOTIFICATION_HOURS constant), call sendPushToUser with title 'Hive: Token Expiring', body 'Your Coder API token expires in Xh. Tap to re-authenticate.', tag PUSH_NOTIFICATION_TAG
   - Wrap sendPushToUser call in try/catch — push failures must never block rotation. Log and continue.
   - Only send notification once per rotation cycle: check if hoursRemaining <= PUSH_NOTIFICATION_HOURS
3. Create `src/__tests__/push/send.test.ts` testing:
   - sendPushToUser sends to all subscriptions for a user (mock web-push)
   - 410 Gone response triggers subscription cleanup (delete from DB)
   - 404 response also triggers cleanup
   - Other errors are logged but don't throw
   - Returns correct sent/cleaned counts
4. Create `src/__tests__/push/rotation-integration.test.ts` testing:
   - Token rotation triggers push notification when token ≤24h from expiry
   - Push failure doesn't block rotation (rotation still succeeds)
   - No notification sent when token has >24h remaining

## Must-Haves

- [ ] sendPushToUser sends to all user subscriptions via web-push
- [ ] 410/404 responses trigger automatic subscription cleanup
- [ ] Push errors never block token rotation
- [ ] Notification fires at ≤24h remaining threshold
- [ ] Notification payload includes title, body, and dedup tag
- [ ] VAPID details set from DB-stored keys

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| web-push sendNotification | Log error, continue to next subscription | web-push has internal timeout | N/A |
| getVapidKeys | Log error, skip all notifications for this cycle | N/A (DB query) | N/A |
| DB delete (stale subscription) | Log warning, continue | N/A | N/A |

## Observability Impact

- Signals added: `[push] Sent N notifications, cleaned M stale subscriptions for user X`, `[push] Failed to send to endpoint domain Y: error`, `[token-rotation] Push notification triggered for user X (Yh remaining)`
- How a future agent inspects this: grep logs for `[push]`, query PushSubscription table for subscription count
- Failure state exposed: per-subscription send errors with endpoint domain, stale subscription cleanup count

## Verification

- `pnpm vitest run src/__tests__/push/send.test.ts`
- `pnpm vitest run src/__tests__/push/rotation-integration.test.ts`
- `grep -q 'sendPushToUser' src/lib/queue/token-rotation.ts`
- `pnpm vitest run` — all tests pass (no regressions)

## Inputs

- `src/lib/push/vapid.ts` — getVapidKeys() for VAPID credentials
- `src/lib/queue/token-rotation.ts` — rotation processor to integrate push trigger into
- `src/lib/constants.ts` — PUSH_NOTIFICATION_HOURS and PUSH_NOTIFICATION_TAG constants
- `prisma/schema.prisma` — PushSubscription model for querying and cleanup

## Expected Output

- `src/lib/push/send.ts` — sendPushToUser function with stale subscription cleanup
- `src/lib/queue/token-rotation.ts` — updated with push notification trigger at 24h threshold
- `src/__tests__/push/send.test.ts` — push sender tests
- `src/__tests__/push/rotation-integration.test.ts` — rotation-push integration tests

## Inputs

- ``src/lib/push/vapid.ts` — getVapidKeys() for VAPID credentials`
- ``src/lib/queue/token-rotation.ts` — token rotation processor to add push trigger`
- ``src/lib/constants.ts` — PUSH_NOTIFICATION_HOURS and PUSH_NOTIFICATION_TAG constants`
- ``prisma/schema.prisma` — PushSubscription model for query and cleanup`

## Expected Output

- ``src/lib/push/send.ts` — sendPushToUser with per-subscription error handling and 410 cleanup`
- ``src/lib/queue/token-rotation.ts` — updated with push notification at ≤24h threshold`
- ``src/__tests__/push/send.test.ts` — push sender tests with mock web-push`
- ``src/__tests__/push/rotation-integration.test.ts` — rotation-push integration tests`

## Verification

pnpm vitest run src/__tests__/push/send.test.ts && pnpm vitest run src/__tests__/push/rotation-integration.test.ts && grep -q 'sendPushToUser' src/lib/queue/token-rotation.ts && pnpm vitest run
