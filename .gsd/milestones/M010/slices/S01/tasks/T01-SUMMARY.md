---
id: T01
parent: S01
milestone: M010
key_files:
  - prisma/schema.prisma
  - src/lib/auth/encryption.ts
  - src/lib/coder/client.ts
  - src/lib/coder/types.ts
  - src/__tests__/auth/encryption.test.ts
  - src/__tests__/auth/coder-auth.test.ts
key_decisions:
  - Encryption functions take hex key as parameter (no env var reads) for testability and flexibility
  - CoderClient auth methods are static (no instance needed) since they operate before a session exists
  - validateInstance uses AbortSignal.timeout(10s) for consistent timeout behavior
  - createApiKey returns null on failure instead of throwing, per task plan spec for caller-handled fallback
duration: 
verification_result: passed
completed_at: 2026-04-18T19:44:36.588Z
blocker_discovered: false
---

# T01: Add User/CoderToken/Session Prisma models, AES-256-GCM encryption utilities, and CoderClient static auth methods (validateInstance, login, createApiKey)

**Add User/CoderToken/Session Prisma models, AES-256-GCM encryption utilities, and CoderClient static auth methods (validateInstance, login, createApiKey)**

## What Happened

Added three new Prisma models to the schema: User (with @@unique on coderUrl+coderUserId), CoderToken (with encrypted ciphertext/iv/authTag as Bytes and version for optimistic locking), and Session (with UUID sessionId, userId FK, expiresAt). All models use @@map() for snake_case table names.

Created `src/lib/auth/encryption.ts` with pure AES-256-GCM encrypt/decrypt functions and key validation — caller passes the hex key, no env var coupling. The encrypt function generates a random 12-byte IV per call.

Extended CoderClient with three static methods: `validateInstance` (GET /buildinfo, differentiates DNS/timeout/not-Coder errors), `login` (POST /users/login + GET /users/me to return session token + user info), and `createApiKey` (POST /users/{id}/keys, returns key string or null on failure). All methods handle trailing slashes and use AbortSignal.timeout(10s).

Added auth response types to `src/lib/coder/types.ts`: BuildInfoResponse, LoginRequest/Response, CreateApiKeyRequest/Response, ValidateInstanceResult, LoginResult, CoderUserResponse.

Created comprehensive test suites: 14 encryption tests (round-trip, wrong key detection, corrupted ciphertext/authTag, key validation, long strings, unicode) and 14 CoderClient auth tests (validateInstance success/DNS/timeout/non-Coder, login success/401/500, createApiKey success/failure/null/lifetime).

## Verification

Ran `pnpm prisma generate` — succeeded. Ran `pnpm vitest run src/__tests__/auth/encryption.test.ts src/__tests__/auth/coder-auth.test.ts` — all 28 tests passed across 2 test files in 237ms.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm prisma generate` | 0 | ✅ pass | 1200ms |
| 2 | `pnpm vitest run src/__tests__/auth/encryption.test.ts src/__tests__/auth/coder-auth.test.ts` | 0 | ✅ pass (28/28 tests) | 237ms |

## Deviations

None. Implementation matched the task plan.

## Known Issues

None.

## Files Created/Modified

- `prisma/schema.prisma`
- `src/lib/auth/encryption.ts`
- `src/lib/coder/client.ts`
- `src/lib/coder/types.ts`
- `src/__tests__/auth/encryption.test.ts`
- `src/__tests__/auth/coder-auth.test.ts`
