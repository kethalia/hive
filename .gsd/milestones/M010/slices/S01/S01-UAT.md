# S01: Auth Foundation — Login, Schema, Sessions — UAT

**Milestone:** M010
**Written:** 2026-04-18T20:01:38.592Z

# S01 UAT — Auth Foundation

## Preconditions

- PostgreSQL running and accessible
- `TOKEN_ENCRYPTION_KEY` set in environment (64-char hex string = 32 bytes)
- `pnpm prisma db push` applied successfully (User, CoderToken, Session tables exist)
- Dev server running (`pnpm dev` or `tsx watch server.ts`)
- Access to at least one Coder deployment with valid email/password credentials
- (Optional) Access to a second Coder deployment for multi-user test

---

## Test Cases

### TC01: Unauthenticated Redirect
1. Open browser, clear all cookies for the app domain
2. Navigate to `http://localhost:3000/`
3. **Expected:** Redirected to `/login`
4. Navigate to `http://localhost:3000/tasks`
5. **Expected:** Redirected to `/login`
6. Navigate to `http://localhost:3000/templates`
7. **Expected:** Redirected to `/login`

### TC02: Login Page Renders Correctly
1. Navigate to `/login`
2. **Expected:** Page shows centered form with Hive branding (Hexagon icon + title)
3. **Expected:** Three input fields: Coder URL (type=url), Email (type=email), Password (type=password)
4. **Expected:** Submit button labeled "Sign In" or similar
5. **Expected:** No sidebar visible on login page

### TC03: Invalid Coder URL
1. On `/login`, enter `https://not-a-real-coder-instance.example.com` as Coder URL
2. Enter any email and password
3. Click submit
4. **Expected:** Error message indicating the URL is not a valid Coder instance (e.g., "not a Coder instance" or DNS/connection error)
5. **Expected:** Form remains on `/login`, no redirect

### TC04: Valid Coder URL, Bad Credentials
1. On `/login`, enter a valid Coder deployment URL
2. Enter an invalid email/password combination
3. Click submit
4. **Expected:** Error message indicating authentication failure (distinct from TC03 error)
5. **Expected:** Form remains on `/login`

### TC05: Successful Login
1. On `/login`, enter valid Coder URL, email, and password
2. Click submit
3. **Expected:** Loading state shown on submit button during request
4. **Expected:** Redirected to `/` (dashboard)
5. **Expected:** Sidebar visible with workspace/template navigation
6. **Expected:** Sidebar footer shows logged-in user's email and connected Coder URL
7. Inspect cookies: `hive-session` cookie present, HttpOnly, SameSite=Lax, Path=/
8. Query database: `SELECT * FROM sessions` — row exists with valid expiresAt (30 days from now)
9. Query database: `SELECT * FROM users` — row exists with correct coderUrl and coderUserId
10. Query database: `SELECT * FROM coder_tokens` — row exists with non-null ciphertext, iv, authTag (encrypted)

### TC06: Session Persistence Across Page Loads
1. After successful login (TC05), refresh the page
2. **Expected:** Still on dashboard, not redirected to `/login`
3. Navigate to `/tasks`, `/templates`, `/workspaces`
4. **Expected:** All pages accessible, sidebar visible on all

### TC07: Logout
1. After successful login, click the logout button in sidebar footer
2. **Expected:** Redirected to `/login`
3. **Expected:** `hive-session` cookie cleared
4. Navigate to `/`
5. **Expected:** Redirected to `/login` (session invalidated)
6. Query database: `SELECT * FROM sessions WHERE user_id = '<user_id>'` — session row deleted
7. Query database: `SELECT * FROM users WHERE id = '<user_id>'` — user row still exists (R106)
8. Query database: `SELECT * FROM coder_tokens WHERE user_id = '<user_id>'` — token row still exists (R106)

### TC08: Rate Limiting
1. On `/login`, enter valid Coder URL but intentionally wrong password
2. Submit the form 5 times rapidly
3. **Expected:** First 5 attempts show "invalid credentials" error
4. Submit a 6th time
5. **Expected:** Error message changes to "Too many login attempts" or similar rate limit message
6. Wait 60 seconds, try again
7. **Expected:** Rate limit resets, attempt goes through (shows credential error again if password still wrong)

### TC09: Two Users on Different Coder Deployments (if second deployment available)
1. In Browser A: Log in with User A on Coder Deployment A
2. **Expected:** Dashboard shows, sidebar footer shows User A email and Deployment A URL
3. In Browser B (different browser or incognito): Log in with User B on Coder Deployment B
4. **Expected:** Dashboard shows, sidebar footer shows User B email and Deployment B URL
5. Refresh Browser A
6. **Expected:** User A still logged in, showing their own session data
7. Query database: `SELECT * FROM users` — two distinct rows with different coderUrl values
8. Query database: `SELECT * FROM sessions` — two distinct active sessions

### TC10: Login Page Not Accessible When Authenticated
1. After successful login, manually navigate to `/login`
2. **Expected:** Either redirected to dashboard or login page shown (middleware passes through /login regardless of auth state — this is by design so users can switch accounts)

---

## Edge Cases

### EC01: Coder URL With Trailing Slash
1. Enter Coder URL with trailing slash (e.g., `https://coder.example.com/`)
2. **Expected:** Login succeeds — trailing slash normalized internally

### EC02: Browser Cookie Deleted Manually
1. Log in successfully
2. Manually delete `hive-session` cookie from browser dev tools
3. Refresh the page
4. **Expected:** Redirected to `/login`

### EC03: API Key Creation Failure Fallback
1. If testable: simulate API key creation failure (e.g., user lacks permission to create API keys)
2. **Expected:** Login still succeeds — falls back to session token storage (R101)
3. Query database: `SELECT * FROM coder_tokens` — token stored with encrypted session token as fallback
