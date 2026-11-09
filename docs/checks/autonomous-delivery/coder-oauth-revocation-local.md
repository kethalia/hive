# Fresh OAuth credential revocation — local acceptance

Validated on 2026-11-06 against implementation base `a630616b`. This slice checks
fresh stored OAuth credentials before accepting a Hive session or returning a
token. Explicit disconnect, real-provider revocation, deployment, and production
acceptance remain separate gates. F10 account connections remain deferred.

## Provider source

The primary agent reported deployed Coder `v2.38.4+d16b1ca` from its read-only
build-info request. This slice independently inspected official source pinned to
[`d16b1cabb64417e197bb8887e9b8f6988d37837c`](https://github.com/coder/coder/commit/d16b1cabb64417e197bb8887e9b8f6988d37837c):

- [`httpmw/apikey.go`](https://github.com/coder/coder/blob/d16b1cabb64417e197bb8887e9b8f6988d37837c/coderd/httpmw/apikey.go): missing, expired, revoked keys and inactive users return 401. Audience rejection returns 403; its Bearer challenge identifies insufficient scope.
- [`oauth2provider/tokens.go`](https://github.com/coder/coder/blob/d16b1cabb64417e197bb8887e9b8f6988d37837c/coderd/oauth2provider/tokens.go): client authentication precedes grant redemption. A failed client returns `invalid_client`/401; an invalid or consumed refresh grant returns `invalid_grant`/400. Successful refresh replaces the previous access/refresh pair.
- [`oauth2provider/revoke.go`](https://github.com/coder/coder/blob/d16b1cabb64417e197bb8887e9b8f6988d37837c/coderd/oauth2provider/revoke.go): exact-token RFC7009 revocation deletes the associated API key; user/application revocation is broader. This slice calls neither endpoint.

## Behavior and bounds

The existing shared credential helper validates fresh credentials at the fixed
configured `/api/v2/users/me`, requiring the stored owner and active status.
Definitive identity rejection transitions only the matching token ID, user,
version, OAuth source/client, deployment and idle state to reconnect. Definitive
rejection also deletes that user's existing Hive sessions in the same bounded
transaction. The transaction takes user then token locks, matching login's write
order. A concurrent refresh or login winner is reloaded; a later login creates a
new session, while revoked session UUIDs remain absent. Successful validation
also rechecks the captured generation before returning its token.

Fresh identity 403, 429, 503, network failure, abort and malformed status fail the
current request without changing stored credentials. Structured token-endpoint
`invalid_client` releases only the matching holder's unconsumed refresh claim;
`invalid_grant` requires reconnect and atomically invalidates the current holder's
existing sessions using the same generation fence. An ambiguous refresh response retains its
existing hold. No managed key fallback or new identity/cache/table is added.
Logout still deletes only the requested local session.

Cancellation is checked after provider headers/body, before the invalidation
transaction, after acquiring its locks, and after the credential and session SQL
before commit. Cancellation observed there rolls back both changes. Cancellation
after an authoritative rejection has committed cannot undo that fact. Existing
in-flight work is not cancelled across requests, as with ordinary logout.

Provider requests retain manual redirects, omitted browser credentials, bounded
body parsing, sanitized errors, a five-second provider deadline and the shared
15-second credential deadline. Fresh-generation retries issue at most three
identity requests per helper invocation. The auth client retains its 20-second
deadline. Actual local service composition measured:

| Operation with a fresh credential | `/users/me` calls |
| --- | ---: |
| Session read | 1 |
| Raw token endpoint, including its session check | 2 |
| Generic terminal authorization, including its existing owner check | 4 |

The terminal's upstream identity/workspace 401 becomes close code 4401 and 403
becomes 4403, without account mutation based on 403. PTY setup preserves upstream
401/403 HTTP refusal. Established attachments use their existing 20-second
reauthorization schedule. Revocation detection occurs on credential use; this is
not a provider webhook or instantaneous notification to idle clients.

## Validation

- Seven targeted web suites: **118 passed**, including **41 actual PostgreSQL
  OAuth cases**, fresh revocation across existing sessions/status/token readers,
  wrong owner/inactive/deleted identity, delayed old 401 after refresh/login,
  bounded replacement retries, client configuration rejection, ambiguous refresh,
  call counts, logout, and terminal setup/established close classification.
- Review regressions reproduced the original immediate-abort-plus-401 mutation
  and session revival failures before the correction. They pass afterward.
  Actual PostgreSQL query interception verifies rollback when cancellation occurs
  after the credential update and after session deletion; new authorization never
  restores old revoked sessions, and delayed old 401 preserves a newer session.
- Auth service: **192 passed** in 18 suites.
- Auth service typecheck and full web TypeScript check passed.
- Biome checked all seven changed TypeScript files without fixes outstanding.
- Independent final source review cleared the cancellation finding and found no
  remaining material issue in this slice after inspecting the atomic session
  invalidation, lock order, generation fences and ambiguous-grant separation.

PostgreSQL 17 used a new synthetic fixture at loopback port 55587, with verified
data directory `/tmp/hive-oauth-revocation-pg` and database `hive_delivery_test`.
Repository migrations were applied only to this fixture. Provider HTTP responses
and credentials were synthetic; no Coder/Neon mutation or Git write was performed.
The local PostgreSQL process was stopped after validation. No live revocation or
production acceptance is claimed.
