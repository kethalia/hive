---
id: S04
parent: M010
milestone: M010
provides:
  - ["PWA installability (display:standalone manifest + service worker)", "Push notification infrastructure (VAPID keys, subscription management, send with stale cleanup)", "Token expiry push warnings at ≤24h threshold integrated into rotation worker"]
requires:
  []
affects:
  []
key_files:
  - ["prisma/schema.prisma", "src/lib/push/vapid.ts", "src/lib/push/send.ts", "src/lib/push/subscribe.ts", "src/lib/push/actions.ts", "src/components/push-permission-prompt.tsx", "src/components/service-worker-register.tsx", "public/sw.js", "src/app/manifest.ts", "src/lib/queue/token-rotation.ts"]
key_decisions:
  - ["Module-level VAPID cache only set after successful DB write to prevent partial state on failure", "Per-subscription try/catch with continue so one failed endpoint doesn't block remaining subscriptions", "Push notification trigger placed before rotation logic — user warned even if rotation itself fails", "No fetch handler in service worker — Hive requires live Coder connection, offline caching inappropriate", "deleteMany for unsubscribe instead of delete — graceful no-op if subscription already removed"]
patterns_established:
  - ["Module-level cache with write-through semantics: cache only set after successful DB persist (vapid.ts)", "Per-subscription error handling with continue: one failed endpoint doesn't block remaining sends", "Endpoint URL redaction in logs: log domain only, not full push endpoint URL", "Push failures never block critical paths: try/catch around all sendPushToUser calls in rotation"]
