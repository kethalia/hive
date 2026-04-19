---
id: T01
parent: S04
milestone: M010
key_files:
  - prisma/schema.prisma
  - src/lib/push/vapid.ts
  - src/lib/constants.ts
  - src/__tests__/push/vapid.test.ts
  - package.json
key_decisions:
  - Used module-level cache that is only set after successful DB write to prevent partial state on failure
  - Exported clearVapidCache() to allow test isolation without exposing internal state
duration: 
verification_result: passed
completed_at: 2026-04-18T21:15:22.918Z
blocker_discovered: false
---

# T01: Add PushSubscription/VapidKeys Prisma models, VAPID key manager with auto-generate and caching, web-push dependency, and push notification constants

**Add PushSubscription/VapidKeys Prisma models, VAPID key manager with auto-generate and caching, web-push dependency, and push notification constants**

## What Happened

Installed `web-push` (runtime) and `@types/web-push` (dev) via pnpm with workspace root flag. Added two new Prisma models to `prisma/schema.prisma`: `PushSubscription` with userId FK, endpoint, p256dh, auth fields and `@@unique([userId, endpoint])`, and `VapidKeys` singleton with publicKey/privateKey and `@@map("vapid_keys")`. Added `pushSubscriptions` relation to the User model. Ran `pnpm prisma generate` to confirm schema compiles.

Created `src/lib/push/vapid.ts` with `getVapidKeys()` that checks a module-level cache, then queries DB, and if empty generates keys via `webpush.generateVAPIDKeys()`, persists them, and caches. Cache is only set after successful DB write to avoid partial state on failure. Exported `getVapidPublicKey()` convenience wrapper and `clearVapidCache()` for testing.

Added `PUSH_NOTIFICATION_HOURS = 24` and `PUSH_NOTIFICATION_TAG = "token-expiry"` constants to `src/lib/constants.ts`.

Created `src/__tests__/push/vapid.test.ts` with 6 tests covering: auto-generation when DB empty, cache hit on second call, returning existing keys from DB, no caching on DB create failure, no caching on DB find failure, and getVapidPublicKey returning only public key.

## Verification

All verification checks passed:
- `pnpm prisma generate` succeeds
- `pnpm vitest run src/__tests__/push/vapid.test.ts` — 6/6 tests pass
- `grep -q 'PushSubscription' prisma/schema.prisma` — found
- `grep -q 'VapidKeys' prisma/schema.prisma` — found
- `grep -q 'PUSH_NOTIFICATION_HOURS' src/lib/constants.ts` — found
- `grep -q 'PUSH_NOTIFICATION_TAG' src/lib/constants.ts` — found

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm prisma generate` | 0 | ✅ pass | 1200ms |
| 2 | `pnpm vitest run src/__tests__/push/vapid.test.ts` | 0 | ✅ pass (6/6 tests) | 156ms |
| 3 | `grep -q 'PushSubscription' prisma/schema.prisma` | 0 | ✅ pass | 5ms |
| 4 | `grep -q 'VapidKeys' prisma/schema.prisma` | 0 | ✅ pass | 5ms |
| 5 | `grep -q 'PUSH_NOTIFICATION_HOURS' src/lib/constants.ts` | 0 | ✅ pass | 5ms |
| 6 | `grep -q 'PUSH_NOTIFICATION_TAG' src/lib/constants.ts` | 0 | ✅ pass | 5ms |

## Deviations

Used pnpm -w flag for workspace root installs (plan didn't specify but workspace config requires it).

## Known Issues

None

## Files Created/Modified

- `prisma/schema.prisma`
- `src/lib/push/vapid.ts`
- `src/lib/constants.ts`
- `src/__tests__/push/vapid.test.ts`
- `package.json`
