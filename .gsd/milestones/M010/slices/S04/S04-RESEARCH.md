# S04 — PWA & Push Notifications — Research

**Date:** 2026-04-18
**Depth:** Targeted — known Web APIs (PWA manifest, Service Worker, Web Push) applied to an established Next.js 16 codebase with clear patterns from S01/S03.

## Summary

S04 adds three capabilities: (1) a web app manifest + service worker so the app installs as a PWA, (2) server-side Web Push notifications triggered by the token rotation worker when a token is 24h from expiry, and (3) a notification click handler that opens the login page. The codebase already has all the integration points — the token rotation worker (`src/lib/queue/token-rotation.ts`) already detects tokens approaching expiry, the dashboard layout already renders status banners, and the auth system provides session-scoped user identity.

The recommended approach is manual service worker + Next.js metadata API for the manifest (no `next-pwa` or `serwist` plugin needed — the scope is minimal caching + push event handling). Server-side push uses the `web-push` npm package. VAPID keys should be auto-generated on first use and persisted to the database (avoids requiring additional env vars).

Requirements served: **R103** (PWA installability), **R104** (push notifications for token expiry), **R109** (login UI styling — already largely met by S01's shadcn implementation; this slice adds the notification-opens-login-page behavior).

## Recommendation

**Manual service worker + `web-push` library.** No PWA framework plugin. Reasons:

1. The service worker only needs two handlers: `push` (show notification) and `notificationclick` (open `/login`). No offline caching strategy needed — Hive requires a live Coder connection.
2. Next.js 16 supports `src/app/manifest.ts` as a route handler that exports manifest JSON — no static file or plugin needed.
3. `web-push` (npm) is the standard Node.js library for VAPID-based Web Push. It handles payload encryption and VAPID signing. 1.2M weekly downloads, stable API.
4. VAPID keys: auto-generate with `web-push.generateVAPIDKeys()` on first startup, persist to a `VapidKeys` singleton table. Expose public key via `NEXT_PUBLIC_VAPID_PUBLIC_KEY` env var or a server action. This avoids requiring users to manually generate and configure VAPID keys.

## Implementation Landscape

### Key Files

- `prisma/schema.prisma` — Add `PushSubscription` model (userId, endpoint, p256dh, auth) with `@@unique([userId, endpoint])`. Add `VapidKeys` singleton model (id=1, publicKey, privateKey). Add `pushSubscriptions` relation to User.
- `src/app/manifest.ts` — Next.js route-based manifest export. Returns JSON with `name`, `short_name`, `start_url: "/"`, `display: "standalone"`, `background_color`, `theme_color`, icons array.
- `public/sw.js` — Static service worker file. Handles `push` event (show notification with title/body/icon/tag) and `notificationclick` event (`clients.openWindow("/login")`). No fetch caching.
- `src/lib/push/vapid.ts` — `getVapidKeys()` function: reads from DB, auto-generates if missing, caches in module-level variable. Used by server-side push sender.
- `src/lib/push/send.ts` — `sendPushToUser(userId, payload)` function: queries PushSubscription rows for user, calls `webpush.sendNotification()` for each, removes subscriptions that return 410 Gone (expired).
- `src/lib/push/subscribe.ts` — Server action `subscribePushAction(subscription)` — validates auth via `authActionClient`, upserts PushSubscription row. Server action `unsubscribePushAction(endpoint)` — deletes row.
- `src/components/push-permission-prompt.tsx` — Client component rendered in dashboard layout. Checks `Notification.permission`, shows a shadcn Alert with "Enable notifications" button. On grant: registers service worker, calls `pushManager.subscribe()` with VAPID public key, sends subscription to server action. Dismissible, remembers dismissal in localStorage.
- `src/components/service-worker-register.tsx` — Client component in root layout. Calls `navigator.serviceWorker.register("/sw.js")` on mount. No UI.
- `src/app/layout.tsx` — Add `<ServiceWorkerRegister />` client component. Add viewport metadata for PWA (`themeColor`, `appleWebApp`).
- `src/app/(dashboard)/layout.tsx` — Add `<PushPermissionPrompt />` below `TokenExpiryBanner`.
- `src/lib/queue/token-rotation.ts` — After the expiry detection loop, add: if token has ≤24h remaining and rotation succeeded (or failed), call `sendPushToUser(token.userId, { title, body, tag })`.
- `src/lib/constants.ts` — Add `PUSH_NOTIFICATION_HOURS = 24` constant for the notification threshold.

### Build Order

1. **T01: Schema + VAPID key management** — Add `PushSubscription` and `VapidKeys` models to Prisma. Create `vapid.ts` with auto-generate-and-persist logic. This unblocks everything else.
2. **T02: Service worker + manifest + registration** — Create `public/sw.js`, `src/app/manifest.ts`, `ServiceWorkerRegister` component, wire into root layout. After this, the app is installable as a PWA (R103).
3. **T03: Push subscription management** — Create `subscribePushAction`/`unsubscribePushAction` server actions and `PushPermissionPrompt` component. Wire into dashboard layout. After this, users can subscribe to notifications.
4. **T04: Push notification sender + rotation integration** — Create `sendPushToUser()`, integrate into `processTokenRotation()` to fire at 24h threshold. After this, push notifications fire on token expiry approach (R104). Notification click opens `/login` (already handled by sw.js from T02).

### Verification Approach

- `pnpm prisma generate` — PushSubscription and VapidKeys models compile
- `pnpm vitest run` — All existing tests still pass (no regressions)
- New tests for: `vapid.ts` (auto-generate, cache, persist), `send.ts` (sendPushToUser with mock web-push, 410 cleanup), `subscribe.ts` (upsert, delete), `push-permission-prompt.tsx` (render states, button click), service worker registration component
- `grep -q '"display":"standalone"' <(curl -s localhost:3000/manifest.webmanifest)` — manifest serves correctly (or check via `src/app/manifest.ts` export)
- Manual: open Chrome DevTools → Application → Manifest → verify installable; Application → Service Workers → verify registered; Application → Push Messaging → test push

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| VAPID signing + payload encryption for Web Push | `web-push` npm package | RFC 8291/8292 encryption is complex. `web-push` handles it with a single `sendNotification()` call. 1.2M weekly downloads, stable. |
| Web app manifest serving | Next.js `src/app/manifest.ts` route | Built-in Next.js feature — exports JSON, auto-serves at `/manifest.webmanifest`. No static file management. |

## Constraints

- Service worker requires HTTPS in production (localhost exempt for dev). Coder workspace proxy provides HTTPS.
- `web-push` `sendNotification()` is async and can throw on network errors or expired subscriptions (410 Gone) — must handle gracefully in the rotation worker (log and continue, never block rotation).
- VAPID public key must be available client-side. Options: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` env var, or a server action that reads from DB. Server action is preferred (auto-generated keys don't need env var setup).
- `PushManager.subscribe()` requires the `applicationServerKey` as a `Uint8Array` — must base64url-decode the VAPID public key on the client.
- Next.js 16 with App Router: service worker file must be in `public/` (not processed by webpack). The `manifest.ts` route handler is the idiomatic approach.

## Common Pitfalls

- **Notification permission denied permanently** — Once the user clicks "Block", `Notification.requestPermission()` always returns `"denied"` with no re-prompt. The prompt component must check permission state and show instructions to unblock in browser settings if denied.
- **Stale push subscriptions** — Browser subscriptions expire or get revoked silently. `sendNotification()` returns 410 Gone for dead subscriptions. Must delete these rows from DB to avoid growing dead data.
- **Service worker scope** — `public/sw.js` gets scope `/` by default, which is correct. Don't place it in a subdirectory or the push handler won't fire.
- **Multiple tabs** — `notificationclick` handler must check for existing open tabs via `clients.matchAll()` and focus one if found, rather than always opening a new window.

## Open Risks

- Push notification delivery is best-effort — browser vendors (Chrome/Firefox) may delay or drop notifications. Not a reliability concern for this use case (supplementary to in-app banner).
- VAPID key rotation is not addressed — if the VapidKeys row is deleted or changed, all existing subscriptions become invalid. Low risk for single-instance deployment; document the constraint.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| PWA | alinaqi/claude-bootstrap@pwa-development | available (1.1K installs) |
| Web Push | (none found) | none found |

## Sources

- Next.js App Router metadata/manifest: built-in `src/app/manifest.ts` export (project uses Next.js 16)
- Web Push API: standard browser API, `PushManager.subscribe()` + `ServiceWorkerRegistration.pushManager`
- `web-push` npm: VAPID key generation, `sendNotification()` with automatic payload encryption
