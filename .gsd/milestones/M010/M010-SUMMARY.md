---
id: M010
title: "Multi-User Coder Authentication"
status: complete
completed_at: 2026-04-18T22:42:26.183Z
key_decisions:
  - D038 — Direct login API over OAuth2 PKCE (no experiment flag dependency)
  - D039 — Database-backed sessions with encrypted cookie (workers need persistent access)
  - D040 — Long-lived API keys (30-day) with 75% lifetime rotation via BullMQ
  - D041 — AES-256-GCM with single ENCRYPTION_KEY env var, per-user graceful degradation on key change
  - D042 — User uniqueness per (coderUrl, coderUserId), not per email
  - D043 — Logout deletes session only, API key persists for in-flight workers
key_files:
  - prisma/schema.prisma
  - src/lib/auth/encryption.ts
  - src/lib/auth/session.ts
  - src/lib/auth/login.ts
  - src/lib/auth/rate-limit.ts
  - src/lib/auth/actions.ts
  - src/lib/auth/token-status.ts
  - src/lib/coder/client.ts
  - src/lib/coder/user-client.ts
  - src/lib/safe-action.ts
  - src/lib/queue/task-queue.ts
  - src/lib/queue/token-rotation.ts
  - src/lib/queue/errors.ts
  - src/lib/push/vapid.ts
  - src/lib/push/send.ts
  - src/lib/push/subscribe.ts
  - src/components/token-expiry-banner.tsx
  - src/components/push-permission-prompt.tsx
  - src/components/service-worker-register.tsx
  - src/app/login/page.tsx
  - src/app/(dashboard)/layout.tsx
  - src/app/manifest.ts
  - public/sw.js
  - middleware.ts
lessons_learned:
  - Mock maintenance across slices: S03 added getTokenStatus pre-flight to task-queue but didn't update worker.test.ts and council-step.test.ts mocks. This caused 16 test failures discovered only at milestone completion. Each slice should grep for all test files that import from modified modules and verify mocks are complete.
  - importOriginal for class/enum exports: When mocking a module that exports both functions and classes/enums, use vi.mock with importOriginal to preserve class identity for instanceof checks (UserClientException in errors.ts). Pure function mocks lose class prototypes.
  - authActionClient migration pattern: Switching from actionClient to authActionClient changes error handling semantics — errors return result.serverError instead of throwing. All test assertions must update from rejects.toThrow() to result?.serverError checks.
  - Per-user cache key pattern: Any shared cache (metaCache, etc.) must include userId in the key to prevent cross-user data leakage. This is easy to miss when converting single-tenant code to multi-tenant.
---

# M010: Multi-User Coder Authentication

**Replaced static CODER_URL/CODER_SESSION_TOKEN env vars with per-user, per-deployment Coder authentication — login, encrypted token storage, auto-rotation, worker credential resolution, PWA installability, and push notifications for token expiry.**

## What Happened

M010 delivered multi-user Coder authentication across 4 slices (16 tasks), replacing the single-tenant env var approach with a full per-user credential lifecycle.

**S01 — Auth Foundation** built the core: Prisma models (User/CoderToken/Session), AES-256-GCM encryption, CoderClient auth methods (validateInstance/login/createApiKey), session CRUD with HttpOnly cookies, performLogin orchestration with API key fallback (3 retries), server actions via next-safe-action's authActionClient, edge-safe middleware, sliding-window rate limiter (5/min/IP), login page UI, and dashboard route group restructuring. 59 tests.

**S02 — Per-User Token Rewiring** eliminated all static Coder credential env vars. Created getCoderClientForUser(userId) factory as the single credential resolution path. Rewired all 7 workspace server actions, the workspace proxy route, BullMQ task and council workers, and template operations to use per-user credentials. Added userId FK to Task model. Fixed cache keys to ${userId}:${workspaceId} to prevent cross-user poisoning. Removed CODER_URL/CODER_SESSION_TOKEN from .env.example, added ENCRYPTION_KEY. 537 tests passing after rewire.

**S03 — Token Lifecycle & Resilience** added production-ready token management: expiresAt column on CoderToken, tryDecrypt with discriminated union error classification (key_mismatch vs other), getTokenStatus service, pre-flight expiry check in task queue (refuses jobs with expired/near-expiry tokens), isAuthError/isNetworkError classifiers (auth → UnrecoverableError, network → retry), BullMQ token rotation worker (hourly, rotates at 75% lifetime with optimistic locking), and TokenExpiryBanner in dashboard layout. 51 tests.

**S04 — PWA & Push Notifications** completed the user experience: web app manifest (display:standalone), service worker with push/notificationclick handlers, VAPID key management with DB-persisted auto-generation, push subscription server actions, PushPermissionPrompt component handling all permission states, sendPushToUser with per-subscription error handling and stale cleanup, and token rotation integration firing push at ≤24h threshold. 34 tests.

During milestone completion, 16 test failures were discovered in worker.test.ts and council-step.test.ts — stale mocks missing getTokenStatus and UserClientException exports added in S03. Fixed by adding token-status mock and using importOriginal for user-client mock. Full suite now passes: 618 tests across 78 files.

## Success Criteria Results

