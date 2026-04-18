# S01: Auth Foundation — Login, Schema, Sessions

**Goal:** User authenticates with Coder via direct login API, receives a database-backed session with encrypted cookie, and is redirected to the dashboard. Unauthenticated users are redirected to /login. Logout deletes the browser session only. Login is rate-limited to 5 attempts/min per IP.
**Demo:** User provides Coder URL, logs in with email/password, lands on protected dashboard. Second user on different deployment logs in simultaneously. Invalid URLs and bad credentials show distinct errors.

## Must-Haves

- `pnpm vitest run` passes all auth tests (encryption round-trip, session CRUD, login flow, rate limiting)
- `prisma db push` applies schema with User, CoderToken, Session tables without errors
- Dev server starts, unauthenticated visit to `/` redirects to `/login`
- Login with valid Coder credentials creates session, sets cookie, redirects to dashboard
- Login with invalid URL shows "not a Coder instance" error
- Login with bad credentials shows authentication error
- Logout clears session cookie and redirects to `/login` — User and CoderToken persist in DB
- 6th login attempt within 1 minute returns rate limit error
- Two users on different Coder deployments can have independent sessions

## Proof Level

- This slice proves: - This slice proves: integration
- Real runtime required: yes (Prisma + PostgreSQL for schema, dev server for middleware/UI)
- Human/UAT required: yes (login flow, redirect behavior, session persistence)

## Integration Closure

- Upstream surfaces consumed: `src/lib/coder/client.ts` (existing CoderClient), `src/lib/safe-action.ts` (existing action client), `prisma/schema.prisma` (existing schema), `src/app/layout.tsx` (existing layout)
- New wiring introduced in this slice: middleware.ts (route protection), authenticated safe-action client, login/logout server actions, session cookie management
- What remains before the milestone is truly usable end-to-end: S02+ worker credential injection (using stored CoderToken for background jobs), API key rotation job

## Verification

- Runtime signals: console.log for login attempts (success/failure), session creation/deletion, rate limit hits
- Inspection surfaces: `sessions` and `users` DB tables, `coder_tokens` table (encrypted values), browser cookies (hive-session)
- Failure visibility: login error messages distinguish DNS failure, timeout, not-Coder, bad credentials, rate limited, API key creation failure with fallback
- Redaction constraints: passwords never logged, API keys stored encrypted, session tokens not exposed in client responses

## Tasks

- [x] **T01: Add auth schema, encryption utilities, and CoderClient auth methods** `est:1h`
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
  - Files: `prisma/schema.prisma`, `src/lib/auth/encryption.ts`, `src/lib/coder/client.ts`, `src/lib/coder/types.ts`, `src/__tests__/auth/encryption.test.ts`, `src/__tests__/auth/coder-auth.test.ts`
  - Verify: pnpm prisma generate && pnpm vitest run src/__tests__/auth/encryption.test.ts src/__tests__/auth/coder-auth.test.ts

- [ ] **T02: Implement session management and login flow orchestration** `est:1h`
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
  - Files: `src/lib/auth/session.ts`, `src/lib/auth/login.ts`, `src/__tests__/auth/session.test.ts`, `src/__tests__/auth/login.test.ts`
  - Verify: pnpm vitest run src/__tests__/auth/session.test.ts src/__tests__/auth/login.test.ts

- [ ] **T03: Wire auth server actions, middleware route protection, and rate limiting** `est:1h`
  ## Description

Integration layer: login/logout/getSession server actions via next-safe-action, Next.js middleware for route protection (cookie-only check, no Prisma in edge runtime), in-memory rate limiter for login attempts (5/min per IP), and an authenticated safe-action client that injects user context.

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| performLogin (from T02) | Return structured error to client via safe-action | N/A (server-side) | N/A |
| getSession (from T02) | Redirect to /login (middleware) or return null (action) | N/A | N/A |

## Load Profile

- **Shared resources**: in-memory Map for rate limiting (keyed by IP)
- **Per-operation cost**: 1 DB read (session lookup) per authenticated request via authActionClient
- **10x breakpoint**: in-memory rate limiter resets on cold start — acceptable for single-instance (D041 notes Redis upgrade path)

