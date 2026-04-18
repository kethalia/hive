---
id: T04
parent: S02
milestone: M010
key_files:
  - src/lib/templates/staleness.ts
  - src/lib/templates/push-queue.ts
  - src/lib/actions/templates.ts
  - src/app/(dashboard)/templates/actions.ts
  - src/app/(dashboard)/templates/page.tsx
  - src/app/(dashboard)/templates/[name]/page.tsx
  - src/app/api/templates/status/route.ts
  - src/app/api/templates/[name]/push/route.ts
  - .env.example
  - src/__tests__/lib/templates/staleness.test.ts
  - src/__tests__/lib/templates/push-queue.test.ts
  - src/__tests__/app/api/templates/status.test.ts
  - src/__tests__/app/api/templates/push-routes.test.ts
key_decisions:
  - Switched listTemplateStatusesAction from actionClient to authActionClient — ensures userId is always available from authenticated session
  - Server component pages (templates/page.tsx, [name]/page.tsx) redirect to /login when unauthenticated rather than throwing — consistent with dashboard auth pattern
  - API routes return 401 JSON response when unauthenticated rather than redirecting — appropriate for API endpoints
duration: 
verification_result: passed
completed_at: 2026-04-18T20:35:40.024Z
blocker_discovered: false
---

# T04: Rewire template staleness checks and push worker to per-user credentials, remove CODER_URL/CODER_SESSION_TOKEN from .env.example, add ENCRYPTION_KEY

**Rewire template staleness checks and push worker to per-user credentials, remove CODER_URL/CODER_SESSION_TOKEN from .env.example, add ENCRYPTION_KEY**

## What Happened

Replaced all static env var usage (CODER_URL, CODER_SESSION_TOKEN) in template operations with per-user credential resolution via getCoderClientForUser.

**staleness.ts**: Changed `compareTemplates(names)` signature to `compareTemplates(names, userId)`. Removed env var reads and direct CoderClient construction; now calls `getCoderClientForUser(userId)` to get a client with the user's decrypted API key.

**push-queue.ts**: Added `userId: string` to `TemplatePushJobData` interface. Worker processor now calls `getCoderClientForUser(job.data.userId)` to resolve credentials per-job, then passes `client.getBaseUrl()` and `client.getSessionToken()` to the child process env for the coder CLI.

**Callers updated** (6 files):
- `src/lib/actions/templates.ts` — switched from `actionClient` to `authActionClient`, passes `ctx.user.id`
- `src/app/(dashboard)/templates/actions.ts` — added session auth via cookies, passes `session.user.id`
- `src/app/(dashboard)/templates/page.tsx` — added session auth, redirects to /login if unauthenticated
- `src/app/(dashboard)/templates/[name]/page.tsx` — same auth pattern
- `src/app/api/templates/status/route.ts` — added session auth, returns 401 if unauthenticated
- `src/app/api/templates/[name]/push/route.ts` — added session auth, includes `userId` in job data

**.env.example**: Removed `CODER_URL` and `CODER_SESSION_TOKEN` lines. Added `ENCRYPTION_KEY` with a comment explaining how to generate a 32-byte hex key.

**Tests updated**: Rewrote staleness and push-queue tests to mock `getCoderClientForUser` instead of env vars. Updated API route tests to mock auth session. Added negative tests for USER_NOT_FOUND and NO_TOKEN error paths.

## Verification

All 51 template-related tests pass (staleness, push-queue, status route, push route). Verified no CODER_URL/CODER_SESSION_TOKEN env var reads remain in src/ (only env var NAME usage in push-queue child process env, which is correct). 3 pre-existing test failures in session-actions, reviewer-processor, and workspace actions are from T02/T03 changes (missing authActionClient mock), not caused by T04.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/templates/ src/__tests__/app/api/templates/` | 0 | ✅ pass | 541ms |
| 2 | `rg 'CODER_SESSION_TOKEN|CODER_URL' --type ts src/ | grep -v __tests__ | grep -v test` | 0 | ✅ pass — only child process env name references remain (correct) | 50ms |

## Deviations

Task plan verification command used path src/__tests__/templates/ but actual test path is src/__tests__/lib/templates/ — adapted verification to correct path. Also updated API route tests (status.test.ts, push-routes.test.ts) which were not in the plan but needed auth mocks after route changes.

## Known Issues

Pre-existing test failures in session-actions.test.ts, reviewer-processor.test.ts, and workspaces/actions.test.ts from T02/T03 changes (mock missing authActionClient export). Not caused by T04.

## Files Created/Modified

- `src/lib/templates/staleness.ts`
- `src/lib/templates/push-queue.ts`
- `src/lib/actions/templates.ts`
- `src/app/(dashboard)/templates/actions.ts`
- `src/app/(dashboard)/templates/page.tsx`
- `src/app/(dashboard)/templates/[name]/page.tsx`
- `src/app/api/templates/status/route.ts`
- `src/app/api/templates/[name]/push/route.ts`
- `.env.example`
- `src/__tests__/lib/templates/staleness.test.ts`
- `src/__tests__/lib/templates/push-queue.test.ts`
- `src/__tests__/app/api/templates/status.test.ts`
- `src/__tests__/app/api/templates/push-routes.test.ts`
