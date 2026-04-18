# S04: PWA & Push Notifications

**Goal:** App installs as PWA. Push notification fires when token is 24h from expiry. Notification click opens login page.
**Demo:** App installs as PWA. Push notification fires when token is 24h from expiry. Notification opens login page. Login page has Coder-like styling.

## Must-Haves

- Web app manifest serves at /manifest.webmanifest with display:standalone (R103)
- Service worker registers and handles push + notificationclick events
- PushSubscription and VapidKeys Prisma models exist and generate successfully
- VAPID keys auto-generate on first use and persist to DB
- Users can subscribe to push notifications from dashboard (auth required)
- Push notification fires during token rotation when token ≤24h from expiry (R104)
- Notification click opens /login page (R109)
- Stale subscriptions (410 Gone) are cleaned up automatically
- `pnpm vitest run src/__tests__/push/` — all push tests pass
- `pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx` — component tests pass
- `pnpm prisma generate` — succeeds with new models
- All existing tests still pass (no regressions)

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (service worker registration, push API)
- Human/UAT required: yes (PWA install, notification permission grant)

## Integration Closure

- Upstream surfaces consumed: `src/lib/auth/encryption.ts` (encrypt not needed but pattern reference), `src/lib/queue/token-rotation.ts` (integration point for push trigger), `src/lib/auth/actions.ts` (authActionClient pattern for subscribe action), `src/lib/safe-action.ts` (authActionClient), `src/app/(dashboard)/layout.tsx` (PushPermissionPrompt placement), `src/app/layout.tsx` (ServiceWorkerRegister placement)
- New wiring introduced: service worker registration in root layout, push permission prompt in dashboard layout, sendPushToUser call in token rotation processor
- What remains before the milestone is truly usable end-to-end: nothing — this is the final slice in M010

## Verification

- Runtime signals: `[push]` prefixed log lines for send success/failure/cleanup, `[token-rotation]` push notification trigger logs
- Inspection surfaces: PushSubscription table (subscription count per user), VapidKeys table (key existence), service worker registration in browser DevTools
- Failure visibility: sendPushToUser logs per-subscription errors with endpoint, 410 Gone triggers automatic cleanup with log, web-push errors logged with user context
- Redaction constraints: PushSubscription endpoint URLs contain browser-specific tokens — log only domain, not full URL

## Tasks

- [x] **T01: Add PushSubscription/VapidKeys schema, VAPID key manager, and web-push dependency** `est:45m`
  ## Description

Adds the database foundation for Web Push: two new Prisma models (PushSubscription for per-user browser subscriptions, VapidKeys singleton for server identity) and a VAPID key management module that auto-generates keys on first use and caches them in memory. Also installs the `web-push` npm package and adds push-related constants.

This task unblocks all other S04 tasks — the schema provides storage, the VAPID keys provide server identity for both subscription creation (client needs public key) and notification sending (server needs private key).

## Steps

1. Run `pnpm add web-push` and `pnpm add -D @types/web-push` to install the web-push library.
2. Add `PushSubscription` model to `prisma/schema.prisma`: id (UUID PK), userId (FK to User), endpoint (String), p256dh (String), auth (String), createdAt. Add `@@unique([userId, endpoint])` and `@@map("push_subscriptions")`. Add `pushSubscriptions PushSubscription[]` relation to User model.
3. Add `VapidKeys` model to `prisma/schema.prisma`: id (Int @id @default(1)), publicKey (String), privateKey (String), createdAt. Add `@@map("vapid_keys")`.
4. Run `pnpm prisma generate` to verify the schema compiles.
5. Create `src/lib/push/vapid.ts` with `getVapidKeys()` function: check module-level cache → query VapidKeys from DB → if not found, call `webpush.generateVAPIDKeys()`, insert into DB, cache, and return. Export `getVapidPublicKey()` convenience wrapper.
6. Add constants to `src/lib/constants.ts`: `PUSH_NOTIFICATION_HOURS = 24` (threshold for push notification), `PUSH_NOTIFICATION_TAG = "token-expiry"` (notification tag for dedup).
7. Create `src/__tests__/push/vapid.test.ts` testing: auto-generation when DB empty, cache hit on second call, returns existing keys from DB.

