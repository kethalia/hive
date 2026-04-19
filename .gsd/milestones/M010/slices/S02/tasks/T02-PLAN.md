---
estimated_steps: 29
estimated_files: 3
skills_used: []
---

# T02: Rewire workspace server actions and proxy route to per-user credentials

Switch all workspace server actions from unauthenticated actionClient to authActionClient with per-user CoderClient resolution (R093). Rewire workspace-proxy API route to resolve the user's session and use per-user credentials (R107).

Steps:
1. In `src/lib/actions/workspaces.ts`: replace `import { actionClient }` with `import { authActionClient }` from safe-action.ts. Replace `import { getCoderClient }` (or inline CoderClient construction from env) with `import { getCoderClientForUser }` from `src/lib/coder/user-client.ts`.
2. Rewrite each action (listWorkspacesAction, getWorkspaceAction, getWorkspaceAgentAction, getWorkspaceSessionsAction, createSessionAction, renameSessionAction, killSessionAction) to use `authActionClient` and call `const client = await getCoderClientForUser(ctx.user.id)` instead of `getCoderClient()`.
3. Delete the local `getCoderClient()` helper function that reads env vars.
4. In `src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts`: import `getSession` from auth/session.ts and `cookies` from next/headers. At the top of the handler, resolve the session: `const session = await getSession(await cookies()); if (!session) return new Response('Unauthorized', { status: 401 });`.
5. Replace env var reads for CODER_URL/CODER_SESSION_TOKEN with `const client = await getCoderClientForUser(session.user.id)`. Use `session.user.coderUrl` for host derivation in buildTargetUrl.
6. Fix metaCache key from `workspaceId` to `${session.user.id}:${workspaceId}` to prevent cross-user cache poisoning.
7. Update proxy request headers to use the user's decrypted token instead of env var.
8. Update/create tests in `src/__tests__/actions/workspaces.test.ts` — mock getCoderClientForUser, verify it's called with the correct userId from session context. Test that unauthenticated requests are rejected.
9. Update/create tests for workspace proxy if test file exists.

Must-haves:
- [ ] All workspace actions use authActionClient (not actionClient)
- [ ] All workspace actions call getCoderClientForUser(ctx.user.id)
- [ ] No env var reads for CODER_URL or CODER_SESSION_TOKEN in workspaces.ts
- [ ] Workspace proxy resolves session from cookie
- [ ] Workspace proxy returns 401 for unauthenticated requests
- [ ] metaCache keyed by userId:workspaceId
- [ ] Proxy uses per-user token in upstream request headers
- [ ] Tests pass

Failure Modes:
| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| getCoderClientForUser | Action returns server error (safe-action catches) | Prisma timeout propagates | N/A |
| getSession (proxy) | Return 401 Unauthorized | Cookie read is sync | N/A |

Negative Tests:
- Unauthenticated request to workspace action → rejected by authActionClient
- Unauthenticated request to workspace proxy → 401 response
- User with no CoderToken → action returns error message about re-authentication

## Inputs

- ``src/lib/coder/user-client.ts` — getCoderClientForUser factory from T01`
- ``src/lib/actions/workspaces.ts` — existing workspace actions to rewire`
- ``src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts` — existing proxy route`
- ``src/lib/safe-action.ts` — authActionClient with session context injection`
- ``src/lib/auth/session.ts` — getSession function and SessionData type`

## Expected Output

- ``src/lib/actions/workspaces.ts` — all actions using authActionClient + getCoderClientForUser`
- ``src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts` — session-aware proxy with per-user credentials`
- ``src/__tests__/actions/workspaces.test.ts` — updated tests for auth-aware actions`

## Verification

pnpm vitest run src/__tests__/actions/workspaces.test.ts && rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/actions/workspaces.ts | grep -v test; test $? -eq 1
