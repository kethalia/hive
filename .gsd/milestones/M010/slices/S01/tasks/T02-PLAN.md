---
estimated_steps: 27
estimated_files: 4
skills_used: []
---

# T02: Implement session management and login flow orchestration

## Description

Session CRUD (create/read/delete with cookie management) and the login flow that orchestrates: validate Coder URL → authenticate → create API key (with fallback to session token) → upsert User + CoderToken → create Session → set cookie.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| Prisma DB (session lookup) | Throw — caller handles | Throw — caller handles | N/A (typed ORM) |
| CoderClient.createApiKey | Fallback to session token (R101) — retry 3x before fallback | Fallback to session token | Fallback to session token |
| cookies() API | Throw — login action catches and returns error | N/A | N/A |

## Negative Tests

- **Error paths**: getSession with expired session (should return null and delete row), getSession with non-existent sessionId, createSession with non-existent userId
- **Boundary conditions**: API key creation fails all 3 retries — falls back to session token storage

## Steps

1. Create `src/lib/auth/session.ts` with: `createSession(userId: string)` — generates UUID sessionId, inserts Session row with 30-day expiry, returns sessionId. `getSession(cookieStore)` — reads `hive-session` cookie, looks up Session + User join, returns `{user, session}` or null if expired/missing (deletes expired rows). `deleteSession(sessionId: string)` — deletes Session row. `setSessionCookie(cookieStore, sessionId)` — sets HttpOnly, Secure (prod only), SameSite=Lax, Path=/, 30-day maxAge cookie. `clearSessionCookie(cookieStore)` — deletes the cookie.
2. Create `src/lib/auth/login.ts` with `performLogin(coderUrl, email, password)` that: (a) calls `CoderClient.validateInstance(coderUrl)` — throws on invalid, (b) calls `CoderClient.login(coderUrl, email, password)` — gets session token + user info, (c) attempts `CoderClient.createApiKey(coderUrl, sessionToken, userId)` up to 3 times — on total failure, falls back to session token as credential (R101), (d) upserts User with `prisma.user.upsert()` on `(coderUrl, coderUserId)`, (e) upserts CoderToken — encrypts the API key (or session token fallback) using `encrypt()` with `process.env.TOKEN_ENCRYPTION_KEY`, (f) creates Session via `createSession()`, (g) returns `{sessionId, user}`. Export a `TOKEN_ENCRYPTION_KEY` getter that validates the key on first access.
3. Create test file `src/__tests__/auth/session.test.ts` — mock Prisma client, test createSession/getSession/deleteSession flows including expired session cleanup.
4. Create test file `src/__tests__/auth/login.test.ts` — mock CoderClient static methods and Prisma, test: successful login with API key, successful login with session token fallback (key creation fails), invalid Coder URL rejection, invalid credentials rejection.

## Must-Haves

- [ ] createSession generates UUID, inserts row with 30-day expiry
- [ ] getSession returns null for expired/missing sessions and cleans up expired rows
- [ ] Cookie settings: HttpOnly, Secure (prod), SameSite=Lax, 30-day maxAge
- [ ] performLogin orchestrates validate → login → createApiKey → upsert User → upsert CoderToken → createSession
- [ ] API key creation retries 3x before falling back to session token (R101)
- [ ] CoderToken stores encrypted credential via encrypt() from T01
- [ ] All tests pass

## Verification

- `pnpm vitest run src/__tests__/auth/session.test.ts` — all tests pass
- `pnpm vitest run src/__tests__/auth/login.test.ts` — all tests pass

## Inputs

- ``prisma/schema.prisma` — User, CoderToken, Session models from T01`
- ``src/lib/auth/encryption.ts` — encrypt/decrypt functions from T01`
- ``src/lib/coder/client.ts` — validateInstance, login, createApiKey static methods from T01`

## Expected Output

- ``src/lib/auth/session.ts` — session CRUD with cookie management`
- ``src/lib/auth/login.ts` — login flow orchestration with API key fallback`
- ``src/__tests__/auth/session.test.ts` — session management tests`
- ``src/__tests__/auth/login.test.ts` — login flow tests`

## Verification

pnpm vitest run src/__tests__/auth/session.test.ts src/__tests__/auth/login.test.ts
