# S02 Research: Per-User Token Rewiring

## Summary of What Needs to Change

Every Coder API call currently uses `process.env.CODER_URL` and `process.env.CODER_SESSION_TOKEN` — a single static credential shared across all users. S02 replaces this with per-user credentials: each authenticated user's `coderUrl` (from User model) and decrypted API key (from CoderToken model) must be resolved at call time.

The key insight: **S01 already delivered the infrastructure**. The `SessionData` type (from `src/lib/auth/session.ts`) already includes `user.id` and `user.coderUrl`. The `CoderToken` table stores AES-256-GCM encrypted API keys. The `authActionClient` middleware already injects `ctx.user` into every authenticated action. What's missing is the "last mile" — a helper that takes a userId, decrypts their token, and returns a ready-to-use `CoderClient`.

## Key Files and What Each Needs

### 1. NEW: `src/lib/coder/user-client.ts` — Per-user CoderClient factory
Create a helper function (e.g., `getCoderClientForUser(userId: string): Promise<CoderClient>`) that:
- Queries `CoderToken` for the user's latest token
- Decrypts it via `decrypt()` from `src/lib/auth/encryption.ts` using `process.env.ENCRYPTION_KEY`
- Queries `User` for `coderUrl`
- Returns `new CoderClient({ baseUrl: coderUrl, sessionToken: decryptedKey })`
- Throws a clear error if no token exists (user needs to re-login)

### 2. `src/lib/actions/workspaces.ts` — Server actions (6 actions using `actionClient`)
- **Current**: Uses `actionClient` + `getCoderClient()` reading env vars
- **Change**: Switch all 6 actions to `authActionClient`, use `ctx.user.id` to call `getCoderClientForUser(ctx.user.id)`. Remove `getCoderClient()` helper entirely.
- Actions affected: `listWorkspacesAction`, `getWorkspaceAction`, `getWorkspaceAgentAction`, `getWorkspaceSessionsAction`, `renameSessionAction`, `killSessionAction`

### 3. `src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts` — Workspace proxy API route
- **Current**: Reads `CODER_URL`/`CODER_SESSION_TOKEN` from env in `getWorkspaceMeta()` and `proxyRequest()`
- **Change**: This is a Next.js route handler (not a safe-action), so it needs to read the session cookie directly via `cookies()` + `getSession()`, then use `getCoderClientForUser()`. The `getCoderHost()` helper must use the user's `coderUrl` instead of env var. The `metaCache` needs to be keyed by `userId+workspaceId` or scoped per-user to avoid cross-user cache poisoning.
- **Pitfall**: The proxy also uses `sessionToken` for upstream fetch headers — this must come from the user's decrypted token.

### 4. `src/lib/queue/task-queue.ts` — BullMQ task worker (R094)
- **Current**: `createTaskWorker(coderClient: CoderClient)` receives a single shared client
- **Change**: The `TaskJobData` interface must include `userId: string`. The worker processor must call `getCoderClientForUser(job.data.userId)` per-job instead of using the injected shared client. The function signature changes to `createTaskWorker()` (no parameter).
- **Impact**: This is the biggest behavioral change — each job now resolves its own credentials.

### 5. `src/lib/api/tasks.ts` — Task creation (R095)
- **Current**: `createTask()` takes `{ prompt, repoUrl, ... }` with no user context
- **Change**: Add `userId` parameter. Store `userId` on the Task record (requires schema migration). Include `userId` in `TaskJobData` so the worker can resolve the user's token.

### 6. `prisma/schema.prisma` — Task model (R095)
- **Current**: Task model has no `userId` field
- **Change**: Add `userId String? @map("user_id") @db.Uuid` and `user User? @relation(fields: [userId], references: [id])`. Make it optional initially (nullable) so existing tasks don't break. Add `tasks Task[]` to User model.

### 7. `src/lib/queue/council-queues.ts` — Council reviewer worker (R094)
- **Current**: `createCouncilReviewerWorker(coderClient: CoderClient)` — shared client
- **Change**: Same pattern as task worker. `CouncilReviewerJobData` needs `userId`. Worker resolves per-job credentials.

### 8. `src/lib/council/dispatch.ts` — Council dispatch
- **Current**: Dispatches council jobs (needs to check if userId is passed through)
- **Change**: Must propagate `userId` into council job data

### 9. `src/lib/templates/staleness.ts` — Template staleness checker
- **Current**: `compareTemplates()` reads `CODER_URL`/`CODER_SESSION_TOKEN` from env
- **Change**: Accept `coderUrl` and `apiKey` as parameters instead of reading env. Callers pass user credentials.

### 10. `src/lib/templates/push-queue.ts` — Template push worker
- **Current**: Reads `CODER_URL`/`CODER_SESSION_TOKEN` from env, passes to child process env
- **Change**: `TemplatePushJobData` needs `userId`. Worker decrypts user's token and passes to child env.

### 11. `services/terminal-proxy/src/proxy.ts` + `index.ts` — Terminal proxy
- **Current**: Reads `CODER_SESSION_TOKEN` and `CODER_URL` from env for WebSocket upstream
- **Change**: The terminal proxy is a separate Node.js service. It needs the user's token per-connection. Options: (a) pass token via a secure query param from the Next.js app, (b) have the proxy call the Hive API to resolve credentials, or (c) pass a short-lived signed JWT that the proxy validates. Option (a) is simplest — the Next.js frontend already knows the user's session; it can request a short-lived proxy ticket.
- **Pitfall**: This is the most architecturally complex change. The proxy currently has no concept of users.