## Negative Tests

- **Rate limiting**: 5 requests pass, 6th is rejected, window slides after 60s
- **Middleware**: requests to /login pass through, requests to /_next pass through, requests to / without cookie redirect to /login
- **Auth action client**: action with expired session returns error, action with valid session injects user context

## Steps

1. Create `src/lib/auth/rate-limit.ts` — sliding window rate limiter. `checkRateLimit(key: string, limit: number, windowMs: number): {allowed: boolean, remaining: number, resetMs: number}`. Uses a Map<string, number[]> storing timestamps. Prunes expired entries on each check. Export a `loginRateLimiter` instance configured for 5/min.
2. Create `src/lib/auth/actions.ts` with three server actions using `actionClient` (public, for login) and a new `authActionClient` (authenticated):
   - `loginAction` — Zod schema validates coderUrl (URL), email (email), password (min 1 char). Reads IP from headers (x-forwarded-for or x-real-ip). Checks rate limit. Calls `performLogin()`. On success, sets session cookie via `setSessionCookie()` and returns `{success: true}`. On failure, returns structured error.
   - `logoutAction` — uses `authActionClient`. Reads session cookie, calls `deleteSession()`, calls `clearSessionCookie()`, returns `{success: true}`.
   - `getSessionAction` — uses `authActionClient`. Returns `{user: {id, email, coderUrl}}` from context.
3. Extend `src/lib/safe-action.ts` — add `authActionClient` that chains a middleware: reads session cookie via `cookies()`, calls `getSession()`, if null throws (safe-action catches and returns error), if valid injects `ctx.user` and `ctx.session`. Keep existing `actionClient` unchanged.
4. Create `middleware.ts` at project root. Protect all routes except: `/login`, `/api/auth/*`, `/_next/*`, `/favicon.ico`, and static assets. Check for `hive-session` cookie existence only (no Prisma, no crypto — edge runtime constraint). If cookie missing, redirect to `/login`. If cookie present, allow through (full validation happens in server actions via authActionClient).
5. Create test file `src/__tests__/auth/rate-limit.test.ts` — test sliding window: 5 allowed, 6th rejected, window expiry resets count.
6. Create test file `src/__tests__/auth/actions.test.ts` — test loginAction with mocked performLogin (success, failure, rate limited), test that authActionClient rejects when no session.

## Must-Haves

- [ ] loginAction validates input with Zod, checks rate limit, calls performLogin, sets cookie
- [ ] logoutAction deletes session and clears cookie (R106)
- [ ] getSessionAction returns current user info
- [ ] authActionClient reads session cookie and injects user context, rejects if no valid session
- [ ] Rate limiter enforces 5 attempts/min per IP with sliding window (R100)
- [ ] Middleware redirects unauthenticated requests to /login, passes through public routes
- [ ] Middleware does NOT use Prisma or Node.js crypto (edge runtime safe)
- [ ] All tests pass

## Verification

- `pnpm vitest run src/__tests__/auth/rate-limit.test.ts` — all tests pass
- `pnpm vitest run src/__tests__/auth/actions.test.ts` — all tests pass
- `grep -q 'hive-session' middleware.ts` — middleware checks correct cookie name
  - Files: `src/lib/auth/rate-limit.ts`, `src/lib/auth/actions.ts`, `src/lib/safe-action.ts`, `middleware.ts`, `src/__tests__/auth/rate-limit.test.ts`, `src/__tests__/auth/actions.test.ts`
  - Verify: pnpm vitest run src/__tests__/auth/rate-limit.test.ts src/__tests__/auth/actions.test.ts && grep -q 'hive-session' middleware.ts

- [ ] **T04: Build login page UI, restructure layout for auth, and add sidebar session indicator** `est:1h`
  ## Description

Presentation layer: login page with Coder URL, email, password fields and error display; layout restructuring so the sidebar only renders for authenticated routes; sidebar session indicator showing user email and Coder URL with logout button.

## Steps

