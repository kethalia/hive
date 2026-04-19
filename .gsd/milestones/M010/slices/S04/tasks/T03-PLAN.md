---
estimated_steps: 52
estimated_files: 6
skills_used: []
---

# T03: Build push subscription server actions and permission prompt component

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

## Inputs

- ``src/lib/push/vapid.ts` — getVapidKeys() for VAPID public key retrieval`
- ``src/lib/safe-action.ts` — authActionClient for authenticated server actions`
- ``src/app/(dashboard)/layout.tsx` — dashboard layout to wire PushPermissionPrompt into`
- ``prisma/schema.prisma` — PushSubscription model for DB operations`

## Expected Output

- ``src/lib/push/subscribe.ts` — subscribe and unsubscribe server actions`
- ``src/lib/push/actions.ts` — getVapidPublicKeyAction server action`
- ``src/components/push-permission-prompt.tsx` — push permission prompt with shadcn Alert/Button`
- ``src/app/(dashboard)/layout.tsx` — updated with PushPermissionPrompt below TokenExpiryBanner`
- ``src/__tests__/push/subscribe.test.ts` — subscription action tests`
- ``src/__tests__/components/push-permission-prompt.test.tsx` — prompt component tests`

## Verification

pnpm vitest run src/__tests__/push/subscribe.test.ts && pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx && grep -q 'PushPermissionPrompt' "src/app/(dashboard)/layout.tsx"
