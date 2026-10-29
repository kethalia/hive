# Workspace gateway and registration authority

2026-10-29. Bounded F04 integration; no web route, database adapter, provisioner
activation, template deployment or public listener activation in this slice.

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
`WorkspaceRegistrationAuthority.issue(principal, workspaceId, agentId)` takes a
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

## Proposed additive persistence/API integration (requires root agreement)

No schema or existing-route edits have been made. Delivery schema ownership was
coordinated with `delivery_gate_audit`; its recovery migration is complete.

Proposed tables, using Hive owner UUID foreign keys and composite owner keys:

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
   This method is not implemented in the current authority primitive.

Proposed endpoint separation:

- Internal provisioner grant issuance: workload-authenticated controller only,
  no browser or manager registration shortcut. A deployment-approved secret
  delivery mechanism targets the verified Coder agent/build; select that mechanism
  before implementation. Current owner SSH transport is a development probe,
  not a Cloudflare-native production provisioning solution.
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
and input endpoints remain separate future scopes. Root approval is needed before
editing existing schema/routes; this document is the concrete integration proposal.

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
