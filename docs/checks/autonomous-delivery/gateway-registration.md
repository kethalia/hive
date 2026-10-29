# Workspace gateway and registration authority

2026-10-29. F04 registration integration now includes disabled HTTP routes, durable
PostgreSQL storage, and private Coder app bootstrap/discovery. No template deployment,
automatic startup, or public listener activation has occurred.

## Implemented and checked

`templates/ai-dev-k8s/scripts/codex-project-gateway.mjs` connects the supervisor to
`codex-session-bridge.mjs` through a private native-socket factory. The token and
loopback address remain inside the native runtime closure. The gateway derives
owner/workspace/build/server lifetime from the supervisor, then verifies each
signed capability's exact thread against the independent registered thread set.
No ticket supplies native endpoint, credentials, paths, model overrides or new
execution authority. Legacy fixed-thread bridge configuration remains supported.

One gateway handles multiple registered project threads. Each connection retains
one exact full binding, one native connection and the existing read-only RPC
allowlist. Renewals cannot switch to another registered thread. Native version
verification still precedes acknowledgement/events; supervisor revocation closes
active clients with policy code 1008. Read binding is independent of checkout
presence/lease expiry; execution continues to require verified active checkout
provenance and lease. The gateway never starts a thread, turn or shell command.

Local checks:

```sh
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-project-supervisor.test.mjs scripts/verify-codex-project-gateway.test.mjs
node --test scripts/verify-codex-session-bridge.test.mjs
pnpm exec vitest run src/__tests__/lib/codex-session/registration.test.ts
pnpm typecheck
```

Supervisor/gateway: 18 passing tests, including actual Codex 0.165.0 and native
CLI with one persisted thread, signed gateway history reads on that same thread,
and a fresh-server gateway read after the fixture checkout was removed. The
first prompt uses a local Responses fixture: no account-backed model inference.
Legacy bridge: 14 passed, one native test skipped in the default invocation; its
explicit native invocation is recorded with remote fixture results below.
Registration authority: seven passing tests. Real browser Coder-cookie/upgrade
validation remains separate Browser Testing work.

## Server-only authority contract

`src/lib/codex-session/registration.server.ts` implements a provisioner-facing
cryptographic/domain service. It has no route and no persistence fallback.
`WorkspaceRegistrationAuthority.issue(principal, workspaceId, agentId, projectIds)` takes a
**server-authenticated** Hive/Coder principal; this argument is not a JSON identity
accepted from a browser or workspace. A configured server-side Coder client:

- Verifies owner, exact running build and an explicitly allowlisted software template.
- Resolves the exact connected agent in that build's resources, rather than choosing
  a caller-asserted agent or accepting a forwarded manifest.
- Requires an existing app with the configured slug, owner-only sharing, isolated
  subdomain routing and no external redirect. Its internal URL must point to the
  configured loopback gateway port. App ID and Coder deployment origin are bound.
- Derives HTTPS app origin from Coder's application-host configuration and the
  verified owner/workspace/agent/app names, outside Hive cookie scope.
- Loads the allowed project/repository set through a server-owned repository callback.
  The host cannot enroll arbitrary repository IDs or project IDs.
- Rechecks owner/build after the metadata reads. Redemption independently repeats
  the checks and rejects any changed binding.

