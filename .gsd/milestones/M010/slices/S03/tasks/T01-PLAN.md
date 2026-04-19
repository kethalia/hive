---
estimated_steps: 58
estimated_files: 7
skills_used: []
---

# T01: Add expiresAt to CoderToken, tryDecrypt with GCM classification, Coder API key management methods, and login lifetime

## Description

Foundation task that extends the schema, encryption, Coder client, and login flow for all downstream token lifecycle work.

## Threat Surface

- **Abuse**: Token rotation API calls use the user's own credential — no privilege escalation. deleteApiKey requires valid session token + correct userId.
- **Data exposure**: Decrypted tokens exist only in memory during rotation. tryDecrypt returns typed errors, never leaks plaintext on failure.
- **Input trust**: lifetimeSeconds is a hardcoded constant, not user input. API key list/delete use userId from DB, not from request.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Coder API (listApiKeys) | Return empty array, log warning | AbortSignal.timeout(10s), return empty array | Type guard, return empty array |
| Coder API (deleteApiKey) | Log warning, continue (old key expires naturally) | AbortSignal.timeout(10s), log warning | Ignore — DELETE returns 204 no content |
| Prisma migration | Fail fast — schema must be consistent | N/A | N/A |

## Negative Tests

- **Malformed inputs**: tryDecrypt with corrupted ciphertext, truncated IV, empty authTag
- **Error paths**: tryDecrypt with wrong key returns `{ ok: false, reason: 'key_mismatch' }`, not throw
- **Boundary conditions**: listApiKeys returns empty array when user has no keys

## Steps

1. Add `expiresAt DateTime? @map("expires_at") @db.Timestamptz` to CoderToken in `prisma/schema.prisma`. Run `pnpm prisma migrate dev --name add-coder-token-expires-at` to create and apply the migration. The field is nullable because pre-existing tokens lack expiry data.

2. Add token lifecycle constants to `src/lib/constants.ts`:
   - `TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60` (2,592,000 — 30 days)
   - `TOKEN_ROTATION_THRESHOLD = 0.75` (rotate at 75% lifetime)
   - `TOKEN_EXPIRY_WARNING_HOURS = 48` (banner threshold)
   - `TOKEN_PREFLIGHT_MIN_HOURS = 2` (worker refusal threshold)
   - `TOKEN_ROTATION_QUEUE = "token-rotation"`

3. Add `tryDecrypt()` to `src/lib/auth/encryption.ts`:
   ```typescript
   export type DecryptResult = 
     | { ok: true; plaintext: string }
     | { ok: false; reason: 'key_mismatch' | 'other'; error: Error };
   
   export function tryDecrypt(data: EncryptedData, keyHex: string): DecryptResult
   ```
   Catch the error from `decrypt()`. Check for 'unable to authenticate' or 'Unsupported state' in the error message to classify as `key_mismatch`. All other errors are `other`.

4. Add types to `src/lib/coder/types.ts`:
   - `ApiKeyInfo` interface: `{ id: string; expires_at: string; last_used: string }`
   - `ListApiKeysResponse` as `ApiKeyInfo[]`

5. Add two static methods to `src/lib/coder/client.ts`:
   - `static async listApiKeys(baseUrl, sessionToken, userId): Promise<ApiKeyInfo[]>` — GET `/api/v2/users/{userId}/keys`, returns array or empty on error
   - `static async deleteApiKey(baseUrl, sessionToken, userId, keyId): Promise<boolean>` — DELETE `/api/v2/users/{userId}/keys/{keyId}`, returns true on 204/success, false on error

6. Update `performLogin()` in `src/lib/auth/login.ts`:
   - Import `TOKEN_LIFETIME_SECONDS` from constants
   - Pass `TOKEN_LIFETIME_SECONDS` as `lifetimeSeconds` to `CoderClient.createApiKey()`
   - After successful API key creation, calculate `expiresAt = new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000)`
   - Add `expiresAt` to the CoderToken upsert (both create and update)
   - When falling back to session token, set `expiresAt` to `new Date(Date.now() + 24 * 60 * 60 * 1000)` (24h session token default)

7. Write tests in `src/__tests__/auth/token-lifecycle.test.ts`:
   - tryDecrypt with valid key returns `{ ok: true, plaintext }`
   - tryDecrypt with wrong key returns `{ ok: false, reason: 'key_mismatch' }`
   - tryDecrypt with corrupted data returns `{ ok: false, reason: 'other' }`
   - CoderClient.listApiKeys returns array (mock fetch)
   - CoderClient.listApiKeys returns empty on error (mock fetch)
   - CoderClient.deleteApiKey returns true on success (mock fetch)
   - CoderClient.deleteApiKey returns false on error (mock fetch)

8. Run `pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts` and `pnpm prisma generate` to verify.

## Observability Impact

- Signals added: tryDecrypt returns structured reason code instead of opaque exception
- How a future agent inspects this: query CoderToken.expiresAt to see token lifetime, check tryDecrypt result.reason for key mismatch diagnosis
- Failure state exposed: 'key_mismatch' reason distinguishes encryption key rotation from data corruption

## Inputs

- ``prisma/schema.prisma` — CoderToken model to extend with expiresAt`
- ``src/lib/auth/encryption.ts` — existing encrypt/decrypt to wrap with tryDecrypt`
- ``src/lib/coder/client.ts` — CoderClient class to extend with listApiKeys/deleteApiKey`
- ``src/lib/coder/types.ts` — existing API types to extend`
- ``src/lib/auth/login.ts` — performLogin to update with lifetimeSeconds and expiresAt`
- ``src/lib/constants.ts` — existing constants file to extend`

## Expected Output

- ``prisma/schema.prisma` — CoderToken has expiresAt DateTime? field`
- ``prisma/migrations/*_add_coder_token_expires_at/migration.sql` — migration file`
- ``src/lib/constants.ts` — TOKEN_LIFETIME_SECONDS, TOKEN_ROTATION_THRESHOLD, TOKEN_EXPIRY_WARNING_HOURS, TOKEN_PREFLIGHT_MIN_HOURS, TOKEN_ROTATION_QUEUE constants`
- ``src/lib/auth/encryption.ts` — tryDecrypt function and DecryptResult type exported`
- ``src/lib/coder/types.ts` — ApiKeyInfo interface`
- ``src/lib/coder/client.ts` — listApiKeys and deleteApiKey static methods`
- ``src/lib/auth/login.ts` — performLogin passes lifetimeSeconds and stores expiresAt`
- ``src/__tests__/auth/token-lifecycle.test.ts` — tests for tryDecrypt and Coder API key methods`

## Verification

pnpm vitest run src/__tests__/auth/token-lifecycle.test.ts && pnpm prisma generate