## Must-Haves

- [ ] PushSubscription model with userId FK, endpoint, p256dh, auth fields and @@unique([userId, endpoint])
- [ ] VapidKeys singleton model with publicKey and privateKey
- [ ] pushSubscriptions relation added to User model
- [ ] `web-push` package installed
- [ ] getVapidKeys() auto-generates, persists, and caches VAPID keys
- [ ] PUSH_NOTIFICATION_HOURS and PUSH_NOTIFICATION_TAG constants added
- [ ] `pnpm prisma generate` succeeds
- [ ] vapid.test.ts passes

## Verification

- `pnpm prisma generate` succeeds
- `pnpm vitest run src/__tests__/push/vapid.test.ts` passes
- `grep -q 'PushSubscription' prisma/schema.prisma`
- `grep -q 'VapidKeys' prisma/schema.prisma`
- `grep -q 'PUSH_NOTIFICATION_HOURS' src/lib/constants.ts`

## Negative Tests

- **Error paths**: getVapidKeys handles DB connection failure gracefully (throws, doesn't cache partial state)
- **Boundary conditions**: VapidKeys singleton always uses id=1 (upsert semantics)

## Inputs

- `prisma/schema.prisma` — existing schema to extend with new models
- `src/lib/constants.ts` — existing constants file to add push constants
- `package.json` — add web-push dependency

## Expected Output

- `prisma/schema.prisma` — updated with PushSubscription, VapidKeys models and User relation
- `src/lib/push/vapid.ts` — VAPID key management with auto-generate and caching
- `src/lib/constants.ts` — updated with PUSH_NOTIFICATION_HOURS, PUSH_NOTIFICATION_TAG
- `src/__tests__/push/vapid.test.ts` — vapid key management tests
- `package.json` — web-push added to dependencies
  - Files: `prisma/schema.prisma`, `src/lib/push/vapid.ts`, `src/lib/constants.ts`, `src/__tests__/push/vapid.test.ts`, `package.json`
  - Verify: pnpm prisma generate && pnpm vitest run src/__tests__/push/vapid.test.ts && grep -q 'PushSubscription' prisma/schema.prisma && grep -q 'PUSH_NOTIFICATION_HOURS' src/lib/constants.ts

- [x] **T02: Create service worker, web app manifest, and PWA registration component** `est:45m`
  ## Description

Makes the app installable as a PWA (R103) and sets up the notification click handler that opens /login (R109). Creates three artifacts: a static service worker file handling push and notificationclick events, a Next.js route-based manifest export, and a client component that registers the service worker on mount.

The service worker is intentionally minimal — no fetch caching (Hive requires a live Coder connection). It handles two events: `push` (show notification) and `notificationclick` (focus existing tab or open /login).

## Steps

1. Create `public/sw.js` with:
   - `push` event listener: parse event.data.json() for {title, body, tag, icon}, call self.registration.showNotification(title, {body, tag, icon, data: {url: '/login'}})
   - `notificationclick` event listener: event.notification.close(), then clients.matchAll({type: 'window', includeUncontrolled: true}), if existing tab found focus it and navigate to /login, else clients.openWindow('/login')
   - No fetch event handler (no offline caching)
2. Create `src/app/manifest.ts` using Next.js MetadataRoute.Manifest export:
   - name: 'Hive Orchestrator', short_name: 'Hive', start_url: '/', display: 'standalone'
   - background_color: '#09090b' (zinc-950, matches dark theme), theme_color: '#09090b'
   - icons: [{src: '/favicon.ico', sizes: 'any', type: 'image/x-icon'}]
3. Create `src/components/service-worker-register.tsx` — a 'use client' component that calls `navigator.serviceWorker.register('/sw.js')` in a useEffect on mount. No UI output (returns null). Checks for serviceWorker support before registering.
4. Add `<ServiceWorkerRegister />` to `src/app/layout.tsx` inside the body, before TooltipProvider.
5. Create `src/__tests__/components/service-worker-register.test.tsx` testing: registers sw.js on mount, handles missing serviceWorker API gracefully.

## Must-Haves

- [ ] public/sw.js handles push event with showNotification
- [ ] public/sw.js handles notificationclick with tab focus/open logic targeting /login
- [ ] src/app/manifest.ts exports valid manifest with display:standalone
- [ ] ServiceWorkerRegister component registers /sw.js on mount
- [ ] ServiceWorkerRegister added to root layout
- [ ] No fetch event handler in service worker (no offline caching)

## Verification

- `test -f public/sw.js`
- `test -f src/app/manifest.ts`
- `grep -q 'showNotification' public/sw.js`
- `grep -q 'notificationclick' public/sw.js`
- `grep -q 'standalone' src/app/manifest.ts`
- `grep -q 'ServiceWorkerRegister' src/app/layout.tsx`
- `pnpm vitest run src/__tests__/components/service-worker-register.test.tsx`

## Inputs

- `src/app/layout.tsx` — root layout to add ServiceWorkerRegister component

## Expected Output

- `public/sw.js` — service worker with push and notificationclick handlers
- `src/app/manifest.ts` — Next.js route-based web app manifest
- `src/components/service-worker-register.tsx` — client component for SW registration
- `src/app/layout.tsx` — updated with ServiceWorkerRegister
- `src/__tests__/components/service-worker-register.test.tsx` — registration tests
  - Files: `public/sw.js`, `src/app/manifest.ts`, `src/components/service-worker-register.tsx`, `src/app/layout.tsx`, `src/__tests__/components/service-worker-register.test.tsx`
  - Verify: test -f public/sw.js && test -f src/app/manifest.ts && grep -q 'ServiceWorkerRegister' src/app/layout.tsx && pnpm vitest run src/__tests__/components/service-worker-register.test.tsx

- [ ] **T03: Build push subscription server actions and permission prompt component** `est:1h`
  ## Description

Creates the client-to-server push subscription flow: server actions for subscribing/unsubscribing (authenticated via authActionClient), a server action to expose the VAPID public key, and a dashboard component that prompts users to enable notifications. After this task, users can subscribe to push notifications from the dashboard.

The PushPermissionPrompt component checks Notification.permission state, handles the three states (default → show prompt, granted → auto-subscribe silently, denied → show instructions), and persists subscriptions via server actions. Uses shadcn Alert component per project conventions.

## Steps

1. Create `src/lib/push/subscribe.ts` with two server actions:
   - `subscribePushAction` (authActionClient, schema: {endpoint: string, p256dh: string, auth: string}) — upserts PushSubscription row for ctx.user.id with the provided subscription data
   - `unsubscribePushAction` (authActionClient, schema: {endpoint: string}) — deletes PushSubscription row matching ctx.user.id + endpoint
2. Create `src/lib/push/actions.ts` with:
   - `getVapidPublicKeyAction` (authActionClient) — calls getVapidKeys() from vapid.ts, returns only the publicKey (never expose privateKey)
3. Create `src/components/push-permission-prompt.tsx` — 'use client' component:
   - On mount: check `Notification.permission` and check localStorage for dismissal flag
   - If permission is 'denied': render shadcn Alert (default variant) explaining how to unblock in browser settings
   - If permission is 'default' and not dismissed: render shadcn Alert with 'Enable notifications' Button. On click: call Notification.requestPermission(), if granted proceed to subscribe
   - Subscribe flow: get VAPID public key via getVapidPublicKeyAction, get SW registration, call pushManager.subscribe({userVisibleOnly: true, applicationServerKey: base64urlToUint8Array(publicKey)}), send subscription to subscribePushAction
   - If permission is 'granted': check if already subscribed (pushManager.getSubscription()), if not auto-subscribe silently
   - Dismiss button sets localStorage flag, hides prompt
   - Helper: base64urlToUint8Array for converting VAPID public key
4. Add `<PushPermissionPrompt />` to `src/app/(dashboard)/layout.tsx` below TokenExpiryBanner.
5. Create `src/__tests__/push/subscribe.test.ts` testing: subscribePushAction upserts, unsubscribePushAction deletes, rejects unauthenticated calls.
6. Create `src/__tests__/components/push-permission-prompt.test.tsx` testing: renders enable button when permission is default, shows denied message, handles dismiss.

## Must-Haves

- [ ] subscribePushAction upserts PushSubscription with auth validation
- [ ] unsubscribePushAction deletes subscription with auth validation
- [ ] getVapidPublicKeyAction returns only public key (never private)
- [ ] PushPermissionPrompt handles default/granted/denied permission states
- [ ] PushPermissionPrompt uses shadcn Alert and Button components
- [ ] Dismiss persists to localStorage
- [ ] base64url-to-Uint8Array conversion for applicationServerKey
- [ ] Component wired into dashboard layout

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| getVapidPublicKeyAction | Show generic error in prompt, don't crash | N/A (server action) | N/A |
| pushManager.subscribe | Log error, show retry message | Browser handles | N/A |
| subscribePushAction | Log error, subscription still active in browser | N/A | N/A |

## Verification

- `pnpm vitest run src/__tests__/push/subscribe.test.ts`
- `pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx`
- `grep -q 'PushPermissionPrompt' "src/app/(dashboard)/layout.tsx"`
- `grep -q 'subscribePushAction' src/lib/push/subscribe.ts`

## Inputs

- `src/lib/push/vapid.ts` — getVapidKeys() for public key retrieval
- `src/lib/safe-action.ts` — authActionClient for authenticated actions
- `src/app/(dashboard)/layout.tsx` — dashboard layout to add PushPermissionPrompt
- `prisma/schema.prisma` — PushSubscription model from T01

## Expected Output

- `src/lib/push/subscribe.ts` — subscribePushAction and unsubscribePushAction server actions
- `src/lib/push/actions.ts` — getVapidPublicKeyAction server action
- `src/components/push-permission-prompt.tsx` — push permission prompt component
- `src/app/(dashboard)/layout.tsx` — updated with PushPermissionPrompt
- `src/__tests__/push/subscribe.test.ts` — subscription action tests
- `src/__tests__/components/push-permission-prompt.test.tsx` — prompt component tests
  - Files: `src/lib/push/subscribe.ts`, `src/lib/push/actions.ts`, `src/components/push-permission-prompt.tsx`, `src/app/(dashboard)/layout.tsx`, `src/__tests__/push/subscribe.test.ts`, `src/__tests__/components/push-permission-prompt.test.tsx`
  - Verify: pnpm vitest run src/__tests__/push/subscribe.test.ts && pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx && grep -q 'PushPermissionPrompt' "src/app/(dashboard)/layout.tsx"

- [ ] **T04: Create push sender and integrate into token rotation worker** `est:45m`
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
  - Files: `src/lib/push/send.ts`, `src/lib/queue/token-rotation.ts`, `src/__tests__/push/send.test.ts`, `src/__tests__/push/rotation-integration.test.ts`
  - Verify: pnpm vitest run src/__tests__/push/send.test.ts && pnpm vitest run src/__tests__/push/rotation-integration.test.ts && grep -q 'sendPushToUser' src/lib/queue/token-rotation.ts && pnpm vitest run

## Files Likely Touched

- prisma/schema.prisma
- src/lib/push/vapid.ts
- src/lib/constants.ts
- src/__tests__/push/vapid.test.ts
- package.json
- public/sw.js
- src/app/manifest.ts
- src/components/service-worker-register.tsx
- src/app/layout.tsx
- src/__tests__/components/service-worker-register.test.tsx
- src/lib/push/subscribe.ts
- src/lib/push/actions.ts
- src/components/push-permission-prompt.tsx
- src/app/(dashboard)/layout.tsx
- src/__tests__/push/subscribe.test.ts
- src/__tests__/components/push-permission-prompt.test.tsx
- src/lib/push/send.ts
- src/lib/queue/token-rotation.ts
- src/__tests__/push/send.test.ts
- src/__tests__/push/rotation-integration.test.ts
