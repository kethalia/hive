# P02 Better Auth and Coder OAuth

[PR452](https://github.com/kethalia/hive/pull/452) implements this increment on
`codex/coder-oauth-better-auth`, based on merged P01b `d7bd8b10`.

## Owner acceptance

1. Open [the preview](https://codex-coder-oauth-better-auth.hive-preview.kethalia.com)
   and choose **Continue with Coder**.
2. Authenticate and approve Hive on `coder.kethalia.com` in the separate sign-in window.
3. Return to Hive, reload, open Settings and use an ordinary terminal.
4. Sign out and sign back in. Disconnect Coder and reconnect through consent.

The [popup and Safari follow-up](popup-safari.md) compares the reported download
prompt with the epic correction and records the separate-window implementation.

Hive identifies users by the configured Coder origin and Coder user UUID.
Existing Hive UUIDs, preferences and references survive migration and reconnect.
Email does not join accounts. Users complete a one-time OAuth sign-in that
replaces their legacy Hive sessions. Production OAuth mode rejects password login
and legacy session cookies.

Better Auth 1.7.25 owns consent state, PKCE, callbacks, encrypted account-token
storage and signed host-only browser cookies. The public session UUID continues
to identify terminal tickets. The framework secret session token has a separate
column and stays in the HttpOnly cookie. A durable PostgreSQL lease serializes
rotating refreshes. Unknown provider outcomes and persistence rollback require
reconnect. Grant versions fence concurrent sign-in, revocation and disconnect.

Sign out ends the local session. Disconnect clears the stored grant, ends all
Hive sessions for that identity and revokes its captured Coder grant. Uncertain
provider revocation produces an explicit notice with the Coder revocation action.

## Hosted deployment and isolation

| Item | Verified value |
| --- | --- |
| Worker | Existing single `hive` Worker with repository-connected Workers Builds |
| Accepted popup authentication code | `c5c665512a155a5f18372001d8dd462f78d8bee6` |
| Connected build | `a250d3d3-0730-4189-a4a4-106dea763807` |
| Preview | `codex-coder-oauth-better-auth.hive-preview.kethalia.com` |
| Application build | `1a3df0b6-a65c-42a6-b92d-cc517fcba269` |
| Application version | `2.33.0`, with the release changeset included |
| Preview Coder application | `16e90cc4-bb86-414d-80fa-9f7c7f6c8d93` |
| Callback | `/api/auth/callback/coder` on the exact preview origin |
| Neon project and branch | `purple-math-59583745`, `br-ancient-violet-b7pcun87` |
| Preview database and OID | `hive_coder_oauth_preview`, `368640` |
| Preview runtime role | `hive_coder_oauth_runtime` |
| Schema | Twelve migrations and fifteen application tables |

The preview uses independent secrets and the existing Free-plan 0.25 CU compute.
No additional compute was created. Initial secrets were supplied through the
official Wrangler preview command. P02 was added to the existing preview build
configuration and its branch settings use `pnpm build:cloudflare` followed by
`node deploy/cloudflare/native/deploy.mjs preview`.

## Automated checks

- Final full Vitest run passed **2,348 tests**, with 81 optional tests skipped.
- Fourteen actual PostgreSQL cases cover PKCE, encrypted storage, identity and
  preference preservation, concurrent refresh, revocation, lost refresh response,
  client refusal, newer login, persistence rollback, delayed callback, disconnect
  races, and atomic recovery when OAuth is disabled.
- Auth service passed 153 tests. The Node terminal suite passed 239 tests and the
  affected application transport slice passed 558 tests.
- Deployment/build-integrity/migration preflight passed 42 tests. Native
  composition/background and local Workerd checks also passed.
- Application, Cloudflare and Node terminal typechecks pass. Repository formatting
  passes. Changeset validation passes.
- Independent final review at `9b1c1f8d` found no remaining confirmed P1/P2 issues.

Fresh-install and upgrade checks preserve all eleven original migration
checksums, original rows and actual runtime privileges. The additive twelfth
migration is `20261114010000_coder_oauth_better_auth`.

## Real browser and provider acceptance

The popup UI accepted the authentication code and application build listed
above. The latest popup follow-up passed normal sign-in and lost-message/manual-close
recovery in Linux WebKit and Chrome. Native Safari remains for owner retesting.
The terminal and refresh phase used `9b1c1f8d`. Earlier consent/disconnect
checks used reviewed code `eac11a78`. Each receipt retains its exact source.

- Official Coder sign-in and consent return to Hive. Reload preserves the session
  and Settings exposes the account controls.
- Sign out invalidates the session. The final corrected flow removes the
  framework cookie from the browser.
- Disconnect returns 200, clears the stored grant and leaves zero Hive sessions.
  Reconnect returns to the same Hive user UUID.
- A UI-created terminal accepts input and displays its output marker. Actual
  `stty` dimensions follow viewport resize.
- Reload and manual reconnect return to the same shell PID. Exit produces a clean
  WebSocket close with code 1000, and the test terminal window closes.
- Three concurrent real credential requests after forced stored expiry make
  exactly one Coder token refresh request. All receive the same new credential.
  Authenticated browser data loads after that refresh.
- Final sign out removes the cookie. An unauthenticated request returns 401 or a
  307 redirect to the exact login path, according to its entry point.

The [live refresh receipt](live-refresh.json) records identities, grant versions
and request counts without credential values. Additional browser receipts and
screenshots in this directory preserve UI acceptance.

## Production preparation and release

The owner approved production preparation on 14 November. Production now has all
twelve migrations with matching checksums. Original user, session and legacy-token
rows are preserved. Scoped grants and preview-role isolation pass. The separate
production Coder OAuth secret is configured on the existing Worker. The secret
update retained the serving code's recorded ETag. The
[production preparation receipt](production-preparation.json) records the exact
database OID, grants hash and Worker version.

The production Coder application's callback is
`https://hive.kethalia.com/api/auth/callback/coder`, with public client ID
`0a4e5cd5-cf36-4c56-927c-effe349286c8`.

The owner merges the accepted increment. Repository-connected Workers Builds
then deploys main. Production acceptance covers browser consent, reload, terminal
and sign out.

For rollback, retain the additive schema and original migration history, deploy
the previously accepted application revision and restore its reviewed deployment
configuration. Users can sign in through that revision's legacy flow. Preserve
OAuth records for a corrected forward deployment. Disabling OAuth on P02 also
supports atomic password-login recovery, switching credential mode and session
state in the same transaction.

## Corrected findings and validation limitations

Review corrected delayed callback activation reopening a failed refresh fence,
stale OAuth cookies shadowing flag-off legacy sessions, and non-atomic legacy
recovery. Hosted checking exposed a framework-cookie deletion header replaced by
a later NextResponse cookie write. Each correction has regression checks.

The initial preview migration used a pooled connection and left an idle advisory
lock after applying all twelve migrations. Completed checksums were verified,
the exact owned idle backend was terminated, and the direct endpoint was verified.
Production preparation used the direct owner endpoint.

During a preview rollout, an already-loaded page requested a historical chunk
that returned 404. A fresh document and its current runtime chunk both return 200.
A follow-up probe initially targeted the historical chunk and was corrected.
Browser harness corrections also covered Coder permission checks, redirect timing,
hydration and unauthenticated redirect semantics.

One 300 ms PTY lifetime fixture failed under an earlier concurrent run. Its
isolated retry and the final full two-worker run passed.

Browser Testing reused persistent workspace
`5cf78a47-70dc-4781-ac53-b7a3d4b1001f`; terminal testing reused software workspace
`23023679-3c7b-4a50-ba52-4ca31673148e`. Primary records captured their identities
and task start builds before use. The software agent connects and terminal
acceptance passes, while startup reports an unrelated unavailable official Claude
TypeScript LSP marketplace plugin.
