---
estimated_steps: 36
estimated_files: 6
skills_used: []
---

# T01: Add auth schema, encryption utilities, and CoderClient auth methods

## Description

Foundation layer for auth: Prisma schema additions (User, CoderToken, Session), AES-256-GCM encryption utilities, and CoderClient methods for instance validation, login, and API key creation. All three are independently testable with no cross-dependencies.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder /buildinfo | Return specific 'not a Coder instance' error | Return 'connection timeout' error | Return 'not a Coder instance' error |
| Coder /users/login | Return 'invalid credentials' error | Return 'connection timeout' error | Throw with response body |
| Coder /users/{id}/keys | Return null (caller handles fallback) | Return null (caller handles fallback) | Throw with response body |

## Negative Tests

- **Malformed inputs**: empty encryption key, wrong-length key (not 32 bytes), empty plaintext, corrupted ciphertext
- **Error paths**: decrypt with wrong key (GCM auth tag mismatch), validateInstance against non-Coder URL, login with invalid credentials
- **Boundary conditions**: very long plaintext encryption, URL with/without trailing slash

## Steps

1. Add User, CoderToken, Session models to `prisma/schema.prisma`. User has `@@unique([coderUrl, coderUserId])`. CoderToken stores encrypted fields (ciphertext, iv, authTag) plus version for optimistic locking. Session stores sessionId (UUID), userId FK, expiresAt. All models use `@@map()` for snake_case table names.
2. Run `pnpm prisma generate` to update the Prisma client types.
3. Create `src/lib/auth/encryption.ts` with `encrypt(plaintext, key)` and `decrypt({ciphertext, iv, authTag}, key)` using Node.js `crypto` AES-256-GCM. Add `validateEncryptionKey(key)` that checks for exactly 32 bytes. All functions are pure — no env var reads (caller passes key).
4. Add static methods to CoderClient: `validateInstance(url)` — GET /api/v2/buildinfo with no auth, returns `{valid, version}` or `{valid: false, reason}` differentiating DNS/timeout/not-Coder. `login(baseUrl, email, password)` — POST /api/v2/users/login, returns session token + user info. `createApiKey(baseUrl, sessionToken, userId, lifetime?)` — POST /api/v2/users/{userId}/keys, returns API key string or null on failure.
5. Add types for auth responses to `src/lib/coder/types.ts`: BuildInfoResponse, LoginRequest, LoginResponse, CreateApiKeyRequest, CreateApiKeyResponse.
6. Create test file `src/__tests__/auth/encryption.test.ts` — round-trip encrypt/decrypt, wrong key detection, key validation.
7. Create test file `src/__tests__/auth/coder-auth.test.ts` — validateInstance (mock fetch for success, DNS error, non-Coder response), login (success, invalid creds), createApiKey (success, failure returns null).

## Must-Haves

- [ ] User model with @@unique([coderUrl, coderUserId]) and UUID primary key
- [ ] CoderToken model with encrypted fields (ciphertext, iv, authTag as Bytes) and version Int
- [ ] Session model with UUID sessionId, userId FK, expiresAt DateTime
- [ ] All models use @@map() for snake_case table names
- [ ] encrypt/decrypt round-trips correctly with AES-256-GCM
- [ ] decrypt with wrong key throws (GCM auth tag mismatch detection)
- [ ] validateEncryptionKey rejects non-32-byte keys
- [ ] CoderClient.validateInstance differentiates DNS/timeout/not-Coder errors
- [ ] CoderClient.login returns session token and user info on success
- [ ] CoderClient.createApiKey returns key string or null on failure
- [ ] All tests pass

## Verification

- `pnpm prisma generate` succeeds without errors
- `pnpm vitest run src/__tests__/auth/encryption.test.ts` — all tests pass
- `pnpm vitest run src/__tests__/auth/coder-auth.test.ts` — all tests pass

## Inputs

- ``prisma/schema.prisma` — existing schema with Task, TaskLog, Workspace models`
- ``src/lib/coder/client.ts` — existing CoderClient class to extend with auth methods`
- ``src/lib/coder/types.ts` — existing type definitions to extend`

## Expected Output

- ``prisma/schema.prisma` — extended with User, CoderToken, Session models`
- ``src/lib/auth/encryption.ts` — new AES-256-GCM encrypt/decrypt utilities`
- ``src/lib/coder/client.ts` — extended with validateInstance, login, createApiKey static methods`
- ``src/lib/coder/types.ts` — extended with BuildInfoResponse, LoginRequest, LoginResponse, CreateApiKeyRequest, CreateApiKeyResponse`
- ``src/__tests__/auth/encryption.test.ts` — encryption unit tests`
- ``src/__tests__/auth/coder-auth.test.ts` — CoderClient auth method tests`

## Verification

pnpm prisma generate && pnpm vitest run src/__tests__/auth/encryption.test.ts src/__tests__/auth/coder-auth.test.ts
