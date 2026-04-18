---
id: S02
parent: M010
milestone: M010
provides:
  - ["getCoderClientForUser(userId) factory for per-user Coder credential resolution", "userId FK on Task model for task-to-user attribution", "authActionClient-based server actions with per-user CoderClient", "Per-user credential resolution in BullMQ workers via job data userId"]
requires:
  - slice: S01
    provides: User/CoderToken/Session Prisma models, AES-256-GCM encryption, authActionClient, session management
affects:
  []
key_files:
  - ["src/lib/coder/user-client.ts", "src/lib/actions/workspaces.ts", "src/lib/queue/task-queue.ts", "src/lib/queue/council-queues.ts", "src/lib/council/reviewer-processor.ts", "src/lib/templates/staleness.ts", "src/lib/templates/push-queue.ts", "src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts", "prisma/schema.prisma", ".env.example"]
key_decisions:
  - ["UserClientException with code enum (NO_TOKEN, DECRYPT_FAILED, USER_NOT_FOUND) for typed error handling at catch sites", "Added getSessionToken() and getBaseUrl() public methods to CoderClient for proxy header forwarding — keeps encapsulation while exposing needed values", "Server components redirect to /login when unauthenticated; API routes return 401 JSON"]
patterns_established:
  - ["getCoderClientForUser(userId) as the single credential resolution path — all Coder API calls go through this factory, never direct env var reads", "authActionClient for all protected server actions — injects authenticated session as ctx with ctx.user.id", "userId propagation through BullMQ job data — createTask stores userId on Task record and includes it in TaskJobData, which flows through dispatch chain to council workers", "Per-user cache keys (userId:workspaceId) to prevent cross-user cache poisoning in shared caches", "Server components redirect to /login when unauthenticated; API routes return 401 JSON — consistent auth boundary pattern"]
observability_surfaces:
  - ["[user-client] log prefix on token resolution errors — distinguishes NO_TOKEN vs DECRYPT_FAILED vs USER_NOT_FOUND", "Task table userId FK enables per-user task attribution and filtering", "Decrypted API keys never logged — only userId and error type appear in error messages"]
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-18T20:42:25.054Z
blocker_discovered: false
---

# S02: Per-User Token Rewiring

**Replaced all static CODER_URL/CODER_SESSION_TOKEN env var usage with per-user credential resolution via getCoderClientForUser factory — every Coder API call now uses the authenticated user's decrypted API key from the database.**

## What Happened

## What This Slice Delivered

This slice eliminated all static Coder credential env vars from the application, replacing them with per-user credential resolution at every call site. The central abstraction is `getCoderClientForUser(userId)` — a factory that queries the user's CoderToken from Postgres, decrypts it with AES-256-GCM, and returns a configured CoderClient.

### T01: Foundation — userId FK and Factory

Added a nullable `userId` FK to the Task Prisma model linking tasks to their submitting user. Created `src/lib/coder/user-client.ts` with `getCoderClientForUser(userId)` that queries CoderToken (most recent by createdAt), decrypts via ENCRYPTION_KEY, and returns a CoderClient. Exported `UserClientError` enum (NO_TOKEN, DECRYPT_FAILED, USER_NOT_FOUND) and `UserClientException` class for typed error handling. All error paths log with `[user-client]` prefix. 7 unit tests covering all paths.

### T02: Workspace Actions and Proxy

Switched all 7 workspace server actions from `actionClient` to `authActionClient`, each calling `getCoderClientForUser(ctx.user.id)`. Deleted the old `getCoderClient()` helper that read env vars. Rewired the workspace proxy route to resolve sessions from cookies, return 401 for unauthenticated requests, and use per-user credentials. Fixed metaCache key from `workspaceId` to `${userId}:${workspaceId}` to prevent cross-user cache poisoning. Added `getSessionToken()` and `getBaseUrl()` public methods to CoderClient for proxy header forwarding. 6 tests.

### T03: BullMQ Workers

Added `userId` to `createTask()`, `TaskJobData`, `CouncilDispatchParams`, and `CouncilReviewerJobData`. Changed `createTaskWorker(coderClient)` and `createCouncilReviewerWorker(coderClient)` to parameterless functions that resolve credentials per-job via `getCoderClientForUser(job.data.userId)`. Switched `createTaskAction` to `authActionClient`. Jobs with missing userId fail immediately with a clear error. 39 tests updated across 5 files.

