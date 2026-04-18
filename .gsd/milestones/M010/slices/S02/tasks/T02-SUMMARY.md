---
id: T02
parent: S02
milestone: M010
key_files:
  - src/lib/actions/workspaces.ts
  - src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts
  - src/lib/coder/client.ts
  - src/__tests__/actions/workspaces.test.ts
key_decisions:
  - Added getSessionToken() and getBaseUrl() public methods to CoderClient rather than making fields public — keeps encapsulation while allowing proxy to access the raw token for header forwarding
  - Used session.user.coderUrl for proxy host derivation instead of creating a second getCoderClientForUser call — avoids unnecessary decrypt+DB query since the URL is already in the session
duration: 
verification_result: passed
completed_at: 2026-04-18T20:18:40.521Z
blocker_discovered: false
---

# T02: Rewire workspace server actions and proxy route to per-user credentials via authActionClient and getCoderClientForUser

**Rewire workspace server actions and proxy route to per-user credentials via authActionClient and getCoderClientForUser**

## What Happened

Replaced all static CODER_URL/CODER_SESSION_TOKEN env var usage in workspace actions and the workspace proxy route with per-user credential resolution.

**workspaces.ts:** Switched all 7 actions (listWorkspaces, getWorkspace, getWorkspaceAgent, getWorkspaceSessions, createSession, renameSession, killSession) from `actionClient` to `authActionClient`, which injects the authenticated user's session as `ctx`. Each action that needs a Coder API client now calls `await getCoderClientForUser(ctx.user.id)` instead of the old `getCoderClient()` helper that read env vars. Deleted the local `getCoderClient()` helper entirely.

**workspace-proxy route:** Replaced env var credential reads with session-based auth. The proxy now calls `getSession(await cookies())` at the top of each request and returns 401 for unauthenticated requests. The `getWorkspaceMeta` function now takes `userId` and resolves the user's CoderClient via `getCoderClientForUser`. The `metaCache` key was changed from `workspaceId` to `${userId}:${workspaceId}` to prevent cross-user cache poisoning. The `coderHost` for URL construction now comes from `session.user.coderUrl` instead of `process.env.CODER_URL`. The upstream request token comes from `client.getSessionToken()`.

**CoderClient:** Added `getSessionToken()` and `getBaseUrl()` public methods since the proxy needs the raw token for forwarding headers and the fields were private.

**Tests:** Created `src/__tests__/actions/workspaces.test.ts` with 6 tests covering: authActionClient usage verification, env var absence verification, getCoderClientForUser usage, proxy 401 on unauthenticated requests, proxy env var absence, and metaCache userId keying.

## Verification

Ran `pnpm vitest run src/__tests__/actions/workspaces.test.ts` — all 6 tests passed. Ran `rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/actions/workspaces.ts` — no matches (exit 1, confirming no env var references). Ran `rg 'process.env.CODER_URL|process.env.CODER_SESSION_TOKEN' src/lib/actions/workspaces.ts src/app/api/workspace-proxy/` — no matches. Ran T01's user-client tests — all 7 still pass.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/actions/workspaces.test.ts` | 0 | ✅ pass | 212ms |
| 2 | `rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/actions/workspaces.ts | grep -v test; test $? -eq 1` | 0 | ✅ pass | 50ms |
| 3 | `rg 'process.env.CODER_URL|process.env.CODER_SESSION_TOKEN' src/lib/actions/workspaces.ts src/app/api/workspace-proxy/` | 1 | ✅ pass (no matches) | 30ms |
| 4 | `pnpm vitest run src/__tests__/lib/coder/user-client.test.ts` | 0 | ✅ pass | 175ms |

## Deviations

Added getSessionToken() and getBaseUrl() methods to CoderClient (not in the task plan) because the proxy route needs the raw session token for upstream request headers and sessionToken was a private field.

## Known Issues

None

## Files Created/Modified

- `src/lib/actions/workspaces.ts`
- `src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts`
- `src/lib/coder/client.ts`
- `src/__tests__/actions/workspaces.test.ts`
