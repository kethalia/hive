---
estimated_steps: 25
estimated_files: 3
skills_used: []
---

# T01: Add userId FK to Task model and create per-user CoderClient factory with tests

Foundation task: (1) Add nullable userId FK to the Task Prisma model linking tasks to their submitting user (R095). Run prisma migrate. (2) Create `src/lib/coder/user-client.ts` with `getCoderClientForUser(userId: string): Promise<CoderClient>` that queries CoderToken for the user's latest token, decrypts via decrypt() from encryption.ts using ENCRYPTION_KEY env var, queries User for coderUrl, and returns a new CoderClient. Throws typed errors: 'NO_TOKEN' if no CoderToken exists, 'DECRYPT_FAILED' if decryption fails, 'USER_NOT_FOUND' if user doesn't exist. (3) Write comprehensive unit tests in `src/__tests__/coder/user-client.test.ts` mocking Prisma queries and decrypt function.

Steps:
1. Add to prisma/schema.prisma: `userId String? @map("user_id") @db.Uuid` and `user User? @relation(fields: [userId], references: [id])` on Task model. Add `tasks Task[]` to User model.
2. Run `pnpm prisma migrate dev --name add-task-user-id` to create migration.
3. Run `pnpm prisma generate` to update Prisma client types.
4. Create `src/lib/coder/user-client.ts` exporting `getCoderClientForUser(userId)`. Implementation: query prisma.coderToken.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }), query prisma.user.findUnique({ where: { id: userId } }), decrypt token, return new CoderClient({ baseUrl: user.coderUrl, sessionToken: decryptedKey }).
5. Export error type enum: `UserClientError` with values NO_TOKEN, DECRYPT_FAILED, USER_NOT_FOUND.
6. Write tests: happy path (token found, decrypted, client returned), no token (throws NO_TOKEN), user not found (throws USER_NOT_FOUND), decrypt failure (throws DECRYPT_FAILED), uses most recent token when multiple exist.

Must-haves:
- [ ] Task model has nullable userId FK with User relation
- [ ] Prisma migration runs cleanly
- [ ] getCoderClientForUser returns working CoderClient from DB credentials
- [ ] Typed error cases for no-token, decrypt-failure, user-not-found
- [ ] Unit tests cover all paths

Failure Modes:
| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Prisma (CoderToken query) | Throw USER_NOT_FOUND or NO_TOKEN | Prisma default timeout propagates | N/A (typed ORM) |
| decrypt() | Throw DECRYPT_FAILED with original error | N/A (sync crypto) | N/A |
| ENCRYPTION_KEY env var | Throw at decrypt time (invalid key) | N/A | N/A |

Negative Tests:
- No CoderToken for userId → throws with NO_TOKEN code
- User doesn't exist → throws with USER_NOT_FOUND code
- Corrupted ciphertext in DB → throws with DECRYPT_FAILED code
- Missing ENCRYPTION_KEY → decrypt throws (propagated as DECRYPT_FAILED)

## Inputs

- ``prisma/schema.prisma` — existing Task and User models to extend`
- ``src/lib/auth/encryption.ts` — decrypt function signature and EncryptedData interface`
- ``src/lib/coder/client.ts` — CoderClient constructor and CoderClientConfig interface`

## Expected Output

- ``prisma/schema.prisma` — Task model with userId FK, User model with tasks relation`
- ``prisma/migrations/*_add_task_user_id/migration.sql` — migration adding user_id column`
- ``src/lib/coder/user-client.ts` — getCoderClientForUser factory function`
- ``src/__tests__/coder/user-client.test.ts` — unit tests for factory`

## Verification

pnpm prisma generate && pnpm vitest run src/__tests__/coder/user-client.test.ts