### 12. `src/instrumentation.ts` — Worker bootstrap
- **Current**: Only starts `createTemplatePushWorker()`. Task/council workers are not started here (they may be started elsewhere or not yet wired).
- **Change**: If task/council workers are started here in the future, they no longer need a shared CoderClient parameter.

### 13. `.env.example` — Remove static credentials (R096)
- **Current**: Lists `CODER_URL=` and `CODER_SESSION_TOKEN=`
- **Change**: Remove both. Keep `CODER_AGENT_URL=` if terminal proxy still needs a fallback. Add `ENCRYPTION_KEY=` if not already present.

### 14. Test files (many)
- Tests that stub `CODER_URL`/`CODER_SESSION_TOKEN` env vars or mock `CoderClient` constructor calls need updating to mock `getCoderClientForUser()` instead.

## Build Order

### Phase 1: Foundation
1. **Prisma migration**: Add `userId` FK to Task model (nullable). Run `prisma migrate`.
2. **`getCoderClientForUser()` factory**: New file `src/lib/coder/user-client.ts`. Unit test it with mocked Prisma + decrypt.

### Phase 2: Server Actions (lowest risk, highest coverage)
3. **Rewire `src/lib/actions/workspaces.ts`**: Switch from `actionClient` to `authActionClient`, use `getCoderClientForUser(ctx.user.id)`. Update tests.
4. **Rewire workspace-proxy route**: Add session resolution, per-user client. Update meta cache keying. Update tests.

### Phase 3: Workers (R094)
5. **Add `userId` to `TaskJobData`**: Update interface and `createTask()` to accept and propagate userId.
6. **Rewire task worker**: Remove `coderClient` param, resolve per-job. Update tests.
7. **Rewire council worker**: Same pattern. Update tests.

### Phase 4: Template Operations
8. **Rewire `staleness.ts`**: Parameterize credentials. Update tests.
9. **Rewire `push-queue.ts`**: Add userId to job data, resolve per-job. Update tests.

### Phase 5: Terminal Proxy
10. **Design proxy auth flow**: Implement proxy ticket or token-forwarding mechanism. This may need a new API endpoint (e.g., `/api/proxy-ticket`) that returns a short-lived token the frontend passes to the WebSocket URL.
11. **Update terminal proxy**: Accept per-connection credentials. Update tests.

### Phase 6: Cleanup
12. **Remove env vars**: Strip `CODER_URL` and `CODER_SESSION_TOKEN` from `.env.example`. Update any remaining references.

## Verification Approach

1. **Unit tests**: Each rewired module gets tests verifying it calls `getCoderClientForUser()` with the correct userId and that credentials come from the DB, not env.
2. **Integration test**: Create a task as user A, verify the worker resolves user A's token (not env var). Mock at the Prisma/decrypt layer.
3. **Negative tests**: Verify that if a user has no CoderToken, actions throw a clear "re-authenticate" error.
4. **Multi-user isolation (R107)**: Test that two users with different `coderUrl` values get separate CoderClient instances pointing to different deployments.
5. **Env var removal check**: `rg "CODER_SESSION_TOKEN|CODER_URL" --type ts` in src/ should return zero hits (excluding test mocks and terminal-proxy if deferred).

## Constraints and Pitfalls

1. **Nullable userId on Task**: Existing tasks have no userId. The migration must make it nullable. New tasks should always have userId set. Queries/UI should handle null gracefully.

2. **Token expiry**: If a user's CoderToken expires or is revoked by Coder, the worker will fail mid-job. The `getCoderClientForUser()` factory should produce a clear error message that distinguishes "no token stored" from "token rejected by Coder" so the user knows to re-login.

3. **Worker credential lifetime**: BullMQ jobs can sit in the queue for minutes/hours. The token is resolved at processing time (not enqueue time), which is correct — but the token could expire during a long-running job. For now this is acceptable since API keys created by `createApiKey()` default to long-lived.

4. **Terminal proxy architecture**: The proxy is a standalone service with no access to Prisma or the Hive DB. Three options exist (proxy ticket, signed JWT, or direct DB access). A proxy ticket endpoint is recommended as the simplest approach that doesn't couple the proxy to the DB.

5. **Cache poisoning in workspace-proxy**: The current `metaCache` is keyed by workspaceId alone. With multi-user support, user A could cache workspace metadata that user B then reads (getting user A's owner/agent info). Key the cache by `${userId}:${workspaceId}` or clear it.

6. **Council job chain**: Council jobs are dispatched from within the task worker. The userId must flow through: `createTask(userId)` → `TaskJobData.userId` → worker → `dispatchCouncilReview({...userId})` → `CouncilReviewerJobData.userId` → council worker.

7. **Template push worker**: This spawns `coder templates push` as a child process. The child process needs `CODER_URL` and `CODER_SESSION_TOKEN` in its env — these must come from the submitting user's credentials, not global env.

8. **Multi-deployment (R107)**: Different users may connect to different Coder instances. The `getCoderHost()` helper in the workspace proxy currently assumes a single CODER_URL. With per-user URLs, the proxy must derive the host from the user's `coderUrl`. This also affects `buildTargetUrl()` which constructs subdomain-based app URLs.
