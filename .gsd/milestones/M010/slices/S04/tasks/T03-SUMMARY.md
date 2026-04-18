---
id: T03
parent: S04
milestone: M010
key_files:
  - src/lib/push/subscribe.ts
  - src/lib/push/actions.ts
  - src/components/push-permission-prompt.tsx
  - src/app/(dashboard)/layout.tsx
  - src/__tests__/push/subscribe.test.ts
  - src/__tests__/components/push-permission-prompt.test.tsx
key_decisions:
  - Used deleteMany instead of delete for unsubscribe to avoid throwing on missing rows — graceful no-op if subscription already removed
  - Auto-subscribe on granted permission runs silently in useEffect with error swallowed — avoids blocking UI for background subscription sync
duration: 
verification_result: passed
completed_at: 2026-04-18T22:25:55.864Z
blocker_discovered: false
---

# T03: Add push subscription server actions (subscribe/unsubscribe/getVapidPublicKey) and PushPermissionPrompt component wired into dashboard layout

**Add push subscription server actions (subscribe/unsubscribe/getVapidPublicKey) and PushPermissionPrompt component wired into dashboard layout**

## What Happened

Built the client-to-server push subscription flow with three server actions and a dashboard prompt component.

**Server actions** (`src/lib/push/subscribe.ts`): `subscribePushAction` upserts a PushSubscription row using the Prisma unique constraint on (userId, endpoint), and `unsubscribePushAction` deletes matching rows. Both use `authActionClient` for authentication and validate input with Zod schemas. Log lines use `[push]` prefix and redact endpoint URLs to hostname only per slice redaction constraints.

**VAPID public key action** (`src/lib/push/actions.ts`): `getVapidPublicKeyAction` calls `getVapidPublicKey()` from vapid.ts and returns only the public key — the private key is never exposed to the client.

**PushPermissionPrompt component** (`src/components/push-permission-prompt.tsx`): Client component that handles all three Notification.permission states:
- `default`: Shows shadcn Alert with "Enable notifications" button and dismiss option. On click, requests permission and subscribes via pushManager + server action.
- `granted`: Auto-subscribes silently if no existing subscription found. Renders nothing.
- `denied`: Shows informational Alert explaining how to unblock in browser settings.

Dismiss persists to localStorage. Includes `base64urlToUint8Array` helper for converting VAPID public key to applicationServerKey format. Error handling shows retry message on subscribe failure without crashing.

Component wired into dashboard layout below TokenExpiryBanner.

## Verification

All 4 verification commands pass:
- `pnpm vitest run src/__tests__/push/subscribe.test.ts` — 5 tests pass (upsert, delete, auth rejection, input validation)
- `pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx` — 5 tests pass (default state, denied state, dismiss, granted state, previously dismissed)
- `grep -q 'PushPermissionPrompt' src/app/(dashboard)/layout.tsx` — found
- `grep -q 'subscribePushAction' src/lib/push/subscribe.ts` — found

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/push/subscribe.test.ts` | 0 | ✅ pass — 5 tests passed | 174ms |
| 2 | `pnpm vitest run src/__tests__/components/push-permission-prompt.test.tsx` | 0 | ✅ pass — 5 tests passed | 538ms |
| 3 | `grep -q 'PushPermissionPrompt' src/app/(dashboard)/layout.tsx` | 0 | ✅ pass | 10ms |
| 4 | `grep -q 'subscribePushAction' src/lib/push/subscribe.ts` | 0 | ✅ pass | 10ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/lib/push/subscribe.ts`
- `src/lib/push/actions.ts`
- `src/components/push-permission-prompt.tsx`
- `src/app/(dashboard)/layout.tsx`
- `src/__tests__/push/subscribe.test.ts`
- `src/__tests__/components/push-permission-prompt.test.tsx`
