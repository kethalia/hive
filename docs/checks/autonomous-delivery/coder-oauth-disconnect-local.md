# Explicit Coder disconnect — local acceptance

Implemented against `892c67d8` on 2026-11-06. The existing Settings Account section
offers Disconnect Coder for an OAuth connection, with explicit confirmation and
Cancel before submission. Ordinary Sign out retains its local-session behavior.
No F10 account connection work, migration or new credential table is included.

## Authorization and generation protocol

Settings exposes only OAuth source/status and credential ID/version. Browser
POST `/api/auth/coder/disconnect` requires the configured same origin, JSON and a
512-byte bounded body. It rejects caller-selected owner or origin fields and
obtains session authority from the signed Hive cookie. The Node and Fetch auth
transports use the same operation behind existing service authentication.

The operation discovers the session's owner, then acquires user and token locks
in that order. It rechecks the actual session/expiry, configured deployment and
client, OAuth source, selected ID/version and idle state. Stale generation or
active refresh returns a conflict without local writes or revocation. A winning
claim increments the credential version, places it in the existing reconnect
hold and deletes that owner's sessions atomically. Cancellation or session expiry
observed before commit rolls back all changes. Cancellation after commit cannot
undo the local authority change.

Only after commit does the auth service decrypt the captured access token and
attempt fixed-origin `POST /oauth2/revoke` with confidential client Basic
authentication. It never calls the broad user/application revocation endpoint.
The deployed Coder implementation deletes the exact access/refresh pair; its
pinned semantics are linked in [the revocation source audit](coder-oauth-revocation-local.md).
Requests omit cookies, use manual redirects and have a five-second deadline,
including non-cooperative Fetch implementations. No provider body or token is
logged. The operation does not refresh, steal or automatically retry a grant.

There are no post-provider database writes. A new login can replace the held
generation while revocation is pending, and its credential and sessions remain
untouched by the late result. A metadata read reports whether the connection
changed, remains held, or could not be observed. This is an advisory snapshot;
the UI describes the captured connection and offers an explicit refresh rather
than claiming the entire account remains disconnected. The response neither
clears browser cookies nor redirects over a concurrent sign-in.

## Unknown outcomes and UI

Provider HTTP200 is reported as acknowledgement of the revocation request, not
proof the token existed. Other responses, redirects, cancellation of the provider
deadline, decryption failure and transport failures are unconfirmed. Local
authority stays held, old sessions remain absent and no managed key is minted.
A lost transaction acknowledgement sends no provider request and is an unknown
outcome to the caller; a potentially committed local hold is never released.

The database reconnect state is durable local authorization state only. Remote
acknowledgement versus unconfirmed cutoff is returned to the initiating UI and
is **not a durable provider receipt**. There is no automatic cleanup or retry
queue. An explicit new sign-in creates a new credential generation/session and
does not restore deleted session UUIDs.

The Settings control guards double submission. A parallel request or replay
loses its authorizing session/generation and cannot revoke a second pair. Cancel
before confirmation sends no request. After submission, closing the pane or
losing the response does not imply undo: the UI reports uncertainty and offers
Refresh Hive / Continue with Coder without automatic retry. Provider responses
and credential material are excluded from browser error messages.

The Settings parent retains only this outcome after submission, with its obsolete
data query disabled. Full discovery-cache clearing still removes all private
payloads, including the old Settings DTO. The notice survives parent rerenders,
resize, a protected API401 and focus after the30-second stale interval. An owner
key change resets the notice; switching back also authenticates and reads anew.

## Validation

- **99 focused tests passed**: 62 actual isolated-PostgreSQL OAuth cases plus
  37 Settings contract/API/UI cases. New disconnect cases exercise owner isolation,
  exact-token wire parameters, local commit before provider I/O, stale generation,
  login and refresh races, late provider acknowledgement/failure, double submit
  and replay, SQL cancellation and session-expiry rollback, lost commit
  acknowledgement, postcommit cancellation, and a real five-second timeout.
- Auth service: **193 tests passed**; auth package: **58 tests passed**, including
  disconnect transport authentication, redirects and response projection.
- Auth service and full web TypeScript checks passed. Focused Biome and whitespace
  checks passed.
- The notice-lifecycle correction passed **51 focused frontend tests**, including
  the real DiscoveryProvider listener, acknowledgement/unconfirmed/lost outcomes,
  actual cache removal, explicit401, stale focus, parent rerender and owner changes.
  Its private reproduction failed before the fix and passed afterward. Broader
  post-fix build/type validation is performed by the primary on the pinned slice.
- Independent source review cleared the transaction/expiry fences, exact-token
  provider call, cancellation and unknown-outcome handling, browser route,
  transports, UI and meaningful PostgreSQL cases without material findings.

PostgreSQL 17 used the owned synthetic fixture at loopback port 55587, database
`hive_delivery_test`, with data directory `/tmp/hive-oauth-revocation-pg` verified
before applying existing repository migrations. No provider/Neon mutation,
production activation or browser execution was performed for this local slice.
The fixture process was stopped after validation. Native/provider/browser
acceptance is recorded separately by the primary agent before final F09 acceptance.


## Deployed checkpoint

The primary independently completed the real Browser/app/provider/Neon flow at
`ddcd16ea`; see [live evidence](coder-oauth-disconnect-live.json). Cancel, single
submission, old-session invalidation, exact captured-token401, notice persistence
and same-owner restoration passed. Focus events were synthetic DOM signals.
The committed [driver](../../../scripts/checks/coder-disconnect-browser.mjs) is the
formatted version of the executed private v2 source; the receipt records the
executed bytes separately. Five pure policy tests exercise its request bounds and
synthetic-focus helper without launching a browser. Production acceptance remains open.
