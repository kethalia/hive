---
id: T01
parent: S03
milestone: M010
key_files:
  - prisma/schema.prisma
  - prisma/migrations/20250418200000_add_coder_token_expires_at/migration.sql
  - src/lib/constants.ts
  - src/lib/auth/encryption.ts
  - src/lib/coder/types.ts
  - src/lib/coder/client.ts
  - src/lib/auth/login.ts
  - src/__tests__/auth/token-lifecycle.test.ts
key_decisions:
  - tryDecrypt classifies GCM auth failures as key_mismatch by inspecting error message substrings ('unable to authenticate', 'unsupported state') — this is the standard Node.js crypto error surface for AES-256-GCM tag verification failure
  - listApiKeys/deleteApiKey are static methods (not instance methods) to match the existing createApiKey pattern — they take baseUrl and sessionToken as parameters for use during rotation without constructing a full CoderClient
  - Database not reachable during execution — migration SQL written manually as a standard ALTER TABLE ADD COLUMN
duration: 
verification_result: passed
completed_at: 2026-04-18T20:50:47.527Z
blocker_discovered: false
---

# T01: Add expiresAt column to CoderToken, tryDecrypt with GCM error classification, Coder API key list/delete methods, and login lifetime integration

**Add expiresAt column to CoderToken, tryDecrypt with GCM error classification, Coder API key list/delete methods, and login lifetime integration**

## What Happened

Extended the CoderToken schema with a nullable `expiresAt` timestamp column and created a Prisma migration. Added `tryDecrypt()` to the encryption module that wraps `decrypt()` and returns a discriminated union — `{ ok: true, plaintext }` on success, `{ ok: false, reason: 'key_mismatch' | 'other', error }` on failure — by inspecting GCM authentication error messages. Added `ApiKeyInfo` type and `ListApiKeysResponse` to the Coder types module. Added `listApiKeys` and `deleteApiKey` static methods to `CoderClient` with 10s timeouts, type guards on the response, and graceful error handling (empty array / false on failure). Updated `performLogin` to pass `TOKEN_LIFETIME_SECONDS` (30 days) to `createApiKey`, compute `expiresAt` based on credential type (30 days for API keys, 24h for session token fallback), and persist it in the CoderToken upsert. Added five token lifecycle constants to `constants.ts`: `TOKEN_LIFETIME_SECONDS`, `TOKEN_ROTATION_THRESHOLD`, `TOKEN_EXPIRY_WARNING_HOURS`, `TOKEN_PREFLIGHT_MIN_HOURS`, `TOKEN_ROTATION_QUEUE`.

## Verification

Ran `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts` — all 12 tests pass (tryDecrypt valid/wrong-key/corrupted/truncated-IV/empty-authTag, listApiKeys success/error/network-error, deleteApiKey 204/200/error/network-error). Ran `pnpm prisma generate` — Prisma client generated successfully with new expiresAt field.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts` | 0 | ✅ pass | 164ms |
| 2 | `pnpm prisma generate` | 0 | ✅ pass | 3000ms |

## Deviations

Database was unreachable so `prisma migrate dev` could not run. Created the migration SQL file manually (`ALTER TABLE coder_tokens ADD COLUMN expires_at TIMESTAMPTZ`) and ran `prisma generate` to update the client. The migration will apply on next database connection.

## Known Issues

Migration has not been applied to the database (DB unreachable). It will apply on next `prisma migrate deploy` or `prisma migrate dev` run.

## Files Created/Modified

- `prisma/schema.prisma`
- `prisma/migrations/20250418200000_add_coder_token_expires_at/migration.sql`
- `src/lib/constants.ts`
- `src/lib/auth/encryption.ts`
- `src/lib/coder/types.ts`
- `src/lib/coder/client.ts`
- `src/lib/auth/login.ts`
- `src/__tests__/auth/token-lifecycle.test.ts`