### S01 — "User provides Coder URL, logs in with email/password, lands on protected dashboard"
**MET.** Login page at src/app/login/page.tsx with URL/email/password fields. performLogin orchestrates validateInstance → login → createApiKey → upsert → session. Middleware redirects unauthenticated users. authActionClient validates sessions. 59 tests pass.

### S02 — "Submit a task — it runs end-to-end using submitting user's stored API key. No CODER_URL or CODER_SESSION_TOKEN in .env"
**MET.** getCoderClientForUser(userId) resolves credentials for all Coder API calls. rg confirms no process.env references to CODER_URL/CODER_SESSION_TOKEN in src/ (only child process env name setting in push-queue.ts). ENCRYPTION_KEY replaces old vars in .env.example. 537 tests pass.

### S03 — "Token nearing expiry auto-rotates. Worker refuses job with expired token. Encryption key change doesn't crash app. In-app expiry banner visible"
**MET.** Token rotation at 75% lifetime via hourly BullMQ job. Pre-flight check refuses expired/key_mismatch tokens with UnrecoverableError. tryDecrypt detects GCM auth tag mismatch gracefully. TokenExpiryBanner in dashboard layout. 51 tests pass.

### S04 — "App installs as PWA. Push notification fires when token is 24h from expiry. Notification opens login page. Login page has Coder-like styling"
**MET.** manifest.ts with display:standalone. sw.js with push/notificationclick (opens /login). sendPushToUser at ≤24h in rotation worker. Login page uses shadcn with zinc-950 dark theme. 34 tests pass.

## Definition of Done Results

- **All slices complete:** S01 ✅, S02 ✅, S03 ✅, S04 ✅
- **All slice summaries exist:** S01-SUMMARY.md ✅, S02-SUMMARY.md ✅, S03-SUMMARY.md ✅, S04-SUMMARY.md ✅
- **Code changes verified:** 101 non-.gsd files changed, 5527 insertions, 481 deletions across M010 commits
- **Full test suite passes:** 618/618 tests across 78 files (after fixing 16 stale mock failures)
- **Cross-slice integration verified:** S01 auth foundation → S02 per-user rewiring → S03 token lifecycle → S04 push notifications form a coherent dependency chain. getCoderClientForUser feeds all downstream consumers. Token rotation triggers push notifications.

## Requirement Outcomes

All 22 M010 requirements transitioned from active to **validated**:

| Requirement | Description | Evidence |
|---|---|---|
| R088 | Login via direct Coder API | 59 S01 tests, login page, performLogin orchestration |
| R089 | AES-256-GCM encrypted token storage | 14 encryption tests, CoderToken model with Bytes fields |
| R090 | @@unique([coderUrl, coderUserId]) | Prisma schema constraint, prisma generate succeeds |
| R091 | DB-backed sessions with HttpOnly cookie | 9 session + 8 action tests, hive-session cookie |
| R092 | Protected route redirects | Middleware + server component redirects + API 401s |
| R093 | Per-request CoderClient from stored token | authActionClient + getCoderClientForUser, 6 tests |
| R094 | Workers use submitting user's API key | getCoderClientForUser(job.data.userId), 26 queue tests |
| R095 | Task linked to user via userId FK | Migration + createTask accepts userId, 21 tests |
| R096 | CODER_URL/CODER_SESSION_TOKEN removed | rg confirms zero process.env references in src/ |
| R097 | Token rotation at 75% lifetime | Optimistic lock UPDATE, 11 rotation tests |
| R098 | Pre-flight expiry check (<2h refused) | UnrecoverableError in task-queue, 17 tests |
| R099 | /buildinfo validation before login | CoderClient.validateInstance, 14 auth tests |
| R100 | 5/min/IP rate limiting | Sliding window in rate-limit.ts, 7 tests |
| R101 | 3x retry + session token fallback | performLogin retry loop, 7 login tests |
| R102 | GCM key mismatch detection | tryDecrypt discriminated union, 12 lifecycle tests |
| R103 | PWA with manifest + service worker | display:standalone manifest, sw.js, 2 tests |
| R104 | Push at ≤24h expiry threshold | sendPushToUser in rotation, 11 tests |
| R105 | In-app expiry banner | TokenExpiryBanner component, 5 tests |
| R106 | Logout = session only, tokens persist | logoutAction behavior, 8 action tests |
| R107 | Multi-deployment isolation | Per-user cache keys, per-user CoderClient resolution |
| R108 | Auth vs network error classification | isAuthError/isNetworkError, UnrecoverableError routing |
| R109 | Coder-like login UI | shadcn + zinc-950 dark theme, notification → /login |

## Deviations

16 test failures in worker.test.ts (12) and council-step.test.ts (4) were discovered and fixed during milestone completion — stale mocks from S02/S03 transitions that weren't caught during individual slice verification. S04 summary noted these as "pre-existing" but they were actually fixable mock gaps. Fixed by adding getTokenStatus mock and using importOriginal for user-client mock to preserve UserClientException class identity.

## Follow-ups

Rate limiter is in-memory (resets on restart, no cross-instance sharing) — acceptable for single-instance per D041 but needs Redis backend if horizontally scaling. Push notification delivery depends on browser push service availability and user granting notification permission — no server-side fallback for denied permissions.
