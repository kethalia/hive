# S04: PWA & Push Notifications — UAT

**Milestone:** M010
**Written:** 2026-04-18T22:32:31.125Z

# S04 UAT: PWA & Push Notifications

## Preconditions
- Hive app running locally or deployed
- TOKEN_ENCRYPTION_KEY env var set
- At least one user logged in with a Coder API token
- Browser supports service workers and push notifications (Chrome/Edge/Firefox)
- Browser notifications not blocked at OS level

## Test Cases

### TC1: PWA Installation
1. Open Hive in Chrome/Edge
2. Verify the browser shows a PWA install prompt (address bar icon or menu option)
3. Click "Install" — app should open in standalone window without browser chrome
4. **Expected:** App runs in standalone mode with zinc-950 theme, no browser address bar
5. Verify `/manifest.webmanifest` returns JSON with `display: "standalone"`, `name: "Hive Orchestrator"`

### TC2: Service Worker Registration
1. Open browser DevTools → Application → Service Workers
2. Navigate to Hive dashboard
3. **Expected:** Service worker registered from `/sw.js`, status "activated and running"
4. Verify no fetch handler — service worker scope shows only push and notificationclick

### TC3: Push Permission Prompt — Default State
1. Open Hive in a browser where notification permission is "default" (not yet asked)
2. Navigate to dashboard
3. **Expected:** Alert banner appears below token expiry banner: "Enable push notifications to get warned when your Coder token is about to expire"
4. Click "Enable notifications"
5. **Expected:** Browser permission dialog appears
6. Grant permission
7. **Expected:** Alert disappears, PushSubscription row created in database for this user

### TC4: Push Permission Prompt — Dismiss
1. With permission in "default" state, view the notification prompt
2. Click dismiss/close button
3. **Expected:** Prompt disappears
4. Refresh page
5. **Expected:** Prompt does not reappear (localStorage flag persists)

### TC5: Push Permission Prompt — Denied State
1. In browser settings, block notifications for Hive
2. Navigate to dashboard
3. **Expected:** Informational Alert explaining how to unblock notifications in browser settings

### TC6: Push Notification on Token Expiry
1. Create a user with a Coder API token that expires within 24 hours
2. Trigger the token rotation worker (or wait for BullMQ hourly job)
3. **Expected:** Push notification appears with title "Hive: Token Expiring" and body containing hours remaining
4. Verify `[token-rotation] Push notification triggered for user X (Yh remaining)` in server logs

### TC7: Notification Click Opens Login
1. Receive a push notification (from TC6)
2. Click the notification
3. **Expected:** If Hive tab exists, it focuses and navigates to /login. If no tab, opens new window at /login
4. Verify notification closes after click

### TC8: Stale Subscription Cleanup
1. Subscribe to push notifications
2. In database, note the PushSubscription endpoint
3. Simulate a 410 Gone response from the push service (e.g., by unregistering the service worker in another browser, then triggering a push send)
4. **Expected:** PushSubscription row deleted from database, `[push]` log shows cleanup

### TC9: No Notification When Token Has >24h
1. Create a user with a Coder API token expiring in 48 hours
2. Trigger the token rotation worker
3. **Expected:** No push notification sent, no `[token-rotation] Push notification triggered` log line

### TC10: Push Failure Does Not Block Rotation
1. Subscribe to push notifications
2. Kill the push service endpoint (or mock a failure)
3. Trigger token rotation for a token with ≤24h remaining
4. **Expected:** Token rotation completes successfully despite push failure, `[token-rotation] Push notification failed` logged but rotation proceeds

## Edge Cases
- Multiple browsers subscribed for same user: all should receive notification
- User with no push subscriptions: sendPushToUser returns {sent: 0, cleaned: 0}, no errors
- VAPID keys auto-generate on first push attempt if none exist in DB
