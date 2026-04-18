---
estimated_steps: 39
estimated_files: 5
skills_used: []
---

# T01: Add PushSubscription/VapidKeys schema, VAPID key manager, and web-push dependency

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

## Inputs

- ``prisma/schema.prisma` — existing schema to extend with PushSubscription and VapidKeys models`
- ``src/lib/constants.ts` — existing constants file to add push notification constants`
- ``package.json` — add web-push dependency`

## Expected Output

- ``prisma/schema.prisma` — updated with PushSubscription, VapidKeys models and User.pushSubscriptions relation`
- ``src/lib/push/vapid.ts` — VAPID key management module with auto-generate, persist, and cache`
- ``src/lib/constants.ts` — updated with PUSH_NOTIFICATION_HOURS and PUSH_NOTIFICATION_TAG constants`
- ``src/__tests__/push/vapid.test.ts` — tests for vapid key auto-generation and caching`
- ``package.json` — web-push added to dependencies`

## Verification

pnpm prisma generate && pnpm vitest run src/__tests__/push/vapid.test.ts && grep -q 'PushSubscription' prisma/schema.prisma && grep -q 'PUSH_NOTIFICATION_HOURS' src/lib/constants.ts