1. Create `src/app/login/page.tsx` — client component with form state. Three inputs: Coder URL (type=url, placeholder 'https://coder.example.com'), Email (type=email), Password (type=password). Submit button with loading state. Error display area using shadcn Alert component. Calls `loginAction` via `useAction` hook from next-safe-action. On success, calls `router.push('/')` to navigate to dashboard. On rate limit error, shows 'Too many login attempts' message.
2. Create `src/app/login/layout.tsx` — minimal layout without sidebar. Just centers the login form vertically and horizontally with a max-width container. Include the Hive logo/title above the form.
3. Create `src/app/(dashboard)/layout.tsx` — move the sidebar rendering from root layout into this dashboard layout. Import SidebarProvider, AppSidebar, SidebarInset, SidebarTrigger. This layout wraps all authenticated routes.
4. Move existing route directories into the dashboard group: `src/app/tasks/` → `src/app/(dashboard)/tasks/`, `src/app/templates/` → `src/app/(dashboard)/templates/`, `src/app/workspaces/` → `src/app/(dashboard)/workspaces/`. Move `src/app/page.tsx` → `src/app/(dashboard)/page.tsx`.
5. Update `src/app/layout.tsx` — remove SidebarProvider, AppSidebar, SidebarInset, SidebarTrigger imports and rendering. Keep only html, body, fonts, TooltipProvider, and `{children}`.
6. Update `src/components/app-sidebar.tsx` — remove the `coderUrl` prop (no longer from env var). Instead, fetch session info via `getSessionAction` on mount. Display user email and connected Coder URL in the sidebar footer. Add a logout button that calls `logoutAction` and redirects to `/login` via `router.push('/login')`. Replace `process.env.CODER_URL` usage with session-derived Coder URL.
7. Verify: start dev server, confirm unauthenticated visit redirects to `/login`, confirm login page renders with three fields, confirm after mock login the sidebar shows user info and logout button works.

## Must-Haves

- [ ] Login page with Coder URL, email, password inputs using shadcn Input component
- [ ] Login form shows loading state during submission
- [ ] Login errors displayed via shadcn Alert component (distinct messages for invalid URL, bad creds, rate limit)
- [ ] Dashboard routes wrapped in (dashboard) route group with sidebar
- [ ] Root layout no longer renders sidebar directly
- [ ] Sidebar footer shows connected user email and Coder URL from session
- [ ] Sidebar logout button calls logoutAction and redirects to /login
- [ ] Login page layout centers form without sidebar

## Verification

- `test -f src/app/login/page.tsx && test -f src/app/(dashboard)/layout.tsx` — key files exist
- `! grep -q 'AppSidebar' src/app/layout.tsx` — sidebar removed from root layout
- `grep -q 'AppSidebar' 'src/app/(dashboard)/layout.tsx'` — sidebar in dashboard layout
- `grep -q 'logoutAction' src/components/app-sidebar.tsx` — logout wired in sidebar
  - Files: `src/app/login/page.tsx`, `src/app/login/layout.tsx`, `src/app/(dashboard)/layout.tsx`, `src/app/(dashboard)/page.tsx`, `src/app/layout.tsx`, `src/components/app-sidebar.tsx`
  - Verify: test -f src/app/login/page.tsx && test -f 'src/app/(dashboard)/layout.tsx' && ! grep -q 'AppSidebar' src/app/layout.tsx && grep -q 'logoutAction' src/components/app-sidebar.tsx

## Files Likely Touched

- prisma/schema.prisma
- src/lib/auth/encryption.ts
- src/lib/coder/client.ts
- src/lib/coder/types.ts
- src/__tests__/auth/encryption.test.ts
- src/__tests__/auth/coder-auth.test.ts
- src/lib/auth/session.ts
- src/lib/auth/login.ts
- src/__tests__/auth/session.test.ts
- src/__tests__/auth/login.test.ts
- src/lib/auth/rate-limit.ts
- src/lib/auth/actions.ts
- src/lib/safe-action.ts
- middleware.ts
- src/__tests__/auth/rate-limit.test.ts
- src/__tests__/auth/actions.test.ts
- src/app/login/page.tsx
- src/app/login/layout.tsx
- src/app/(dashboard)/layout.tsx
- src/app/(dashboard)/page.tsx
- src/app/layout.tsx
- src/components/app-sidebar.tsx
