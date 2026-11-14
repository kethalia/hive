# P02 Better Auth and Coder OAuth

Implementation branch `codex/coder-oauth-better-auth`, based on merged P01b
`d7bd8b10`. This increment replaces the Hive password form with Coder browser
consent through Better Auth 1.7.25.

## Connection flow

1. Open the login page and choose **Continue with Coder**.
2. Authenticate and approve the Hive application on `coder.kethalia.com`.
3. Return to Hive, reload and open an ordinary terminal.
4. Sign out through Settings and sign back in.
5. Disconnect Coder through Settings and reconnect through browser consent.

Hive identifies an account by the configured Coder origin and Coder user UUID.
Existing Hive UUIDs, preferences and references survive migration and reconnect.
Email does not join accounts. Existing users complete a one-time OAuth sign-in.
That sign-in replaces their legacy Hive sessions. OAuth mode rejects legacy
password login and legacy session cookies.

Better Auth owns consent state, PKCE, callback handling, encrypted account-token
storage and signed host-only browser cookies. The existing public session UUID
continues to identify terminal tickets. The framework secret session token has a
separate database column and stays in the HttpOnly cookie.

One durable refresh lease serializes rotating provider credentials. Unknown
provider outcomes or a failed persistence transaction require reconnect. A known
client-configuration rejection releases the lease for a safe retry. Captured
grant versions fence concurrent sign-in, revocation and disconnect.

Sign out ends the local session. Disconnect clears the stored grant, ends all
Hive sessions for that identity and revokes its captured Coder grant. An uncertain
provider revocation produces an explicit reconnect/revoke notice.

## Isolated hosted target

- Preview `https://codex-coder-oauth-better-auth.hive-preview.kethalia.com`.
- Existing single Worker `hive`, using repository-connected Workers Builds.
- Coder preview application `16e90cc4-bb86-414d-80fa-9f7c7f6c8d93`.
- Callback `/api/auth/callback/coder` on the exact preview origin.
- Neon project `purple-math-59583745`, existing branch `br-ancient-violet-b7pcun87`.
- Database `hive_coder_oauth_preview`, PostgreSQL OID `368640`.
- Runtime role `hive_coder_oauth_runtime`, restricted to this database.
- Twelve checked migrations, fifteen application tables, independent preview secrets.
- Existing Free-plan compute retained at 0.25 CU. No additional compute was created.

The new additive migration is
`20261114010000_coder_oauth_better_auth`. All eleven previous migration checksums
remain unchanged. The migration adds framework fields, Coder OAuth accounts,
verification records, identity-binding checks and refresh-lease constraints.

Use a direct owner connection for migrations. Runtime requests use the pooled
connection. The first preview migration used a pooled URL and left an idle
advisory lock after successfully applying all twelve migrations. Its completed
checksums were verified, the exact owned idle backend was terminated, and the
direct endpoint was verified. No other database was changed by that correction.

## Automated validation

- Full Vitest suite passed 2,277 tests, with 81 optional tests skipped.
- Final focused auth, middleware and settings suite passed 166 tests.
- Fourteen real PostgreSQL Better Auth cases cover PKCE, encrypted storage, stable
  identity and preferences, concurrent refresh, fresh revocation, a lost refresh
  response, client misconfiguration, late rejection after newer sign-in,
  persistence rollback, a delayed callback after uncertain refresh, and disconnect racing refresh.
- Transport slice passed 558 application tests and 239 Node terminal tests.
- Native deployment passed 17 plan tests, 16 composition/background tests and
  six local Workerd tests.
- Database checks cover fresh install, the eleven-to-twelve upgrade, preserved
  original rows, identity and lease constraints, and actual runtime privileges.

Hosted acceptance, final build identity, current-source review and CI results are
recorded below as they complete.

## Production preparation before merge

The production database currently has eleven migrations. Before deploying P02,
apply the reviewed additive twelfth migration through the direct owner endpoint
and reapply the production runtime grants. Check exact history, checksums and
existing-user preservation. Configure `CODER_OAUTH_CLIENT_SECRET` for production
using the separately registered production Coder application. Its callback is
`https://hive.kethalia.com/api/auth/callback/coder` and its public client ID is
`0a4e5cd5-cf36-4c56-927c-effe349286c8`.

Complete preview acceptance and obtain owner approval for this production
preparation before the owner merges. Repository-connected Workers Builds then
deploys main. Verify production browser consent, reload, terminal and sign out.

For an application rollback, retain the additive schema and original migration
history, deploy the previously accepted application revision and restore its
reviewed deployment configuration. Users can sign in through the legacy flow in
that revision. Preserve OAuth records for a corrected forward deployment.

## Final review corrections

Independent review found two issues, both corrected with regression checks.
Callback activation now resets the refresh lease atomically with its new token
write and cannot reopen a later uncertain-refresh fence. A stale OAuth cookie
no longer shadows a valid legacy session when OAuth is explicitly disabled.
The enabled OAuth flow continues to reject legacy-only sessions.

## Preview initialization and build

PR [452](https://github.com/kethalia/hive/pull/452) tracks this increment.
The reviewed implementation is `245a58d6817a42dc64567715f279c7ba69df2b1c`.
The local Cloudflare build and both application/Cloudflare typechecks pass.
The first initialized preview deployment is `d2609419`, with application build
`94856c3f-f53b-4397-9f68-13189fb82165` and version `2.33.0`.

Cloudflare's existing preview build configuration contained an explicit list of
the earlier enrolled branches. P02 was added to that existing list so subsequent
commits run its real build and preview deployment. Initial preview secrets were
provided through the official Wrangler preview command. All five preview secrets
are independent from production.

Browser acceptance reuses persistent Browser Testing workspace
`5cf78a47-70dc-4781-ac53-b7a3d4b1001f` and software test workspace
`23023679-3c7b-4a50-ba52-4ca31673148e`. Their identities and task start builds
were recorded before use. The software agent connects and has tmux available,
but its startup reports an unrelated missing official Claude TypeScript LSP
marketplace plugin. That template issue is retained as a test-fixture limitation.

Password-login recovery with OAuth disabled also updates the user's credential
mode, encrypted legacy token and replacement session atomically, while ending
old OAuth sessions. Four additional PostgreSQL checks cover connected and
disconnected users plus token-write and session-write rollback. The auth service
suite now passes 153 tests.