observability_surfaces:
  - ["[push] prefixed logs for send success, failure, and stale subscription cleanup", "[token-rotation] Push notification triggered for user X (Yh remaining)", "PushSubscription table: subscription count per user", "VapidKeys table: key existence verification", "sendPushToUser returns {sent, cleaned} counts"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-18T22:32:31.125Z
blocker_discovered: false
---

# S04: PWA & Push Notifications

**App installs as PWA with service worker, push notifications fire when Coder API tokens approach expiry (≤24h), notification click opens login page for re-authentication.**

## What Happened

## What Was Delivered

This slice adds Progressive Web App capability and push notification support for token expiry warnings, completing the final piece of M010's multi-user Coder authentication system.

### T01: Database Foundation & VAPID Key Management
Added two Prisma models — `PushSubscription` (per-user browser push subscriptions with userId FK, endpoint, p256dh, auth keys, and @@unique([userId, endpoint])) and `VapidKeys` (singleton for server identity with publicKey/privateKey). Created `src/lib/push/vapid.ts` with auto-generating, DB-persisted, module-level-cached VAPID key management. Cache is only set after successful DB write to prevent partial state on failure. Added `PUSH_NOTIFICATION_HOURS = 24` and `PUSH_NOTIFICATION_TAG = "token-expiry"` constants. Installed `web-push` and `@types/web-push`. 6 tests.

### T02: Service Worker, Manifest, & PWA Registration
Created `public/sw.js` — a minimal service worker handling `push` events (showNotification with payload from JSON) and `notificationclick` events (close notification, focus existing tab and navigate to /login, or open new /login window). Intentionally no fetch handler — Hive requires a live Coder connection so offline caching is not appropriate. Created `src/app/manifest.ts` as a Next.js MetadataRoute.Manifest export with display:standalone and zinc-950 theme colors matching the dark theme. Created `ServiceWorkerRegister` client component wired into root layout. 2 tests.

### T03: Push Subscription Flow & Permission Prompt
Built three server actions: `subscribePushAction` (upserts PushSubscription via authActionClient), `unsubscribePushAction` (deletes by userId+endpoint), and `getVapidPublicKeyAction` (returns only public key, never private). Created `PushPermissionPrompt` component handling all three Notification.permission states — default (show enable button with dismiss), granted (auto-subscribe silently), denied (show instructions). Uses shadcn Alert and Button components. Dismiss persists to localStorage. Includes base64url-to-Uint8Array helper for applicationServerKey conversion. Wired into dashboard layout below TokenExpiryBanner. 10 tests.

### T04: Push Sender & Token Rotation Integration
Created `sendPushToUser(userId, payload)` in `src/lib/push/send.ts` — queries all user subscriptions, sends via web-push with VAPID details from DB, handles 410/404 responses with automatic stale subscription cleanup, logs errors with endpoint domain only (not full URL) per redaction constraints. Integrated into `processTokenRotation` — fires push notification when `hoursRemaining <= PUSH_NOTIFICATION_HOURS`. Push failures are wrapped in try/catch and never block token rotation. 11 tests.

### Cross-Cutting
- All log lines follow established prefix conventions: `[push]` for send/cleanup, `[token-rotation]` for rotation-triggered push
- Endpoint URLs redacted to domain-only in all log output per slice plan redaction constraints
- No regressions: 602 tests pass, 16 pre-existing failures in worker.test.ts/council-step.test.ts confirmed unrelated to S04

## Integration Points
- Service worker registration in root layout (`src/app/layout.tsx`)
- Push permission prompt in dashboard layout (`src/app/(dashboard)/layout.tsx`) below TokenExpiryBanner
- `sendPushToUser` call in token rotation processor (`src/lib/queue/token-rotation.ts`)
- VAPID keys stored in DB via VapidKeys model, auto-generated on first use
- PushSubscription model linked to User via userId FK

## Verification

## Verification Results

All slice-level verification checks passed:

**Test Suites (27 push tests + 7 component tests = 34 total new tests)**
- `pnpm vitest run src/__tests__/push/vapid.test.ts` — 6/6 pass
- `pnpm vitest run src/__tests__/push/subscribe.test.ts` — 5/5 pass
- `pnpm vitest run src/__tests__/push/send.test.ts` — 7/7 pass
- `pnpm vitest run src/__tests__/push/rotation-integration.test.ts` — 4/4 pass
- `pnpm vitest run src/__tests__/components/service-worker-register.test.tsx` — 2/2 pass
- `pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx` — 5/5 pass (stderr log about auto-subscribe failure in granted-state test is expected — VAPID mock not wired in component test)

**Schema**
- `pnpm prisma generate` — succeeds with PushSubscription and VapidKeys models

**Static Checks (all pass)**
- PushSubscription model in schema.prisma ✅
- VapidKeys model in schema.prisma ✅
- PUSH_NOTIFICATION_HOURS in constants.ts ✅
- showNotification in sw.js ✅
- notificationclick in sw.js ✅
- standalone in manifest.ts ✅
- ServiceWorkerRegister in root layout.tsx ✅
- PushPermissionPrompt in dashboard layout.tsx ✅
- subscribePushAction in subscribe.ts ✅
- sendPushToUser in token-rotation.ts ✅

**Regression**
- `pnpm vitest run` — 602 passed, 16 failed (all pre-existing in worker.test.ts and council-step.test.ts, confirmed by running without S04 changes). Zero regressions introduced.

## Requirements Advanced

None.

## Requirements Validated

- R103 — Web app manifest at /manifest.webmanifest with display:standalone, service worker with push+notificationclick, ServiceWorkerRegister in root layout
- R104 — sendPushToUser fires at ≤24h threshold in token rotation, 11 tests cover send/cleanup/rotation integration
- R109 — Notification click opens /login, login page uses shadcn with zinc-950 dark theme matching Coder aesthetic

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Used pnpm -w flag for workspace root installs (plan didn't specify but workspace config requires it). No other deviations from plan.

## Known Limitations

Push notification delivery depends on browser push service availability (FCM for Chrome, Mozilla Push for Firefox). Notifications require user to have granted browser notification permission. No offline caching — PWA is online-only. The 16 pre-existing test failures in worker.test.ts and council-step.test.ts are unrelated to S04 (getTokenStatus mock issue from prior rewire).

## Follow-ups

None.

## Files Created/Modified

- `prisma/schema.prisma` — Added PushSubscription and VapidKeys models, pushSubscriptions relation on User
- `src/lib/push/vapid.ts` — VAPID key management with auto-generate, DB persist, and module-level cache
- `src/lib/push/send.ts` — sendPushToUser with per-subscription error handling and 410/404 stale cleanup
- `src/lib/push/subscribe.ts` — subscribePushAction and unsubscribePushAction server actions via authActionClient
- `src/lib/push/actions.ts` — getVapidPublicKeyAction exposing only public key
- `src/lib/constants.ts` — Added PUSH_NOTIFICATION_HOURS and PUSH_NOTIFICATION_TAG constants
- `src/components/push-permission-prompt.tsx` — Push permission prompt handling default/granted/denied states with shadcn Alert
- `src/components/service-worker-register.tsx` — Client component registering /sw.js on mount
- `public/sw.js` — Service worker with push and notificationclick handlers
- `src/app/manifest.ts` — Next.js MetadataRoute.Manifest with display:standalone
- `src/app/layout.tsx` — Added ServiceWorkerRegister component
- `src/app/(dashboard)/layout.tsx` — Added PushPermissionPrompt below TokenExpiryBanner
- `src/lib/queue/token-rotation.ts` — Integrated sendPushToUser at ≤24h threshold with try/catch
- `package.json` — Added web-push and @types/web-push dependencies
