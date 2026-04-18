# S02: Per-User Token Rewiring

**Goal:** Replace all static CODER_URL/CODER_SESSION_TOKEN env var usage with per-user credentials from the CoderToken table. Every Coder API call — server actions, workspace proxy, BullMQ workers, and template operations — resolves the authenticated user's decrypted API key at call time.
**Demo:** Submit a task — it runs end-to-end using submitting user's stored API key. No CODER_URL or CODER_SESSION_TOKEN in .env. Template push uses per-user token.

## Must-Haves

- `getCoderClientForUser(userId)` factory resolves per-user credentials from DB
- All workspace server actions use `authActionClient` with per-user CoderClient (R093)
- Task model has userId FK; createTask stores submitting user (R095)
- BullMQ task and council workers resolve submitting user's token per-job (R094)
- Workspace proxy resolves session and uses per-user credentials with user-scoped cache (R107)
- Template staleness and push operations use per-user credentials
- CODER_URL and CODER_SESSION_TOKEN removed from .env.example; ENCRYPTION_KEY added (R096)
- `rg "CODER_SESSION_TOKEN|CODER_URL" --type ts src/` returns zero hits (excluding test mocks)
- All new and updated tests pass via `pnpm vitest run`
- ## Threat Surface
- **Abuse**: Cross-user credential leakage if workspace proxy cache is keyed by workspaceId alone (mitigated by userId-scoped cache key). Worker job data includes userId — a compromised queue message could spoof another user's ID, but BullMQ runs server-side only with no external input surface.
- **Data exposure**: Decrypted API keys exist in memory during CoderClient construction. Never logged, never serialized. Encrypted at rest in CoderToken table.
- **Input trust**: userId comes from authenticated session (authActionClient) or from TaskJobData (server-only). No user-supplied userId reaches getCoderClientForUser directly.
- ## Requirement Impact
- **Requirements touched**: R088 (login flow unchanged but now consumed by factory), R089 (CoderToken read path exercised), R090 (User lookup in factory), R091 (session validation in workspace proxy), R093-R096, R107
- **Re-verify**: Login flow still produces valid CoderToken records; existing S01 tests must still pass
- **Decisions revisited**: None — D038-D043 all hold as designed
- ## Proof Level
- This slice proves: integration
- Real runtime required: no (unit + integration tests with mocked Prisma/decrypt)
- Human/UAT required: yes (end-to-end task submission after S03)
- ## Verification
- `pnpm vitest run src/__tests__/coder/user-client.test.ts` — factory unit tests
- `pnpm vitest run src/__tests__/actions/workspaces.test.ts` — rewired action tests
- `pnpm vitest run src/__tests__/queue/task-queue.test.ts` — worker per-user tests
- `pnpm vitest run src/__tests__/templates/` — template operation tests
- `rg "CODER_SESSION_TOKEN|CODER_URL" --type ts src/ | grep -v test | grep -v __tests__` returns empty
- `pnpm vitest run` — full test suite passes (no regressions)
- ## Observability / Diagnostics
- Runtime signals: `[user-client]` log prefix on token resolution errors (no-token, decrypt-failure, user-not-found)
- Inspection surfaces: CoderToken table (has user's encrypted token), Task table (has userId FK)
- Failure visibility: getCoderClientForUser throws typed errors distinguishing "no token stored" vs "decrypt failed" vs "user not found"
- Redaction constraints: Decrypted API keys never logged; only userId and error type appear in logs
- ## Integration Closure
- Upstream surfaces consumed: `src/lib/auth/session.ts` (SessionData, getSession), `src/lib/auth/encryption.ts` (decrypt), `src/lib/safe-action.ts` (authActionClient), `prisma/schema.prisma` (User, CoderToken models)
- New wiring introduced: `getCoderClientForUser()` factory consumed by all action/worker/proxy code paths; userId FK on Task; userId in all BullMQ job data interfaces
- What remains before milestone is truly usable end-to-end: S03 (Token Lifecycle — rotation, expiry handling) and terminal proxy per-user auth (deferred — separate service with own credential flow)

## Proof Level

- This slice proves: integration

## Integration Closure

Consumes S01 auth infrastructure (SessionData, encryption, authActionClient). Introduces getCoderClientForUser factory as the single credential resolution path. Terminal proxy deferred — separate service requiring proxy ticket mechanism.

## Verification

- getCoderClientForUser logs typed errors with [user-client] prefix. Task table gains userId FK for attribution. No secrets logged.

## Tasks

- [x] **T01: Add userId FK to Task model and create per-user CoderClient factory with tests** `est:45m`
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
  - Files: `prisma/schema.prisma`, `src/lib/coder/user-client.ts`, `src/__tests__/coder/user-client.test.ts`
  - Verify: pnpm prisma generate && pnpm vitest run src/__tests__/coder/user-client.test.ts

- [x] **T02: Rewire workspace server actions and proxy route to per-user credentials** `est:1h`
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
  - Files: `src/lib/actions/workspaces.ts`, `src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts`, `src/__tests__/actions/workspaces.test.ts`
  - Verify: pnpm vitest run src/__tests__/actions/workspaces.test.ts && rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/actions/workspaces.ts | grep -v test; test $? -eq 1

- [ ] **T03: Rewire BullMQ task and council workers to resolve per-user credentials per-job** `est:1h`
  Update task creation to accept userId and store it on the Task record (R095). Rewire task worker and council worker to resolve the submitting user's decrypted API key per-job instead of using injected shared CoderClient (R094). Propagate userId through the council dispatch chain.

Steps:
1. In `src/lib/api/tasks.ts`: add `userId: string` parameter to `createTask()`. Store userId on the Task record insert. Include `userId` in the TaskJobData enqueued to BullMQ.
2. In `src/lib/queue/task-queue.ts`: add `userId: string` to the `TaskJobData` interface. Change `createTaskWorker(coderClient: CoderClient)` signature to `createTaskWorker()` (no parameter). Inside the processor, resolve credentials per-job: `const coderClient = await getCoderClientForUser(job.data.userId)`. Update all internal uses of `coderClient` — it's now resolved inside the processor, not injected.
3. Update the `cleanupWorkspace` helper call to use the per-job coderClient.
4. In `src/lib/council/dispatch.ts`: update `CouncilDispatchParams` to include `userId: string`. Pass userId through to `CouncilReviewerJobData` when dispatching reviewer jobs.
5. In `src/lib/queue/council-queues.ts`: add `userId: string` to `CouncilReviewerJobData`. Change `createCouncilReviewerWorker(coderClient: CoderClient)` to `createCouncilReviewerWorker()`. Resolve credentials per-job via `getCoderClientForUser(job.data.userId)`.
6. In `src/lib/queue/task-queue.ts`: update the `dispatchCouncilReview()` call inside the task worker processor to pass `userId: job.data.userId`.
7. Update callers of `createTask()` to pass userId — search for `createTask(` usage across the codebase. The primary caller is likely a server action that should get userId from `ctx.user.id`.
8. If `src/instrumentation.ts` calls `createTaskWorker(coderClient)`, update it to `createTaskWorker()` (no argument). Currently only template push worker is started there.
9. Write/update tests: mock getCoderClientForUser in worker tests, verify userId flows from createTask → job data → worker → council dispatch → council worker.

Must-haves:
- [ ] createTask accepts userId and stores it on Task record
- [ ] TaskJobData includes userId
- [ ] Task worker resolves CoderClient per-job via getCoderClientForUser
- [ ] Task worker signature changed to createTaskWorker() (no coderClient param)
- [ ] CouncilReviewerJobData includes userId
- [ ] Council reviewer worker resolves CoderClient per-job
- [ ] userId propagated through dispatch chain: createTask → TaskJobData → worker → dispatchCouncilReview → CouncilReviewerJobData → council worker
- [ ] Tests verify per-job credential resolution

Failure Modes:
| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| getCoderClientForUser (in worker) | Job fails, task status set to 'error', errorMessage describes token issue | Prisma timeout → job retry | N/A |
| Prisma (Task insert with userId) | createTask throws, caller handles | Default Prisma timeout | N/A |

Negative Tests:
- Job with userId that has no CoderToken → job fails with clear error about re-authentication
- Job with userId that doesn't exist → job fails with USER_NOT_FOUND
- Null userId on legacy tasks → worker handles gracefully (skip or fail with message)
  - Files: `src/lib/api/tasks.ts`, `src/lib/queue/task-queue.ts`, `src/lib/queue/council-queues.ts`, `src/lib/council/dispatch.ts`, `src/__tests__/queue/task-queue.test.ts`, `src/__tests__/queue/council-queues.test.ts`
  - Verify: pnpm vitest run src/__tests__/queue/ && rg 'CODER_SESSION_TOKEN|CODER_URL' src/lib/queue/ src/lib/api/tasks.ts src/lib/council/dispatch.ts | grep -v test; test $? -eq 1

- [ ] **T04: Rewire template operations to per-user credentials and remove static env var requirements** `est:45m`
  Parameterize template staleness checking and push operations to use per-user credentials instead of env vars. Remove CODER_URL and CODER_SESSION_TOKEN from .env.example. Add ENCRYPTION_KEY. Verify no remaining env var references in src/ (R096).

Steps:
1. In `src/lib/templates/staleness.ts`: change `compareTemplates(names: string[])` signature to `compareTemplates(names: string[], userId: string)`. Replace env var reads with `const client = await getCoderClientForUser(userId)`. Remove the local CoderClient construction from env vars.
2. In `src/lib/templates/push-queue.ts`: add `userId: string` to `TemplatePushJobData` interface. In the worker processor, resolve credentials per-job: `const client = await getCoderClientForUser(job.data.userId)`. Use the decrypted token and user's coderUrl for the child process env instead of `process.env.CODER_URL`/`process.env.CODER_SESSION_TOKEN`.
3. Update callers of `compareTemplates()` to pass userId — search for usage across codebase.
4. Update callers that enqueue template push jobs to include userId in job data.
5. In `src/instrumentation.ts`: verify `createTemplatePushWorker()` still works (it already takes no args, but the internal processor now resolves credentials per-job).
6. In `.env.example`: remove `CODER_URL=` and `CODER_SESSION_TOKEN=` lines. Add `ENCRYPTION_KEY=` with a comment about generating a 32-byte hex key.
7. Run `rg 'CODER_SESSION_TOKEN|CODER_URL' --type ts src/` and verify zero hits outside of test files and type definitions. Fix any remaining references.
8. Write/update tests for staleness.ts and push-queue.ts — mock getCoderClientForUser, verify no env var reads.
9. Run full test suite to verify no regressions from S01 or earlier work.

Must-haves:
- [ ] compareTemplates accepts userId and uses getCoderClientForUser
- [ ] Template push worker resolves per-user credentials per-job
- [ ] TemplatePushJobData includes userId
- [ ] CODER_URL and CODER_SESSION_TOKEN removed from .env.example
- [ ] ENCRYPTION_KEY added to .env.example
- [ ] No CODER_URL/CODER_SESSION_TOKEN references in src/ (excluding tests)
- [ ] Full test suite passes

Negative Tests:
- Template push with userId that has no token → job fails with clear error
- compareTemplates with invalid userId → throws USER_NOT_FOUND
  - Files: `src/lib/templates/staleness.ts`, `src/lib/templates/push-queue.ts`, `src/instrumentation.ts`, `.env.example`, `src/__tests__/templates/staleness.test.ts`, `src/__tests__/templates/push-queue.test.ts`
  - Verify: pnpm vitest run src/__tests__/templates/ && rg 'CODER_SESSION_TOKEN|CODER_URL' --type ts src/ | grep -v __tests__ | grep -v test; test $? -eq 1

## Files Likely Touched

- prisma/schema.prisma
- src/lib/coder/user-client.ts
- src/__tests__/coder/user-client.test.ts
- src/lib/actions/workspaces.ts
- src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts
- src/__tests__/actions/workspaces.test.ts
- src/lib/api/tasks.ts
- src/lib/queue/task-queue.ts
- src/lib/queue/council-queues.ts
- src/lib/council/dispatch.ts
- src/__tests__/queue/task-queue.test.ts
- src/__tests__/queue/council-queues.test.ts
- src/lib/templates/staleness.ts
- src/lib/templates/push-queue.ts
- src/instrumentation.ts
- .env.example
- src/__tests__/templates/staleness.test.ts
- src/__tests__/templates/push-queue.test.ts