### T04: Template Operations and Env Cleanup

Changed `compareTemplates(names)` to `compareTemplates(names, userId)`. Template push worker now resolves per-user credentials per-job. Updated 6 caller files (actions, server components, API routes) to pass userId from authenticated sessions. Server components redirect to /login when unauthenticated; API routes return 401 JSON. Removed CODER_URL and CODER_SESSION_TOKEN from .env.example, added ENCRYPTION_KEY. 51 template tests pass.

### Slice-Level Fix: Stale Test Mocks

Three test files (workspaces/actions.test.ts, session-actions.test.ts, reviewer-processor.test.ts) had stale mocks that only exported `actionClient` from the `@/lib/safe-action` mock, but the production code now imports `authActionClient`. Fixed all three by mocking upstream dependencies (user-client, next/headers, auth/session) instead, and updated error assertions from `rejects.toThrow()` to `result?.serverError` checks to match authActionClient's handleServerError behavior.

## Verification

## Verification Results

All slice-level verification checks pass:

| # | Command | Result |
|---|---------|--------|
| 1 | `pnpm vitest run src/__tests__/lib/coder/user-client.test.ts` | ✅ 7/7 tests pass |
| 2 | `pnpm vitest run src/__tests__/actions/workspaces.test.ts` | ✅ 6/6 tests pass |
| 3 | `pnpm vitest run src/__tests__/lib/queue/` | ✅ 26/26 tests pass |
| 4 | `pnpm vitest run src/__tests__/lib/templates/ src/__tests__/app/api/templates/` | ✅ 51/51 tests pass |
| 5 | `rg 'CODER_SESSION_TOKEN\|CODER_URL' --type ts src/ \| grep -v __tests__ \| grep -v test` | ✅ Only child process env name references in push-queue.ts (correct — sets env vars for coder CLI child process from per-user client values) |
| 6 | `pnpm vitest run` (full suite) | ✅ 537/537 tests pass across 67 files |

### Observability Verification

- `[user-client]` log prefix confirmed in user-client.ts error paths (NO_TOKEN, DECRYPT_FAILED, USER_NOT_FOUND)
- Task table has userId FK for attribution
- No secrets logged — only userId and error type appear in error messages

## Requirements Advanced

None.

## Requirements Validated

- R093 — All workspace actions use authActionClient with getCoderClientForUser(ctx.user.id). Source verified: no actionClient usage, no env var reads in workspaces.ts. 6 tests pass.
- R094 — Task worker and council reviewer worker resolve CoderClient per-job via getCoderClientForUser(job.data.userId). Worker signatures changed to parameterless. 26 queue tests pass.
- R095 — Task model has nullable userId FK (migration 20250418000000_add_task_user_id). createTask accepts userId and stores it on Task record. TaskJobData includes userId. 7 user-client tests + 14 worker tests pass.
- R096 — CODER_URL and CODER_SESSION_TOKEN removed from .env.example. ENCRYPTION_KEY added. rg confirms no process.env references to these vars in src/ (only child process env name setting in push-queue.ts, which is correct).
- R107 — Workspace proxy metaCache keyed by ${userId}:${workspaceId}. Each user's requests resolve their own CoderClient from their own CoderToken. Different Coder deployments are fully independent.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

Test files placed at src/__tests__/lib/ paths instead of src/__tests__/ top-level paths as the slice plan suggested — matches existing codebase convention. Three stale test files (workspaces/actions.test.ts, session-actions.test.ts, reviewer-processor.test.ts) required mock updates during slice completion to work with authActionClient — error assertions changed from rejects.toThrow() to result?.serverError checks.

## Known Limitations

push-queue.ts still references CODER_URL and CODER_SESSION_TOKEN as env var names passed to the coder CLI child process — this is correct behavior (the child process needs these env vars) but they come from per-user client methods, not process.env. The remote DATABASE_URL may be unreachable from the workspace — the Prisma migration was validated against a local PostgreSQL instance.

## Follow-ups

None.

## Files Created/Modified

None.