[Coder's WorkspaceApp schema](https://github.com/coder/coder/blob/main/codersdk/workspaceapps.go)
distinguishes its internal proxy URL, app ID, `sharing_level`, `subdomain` and
`external` fields. Current local SDK types omit `apps`; absence in the actual
resource response fails closed, and real Coder response compatibility is an
activation gate. No external app URL is accepted from the registration request.

The grant is Ed25519-only with a pinned issuer key ID, audience
`hive:workspace-registration`, scope `workspace:register`, random nonce, at most
60 seconds and a durable per-host generation. It includes the exact independently
verified binding and allowed projects. The trusted provisioner must deliver it to
that agent/build; it must never be returned to a browser or put in model prompts,
logs, command arguments or repository content.

Redemption accepts only `grant`, `serverInstanceId`, `protocolVersion: "0.165.0"`,
`threads`, `hostPublicKeyPem` and `proof`. Threads are a subset of authorized project
and repository pairs with unique thread and project ownership. The host proves
possession of its Ed25519 key over `registrationProofPayload`, which binds the exact
grant digest and registration content. All identities, URLs and arbitrary methods
outside this schema are rejected. The result has a 60-second registration lease;
future ticket issuance must enforce that expiry and require authenticated heartbeat
renewal. Key possession alone does not attest a program binary: the intended trust
boundary is the installed software supervisor plus trusted grant delivery.

`RegistrationStore` is mandatory. `reserve` advances a host generation; `seal`
persists the exact grant digest; `consumeAndRegister` must atomically check pending
nonce, digest, expiry, exact binding and latest generation, consume once, replace
that host's registered lifetime and revoke its previous registration. Failed/partial
issuance retains an unusable reservation until expiry/supersession. Unit tests use
an explicitly injected in-memory fixture store, never a production implementation.
Concurrent redemption admits one winner; older grants cannot overwrite a newer
registration. Coder unavailability and missing storage fail closed.

## Approved persistence/API integration

Root approved this implementation after coordination with `delivery_gate_audit`.
Migration `20261029050000_codex_host_registration` adds the four tables below.

Implemented tables use Hive owner UUID foreign keys and composite owner keys:

| Table | Fields and constraints |
| --- | --- |
| `CodexHostSlot` | UUID ID, owner ID, Coder origin/owner ID, workspace ID, agent ID, current issue generation, active registration ID; unique `(owner, coderOrigin, workspace, agent)` |
| `CodexRegistrationGrant` | nonce UUID primary key, host-slot FK, generation, exact binding JSON plus digest, nullable sealed token digest, issued/expiry/consumed timestamps; unique `(hostSlot, generation)`, token digest unique when present |
| `CodexHostRegistration` | UUID ID, host-slot FK, generation, build/template/app IDs, app origin, server lifetime UUID, protocol version, host public key/fingerprint, registered/lease-expiry/revoked timestamps, heartbeat sequence; unique `(hostSlot, generation)` |
| `CodexRegisteredThread` | owner/project/conversation/registration FKs and native thread ID; unique `(registration, project)` and `(registration, nativeThread)`; project/conversation composite-owner constraints |

Transactions:

1. Reserve: lock/upsert host slot, increment issue generation and insert pending
   grant. No database-stored plaintext grant or private key.
2. Seal: CAS the unconsumed pending grant/generation and store its signed token digest.
3. Redeem: lock host slot and grant; require latest generation, unconsumed/sealed
   digest, unexpired deadline and exact binding. Insert registration and thread
   associations, update active slot, consume grant and revoke old registration in
   one transaction. Update/create `DeliveryConversation` only for authorized
   owner/project/repository and exact native thread; set its verified build/server
   fields. Preserve prior conversations/history; never copy host paths into
   `nativePath` from a request. The delivery runtime adapter then reads those
   persisted bindings, as required by its recovery contract.
4. Heartbeat: Ed25519 signature over registration ID, strictly increasing sequence,
   current lifetime and controller nonce; transactional sequence/lease CAS and fresh
   Coder owner/build check. Timeout, changed build or key failure prevents renewal.
   The server service and installed host client now implement this method.

Implemented endpoint separation (disabled unless explicitly configured):

- Internal provisioner grant issuance: workload-authenticated controller only,
  no browser or manager registration shortcut. The internal provisioner function
  delivers through the verified owner-only Coder app exchange described below.
  Owner SSH remains a development probe only.
- `POST /api/codex-host/registrations`: bounded request (64 KiB), grant/proof
  verification and transactional redemption; no cookies/forwarded app headers used
  as proof of workspace identity. No owner credential accepted from the host.
- `POST /api/codex-host/registrations/:id/heartbeat`: signed host-key sequence renewal
  with replay fencing and current-build reauthorization.
- Owner-session `POST /api/projects/:projectId/session-grant`: validates session,
  same-origin request, project ownership, current Coder build and unexpired active
  registration/thread association, then issues the existing <=60s exact-thread read
  capability. Every renewal repeats authorization. URL derives from registered app
  metadata; no browser-supplied binding or endpoint is signed.

Only after those transactions/routes, trusted distribution, provisioner delivery and
Browser Testing pass should the software template add one `share="owner"`,
`subdomain=true` gateway app. No raw native listener becomes a Coder app. Approval
and input endpoints remain separate future scopes. Root approved the schema/routes and delivery design; activation remains a separate
reviewed step.

## Real test workspace evidence

The primary-created persistent validation workspace `codex/hive-epic-test`
(`22c4f094-46f0-4a76-86ca-37ad74254872`) was inspected through its private test-account
Coder session, scoped only to that CLI process. It reported software/cli profile,
Codex 0.165.0, Node 24.21.0, Python 3.13.5, Git 2.47.3 and tmux 3.5a. The reviewed
GitHub discovery helper used that workspace's own agent external-auth and returned
ten repositories, verified provider identity and a next-page cursor. Private
repository names and credentials are omitted from committed evidence.

The workspace lacked `ws`. A self-contained temporary fixture bundle used exactly
the primary lockfile's ws 8.21.3, bundled by existing esbuild 0.28.2, with source and
bundle SHA-256 hashes. Only source and that bundled dependency traveled over stdin;
no node_modules tree, owner/OpenAI/GitHub credentials or account sessions were copied.
There was no remote package install, startup edit or template change.

On 2026-10-29 the remote commands returned exit 0:

```sh
python3 -m unittest scripts/agents/test_managed_projects.py -v
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-session-bridge.test.mjs scripts/verify-codex-project-supervisor.test.mjs scripts/verify-codex-project-gateway.test.mjs
```

Results: **25 checkout tests and 33 native/session/gateway tests passed, zero skips**.
That includes the exact native same-session proof, gateway read after checkout
removal, parent-death termination, replay fencing and deterministic inode-reuse
cleanup regression. Fixture scratch paths and child processes were removed by their
owned harness. The persistent validation workspace is retained; the primary owns
its lifecycle. This was an isolated fixture run, not an activated host deployment.

Raw bounded output and source/dependency manifests:
[test-workspace-runtime-evidence.json](test-workspace-runtime-evidence.json).
Primary provenance: [test-workspace-creation.json](test-workspace-creation.json).


## Durable implementation and app bootstrap

`registration-store.server.ts` uses PostgreSQL transactions and an exclusive host-slot
row lock for reservation, sealing, consumption/replacement and heartbeat. A pending
new generation immediately fences the old registration. Redemption consumes exactly
once, creates the new host/thread associations and verified DeliveryConversation
binding, revokes the previous registration, and updates the active pointer atomically.
Project/owner foreign keys and independent database repository identity checks prevent
cross-owner association. The SQL migration additionally constrains the active pointer
to the same owner and slot. No plaintext bearer grant or issuer private key is stored.
Conversation records remain after checkout removal; history reads do not require a
checkout lease. `lockActiveRegistration(tx, {ownerId, registrationId})` is exported for
controller mutations to lock/recheck authority inside their own transaction.

`registered-session.server.ts` rechecks Coder owner/current running build/template/app
before every read grant and signed host heartbeat. Heartbeats require the pinned host
Ed25519 key, exact lifetime, next sequence and current controller nonce; each success
rotates the nonce and grants 60 seconds. Host heartbeat runs every 20 seconds, and any
renewal failure revokes host read authority. Browser read tickets are at most 60 seconds
and cannot outlive the host lease. All externally supplied failure details are replaced
with fixed errors. POST body reads enforce content type, byte bounds and a deadline.

Required server-only configuration, absent by default:

- `HIVE_CODEX_GATEWAY_ENABLED=true`
- `HIVE_CODEX_ISSUER_PRIVATE_KEY` (Ed25519 PEM secret), `HIVE_CODEX_ISSUER_KEY_ID`
- `HIVE_CODEX_HIVE_ORIGIN`, `HIVE_CODEX_SOFTWARE_TEMPLATE_IDS` (comma-separated)
- `HIVE_CODEX_APP_SLUG`, `HIVE_CODEX_GATEWAY_PORT`; existing `COOKIE_DOMAIN` is checked.

The installed host receives public issuer key plus independently provisioned
Hive/Coder/owner/workspace/build/agent/template/app identity, not values adopted from
a grant. Its private Ed25519 key lives only in the supervisor's private signed registry.
`codex-host-registration.mjs` verifies exact signed bootstrap bindings, selects only
already registered local project threads, persists the consumed generation before
network redemption, signs the proof and calls the fixed Hive registration endpoint.
An ambiguous crash needs a fresh grant; it never silently retries a one-use generation.
Restart does not revive a saved active lease. The read gateway denies access until
registration succeeds and closes clients on host expiry or native lifetime loss.
No bootstrap request creates a thread, starts a turn, changes model, executes a shell,
or supplies a filesystem path.

The shared server helper `postToVerifiedWorkspaceApp` allows only the two fixed paths
`/registration/bootstrap` and `/projects/discover`. It accepts independently verified
origin metadata, bounded JSON body and capability expiry, and returns bounded JSON.
It uses canonical `getApplicationAuthRedirect`, checks the exact returned app origin
and path, exchanges the encrypted parameter without owner headers, accepts one expected
Secure/HttpOnly app cookie, then sends one POST with manual redirects. Cookies and grants
remain request-local memory. There is no browser grant response or general cookie jar.
Limits: 10-second exchange budget, 20 KB request, 32 KB response headers, 4 KB bootstrap
response or 512 KiB discovery response. The helper does not confer authority by itself;
callers must independently authorize the host and sign the narrow capability.

Coder v2.38.2's [auth redirect implementation](https://github.com/coder/coder/blob/v2.38.2/coderd/workspaceapps.go)
creates an `application_connect` scoped key with a bounded session lifetime and encrypts
it into the app redirect. Its [app proxy](https://github.com/coder/coder/blob/v2.38.2/coderd/workspaceapps/proxy.go)
exchanges the parameter, removes it with a same-origin redirect, and strips Coder cookies
before upstream forwarding. [Cookie naming](https://github.com/coder/coder/blob/v2.38.2/coderd/workspaceapps/cookies.go)
includes the wildcard-host hash. This is broader than one app at Coder's cookie-domain
layer, so our transport sends the cookie only to the exact verified app origin.

Actual test-workspace code-server `/healthz` probe: unauthenticated 303; canonical
owner-authenticated Coder API 303; encrypted-query exchange 303 with Secure/HttpOnly
app cookie; cookie-authenticated app request 200. Owner token went only to Coder API.
No response body, cookie value, encrypted redirect or token was saved. Sanitized evidence:
[test-workspace-app-exchange.json](test-workspace-app-exchange.json). This verifies HTTP
bootstrap transport, not a real browser WebSocket/third-party-cookie interaction.

## Discovery before native registration

`resolveVerifiedWorkspaceHost` is shared by registration and server discovery. Without
an agent ID it requires exactly one connected agent with the configured owner-only app;
ambiguity fails closed. It returns verified host metadata without requiring project
records. Native registration retains its nonempty authorized-project requirement.

`codex-project-discovery.mjs` can run a discovery-only loopback gateway before any native
supervisor exists, then attach the same handler to the combined gateway. Only health
and signed discovery are available in that phase. Body is exactly `{ticket}`; claims
are exactly `iss`, `aud`, `scope: "projects:discover"`, `jti`, `iat`, `exp`, `binding`,
and signed `request: {schemaVersion:1,page,perPage}`. Binding contains coderOrigin,
hiveUserId, ownerId, workspaceId, buildId, agentId, templateId, appOrigin and appId.
All are compared to independent installed configuration. TTL is at most 60 seconds.
A private bounded nonce file with OS process-lifetime locking prevents replay across
restarts. No inherited owner/GitHub/OpenAI token enters the helper; only allowlisted
workspace-agent auth variables survive. The installed helper path and SHA-256 are
pinned, no shell is used, output is capped at 512 KiB and process duration at 8 seconds.
Known helper failures return fixed safe JSON with HTTP 200; capability/pinning/replay
failures return 403. There are no caller-selected executable paths or API URLs.

Current checks:

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:36229/hive_delivery_test pnpm exec vitest run src/__tests__/lib/codex-session/registration-store.integration.test.ts src/__tests__/lib/codex-session/registration.test.ts src/__tests__/lib/codex-session/bootstrap-delivery.test.ts src/__tests__/lib/codex-session/route.test.ts
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-project-supervisor.test.mjs scripts/verify-codex-project-gateway.test.mjs scripts/verify-codex-host-registration.test.mjs scripts/verify-codex-project-discovery.test.mjs
```

Eight real PostgreSQL integration tests cover concurrent single-winner consumption,
generation replacement, history retention, changed Coder owner/build, nonce/sequence
replay, expired leases, owner foreign keys, reusable transaction locking, deterministic
pre-lock seal/consume races and an explicit active subset with more than 32 retained
owner projects. Nine
metadata/authority tests, four private-delivery tests and three route-boundary tests
pass. The explicit native + gateway + host + discovery suite passes 31 tests with
zero skips and no account-backed inference. The database address above is the isolated
local synthetic fixture only, not a deployment database.

Remaining activation work: trusted installed config/provisioner composition, actual
owner-only gateway app provisioning, software wrapper lifecycle, user project enrollment
and UI, browser-cookie/WebSocket validation, and production controller rollout. The
source modules deliberately do not start listeners or install services on import.


### First prompt and installed manager tools

`supervisor.registrationBinding(projectId)` admits only a known, locally created,
loaded thread in the current native lifetime, including `awaitingFirstTurn`. It does
not grant execution or history access. Failed rejoin, unknown projects and previous
lifetimes are rejected. The host can therefore register before the user's first actual
prompt without a dummy seed. Existing `binding()` remains persisted-only for browser
history and CLI attachment. The UI must represent awaiting-first-prompt separately.

Trusted installed composition can pass `managerAdapter` to `openSupervisor` or call
`setManagerAdapter` before creating a thread. Its sole allowed dynamic tool is
`hive_delivery`. Native server requests are distinguished from client response IDs;
only this tool reaches the installed handler, results are bounded plain text, and
approval/user-input requests remain unanswered. Handler calls are checked against the
supervisor's exact known project thread. The host-registration object's local-only
`currentRegistration()` supplies the delivery adapter with registration ID, expiry in
milliseconds and thread associations; no HTTP response exposes the host private key.

Actual installed `codex app-server generate-ts --experimental` confirms the 0.165
`dynamicTools`, `DynamicToolCallParams` and `{contentItems, success}` response shapes.
The separate delivery adapter's explicit native fixture verifies the dynamic tool
round-trip. The supervisor suite checks installed tool injection, distinct request-ID
routing, unknown thread denial and failed-empty-thread-rejoin denial. No account-backed
inference was used by these fixtures.


### Review corrections

Mutable grant digest/consumption fields are re-read after the slot lock is acquired.
The initial lookup locates the slot only. A real PostgreSQL test uses a query-extension
barrier to force two callers to finish their pre-lock reads together; exactly one
seal succeeds, its digest cannot be overwritten, and concurrent consume returns one
`true` and one `false` without relying on a duplicate-insert exception.

The internal provisioner explicitly supplies 1–32 selected project IDs to `issue`.
The database callback checks those exact owned GitHub projects. Redemption and every
heartbeat/read renewal derive the selected IDs from the verified signed/persisted
binding and independently recheck ownership/repository identity. No unsigned host
body selects projects, no all-owner scan is used, and no environment mapping/redeploy
is needed when the project-open controller selects another project. Historical
projects remain stored without consuming the active-host limit.

The installed manager observer receives `{method, params}` for item started/completed
and `rawResponseItem/completed`, with `experimentalRawEvents:true` only on manager
thread creation. The delivery reducer must correlate known parent thread/turn/call,
extract model/effort plus actual child ID, and discard prompt content. Raw notifications
remain outside the browser read projection.

### Lost heartbeat acknowledgement recovery

Additive migration `20261029060000_codex_heartbeat_ack` stores only the latest accepted
heartbeat request digest. After valid host signature, fresh Coder authorization and
locked active-registration checks, an identical current-sequence request returns the
stored expiry, sequence and nonce without writing or extending the lease. An older
sequence, changed nonce/lifetime/request, expired lease or revoked host is denied.
The host retries the same signed body at most once for a transport failure; policy
rejections never retry, and both attempts remain bounded by the previous lease expiry.
The database lost-ack test checks exact expiry/nonce stability, changed-request denial,
older-sequence denial after a newer heartbeat, and revocation. Host tests check identical
retry bytes and the one-retry bound. Current focused checks: nine registration-store
plus nine manager PostgreSQL tests pass; all seven host-registration tests pass.
