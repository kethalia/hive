# Local Codex project supervisor

2026-10-29 — F04/D12 bounded implementation. Source:
`codex-project-supervisor.mjs`; checks:
`scripts/verify-codex-project-supervisor.test.mjs`.

This is an opt-in, local software-workspace process. It does not install a service,
change Codex settings/trust, provision a Coder app, register with Hive, start a
public gateway, or grant a browser input/approval scope. No account-backed model
inference was performed during development. `codex-project-gateway.mjs` now connects
the read bridge through the supervisor's private token-authenticated socket factory,
supporting multiple independently registered project threads in one workspace gateway.
The registration authority primitive is implemented separately; durable persistence,
provisioner delivery and public API activation remain pending.

## Verified bootstrap behavior

The installed native Codex 0.165.0 was tested with a temporary Codex home, no account
credentials, a private tmux socket and a loopback provider. A newly started empty
thread is loaded, but a second `thread/resume` returns `no rollout found`.
`codex resume --remote <endpoint> <same-id>` also fails TUI bootstrap and exits 1.
It does not become a CLI input surface merely because the thread is loaded.

The supported local sequence is therefore:

1. Record one durable project creation intent, then call native `thread/start` once.
2. Retain `awaitingFirstTurn`; do not fabricate a shell seed, prompt or history item.
3. Submit the user's actual first text through the trusted local supervisor's
   `firstPrompt` operation. Journal its request ID and digest before `turn/start`.
4. Verify nonempty native persisted history. Until then retain
   `awaitingPersistence` (or `firstPromptUncertain` after an ambiguous submission).
5. Attach the native CLI in tmux with the exact native thread ID and authenticated
   remote endpoint. Later input and approvals remain in that CLI.

The actual runtime was also exercised against a **local HTTP Responses fixture**:
one first text reached that fixture, its fixed assistant response persisted, the
CLI rendered it, and `thread/loaded/list` contained exactly the original thread ID.
Replaying the first-prompt request caused no second provider request. After closing
the server and removing the fixture checkout, a fresh native server also resumed
the same persisted thread without recreating the directory or invoking the provider.
This validates
protocol/bootstrap behavior, not real account/model access or approval routing.
The native `projectId` request field references Codex's own project registry; it
cannot accept an arbitrary Hive project ID. The supervisor keeps its Hive mapping
in its own signed registry and does not send that field.

Official protocol context: [Codex App Server](https://developers.openai.com/codex/app-server)
documents remote CLI, explicit initialization, thread creation/resumption and real
turn input. WebSocket app-server remains experimental. Installed 0.165.0 generated
schemas and actual runtime tests take precedence over assumptions about newer docs.

## Private configuration and executable pin

The intended installed software-only wrapper invokes:

```sh
node /trusted/versioned/package/codex-project-supervisor.mjs /private/config.json
```

The CLI requires `HIVE_WORKSPACE_PROFILE=software`; configuration must be a regular
owner-owned 0600 file with no symlink components. Profile is also validated inside
the configuration. An installed wrapper/package and independent provisioning of
that configuration are **not yet implemented**. Do not turn this example into a
startup script before the registration/trust review.

Example placeholders (not live authority):

```json
{
  "schemaVersion": 1,
  "profile": "software",
  "ownerId": "trusted-owner-id",
  "workspaceId": "trusted-workspace-id",
  "buildId": "trusted-running-build-id",
  "codexExecutable": "/trusted/versioned/package/native/codex",
  "codexSha256": "<64 lowercase hex characters>",
  "projects": [{
    "projectId": "trusted-hive-project-id",
    "repositoryId": "123",
    "taskId": "trusted-task-id",
    "leaseId": "current-managed-checkout-lease",
    "leaseGeneration": 1,
    "model": "gpt-6.1-sol",
    "effort": "low"
  }]
}
```

The executable must be the native Linux ELF, not the npm JavaScript launcher.
The supervisor checks its exact SHA-256, CLI version and native initialize response
version (0.165.0) before permitting thread operations. A versioned immutable package
is the intended distribution boundary; this prototype is not a sandbox against
same-user replacement of that trusted package between checks and execution.
Unsupported versions fail closed. Node and the repository-pinned `ws` 8.21.3 must be
distributed with the package; there is no runtime package installation. Linux,
Python 3, `/usr/bin/flock` and tmux are required. The native user's existing
`~/.codex` remains outside all removable managed checkouts. No auth files are copied.
Inherited owner/API/Git environment credentials are not forwarded to the child;
real task-tool credential access needs its own reviewed integration.

The fixed managed checkout path is derived from OS account home and repository ID:
`~/projects/.hive-managed/github/<id>/checkout`. Before creation, first input or CLI
attachment, the trusted sibling `managed-projects.py` inspects its signed receipt
and verifies the checkout inode, Git configuration/storage and canonical remote.
The supervisor requires `checkoutVerified: true`, task, lease ID, generation, future
expiry, ready state and exact checkout path. Symlinks/path substitutions fail.
Inspection does not require clean source or reset edits;
an active dirty checkout can resume its existing native session. Expired leases
block execution/attachment; lease renewal/config refresh is not implemented.
Durable conversation read binding, history refresh and explicit history rejoin do
not depend on a live checkout or lease. They still require the registered project,
exact native thread and current live server lifetime. Cleanup cannot erase the
conversation's read authority merely by removing its working directory.
Project IDs and repository IDs must be unique in the maximum-32-project configuration.

## Local command protocol

One JSON command per stdin line, no HTTP/Unix command socket. Input buffering is
capped at 64 KiB, queued commands at 16, text at 32 KiB; only one command runs at a
time. Production home cannot be redirected by a command or environment `HOME`.
Unknown fields, paths, URLs, model overrides, thread IDs and owner claims are denied.
Output is `{ "ok": true, "data": <snapshot> }` or a fixed error code; prompt text,
provider errors, credentials and native history are not printed. Snapshot thread IDs
belong only to configured projects. Imported fixture dependencies are unavailable
through CLI arguments or environment flags.

| Operation | Fields besides `operation` | Semantics |
| --- | --- | --- |
| `inspect` | `projectId` | Local recorded state; no authentication assertion to a remote controller |
| `ensureProject` | `projectId`, `creationIntentId` | One native creation attempt; same intent returns its existing record |
| `firstPrompt` | `projectId`, `requestId`, `text` | Actual first text once; identical replay returns state; changed request/text denied |
| `refresh` | `projectId` | Check persisted native turn history; does not send input |
| `rejoin` | `projectId` | Explicitly resume the recorded persisted thread after a server restart; never fork/start a substitute |
| `attach` | `projectId` | Start/reuse the exact project's native CLI tmux session after persistence is verified |

`attached` records tmux launch/reuse, not proof that a person has opened the pane or
that all possible native approval flows work. The private socket is under the
supervisor state directory; session names derive from a project-ID hash. User tmux
configuration is not loaded for this owned server. No keys are injected into the
TUI. An empty thread lost on restart may have no persistent rollout: rejoin fails
and explicit operator reconciliation is required. A new creation ID cannot silently
replace the existing project record. If native history rejoin fails, the supervisor
records `historyRejoinUnsupported` and grants no binding for the new lifetime; it
does not recreate a checkout or override the recorded cwd. Installed 0.165.0 does
support rejoining the tested persisted conversation with its original cwd absent.

## Durability, process lifetime and revocation

State and an independent HMAC key live in owner-private
`~/.local/state/hive/codex-project-supervisor`. Records bind owner/workspace, latest
build/server lifetime, project/repository, creation intent, native thread, first
prompt request/digest and phase. Atomic record replacement fsyncs the file and parent
directory. Prompt plaintext is held only for the active request, not in the registry.
Native history remains Codex-owned. HMAC protects substituted task data; same-user
code with access to the private key remains a trusted principal.

An OS file-description lock covers the supervisor lifetime. The lock inode is never
unlinked; no PID-based stale-lock deletion exists. The spawned native ELF inherits
the lock descriptor. A Linux parent-death signal kills that exact child if the
supervisor dies, with a parent-PID race check before exec. Tests send SIGKILL to the
supervisor, observe the child stop running and reacquire the released lock. They
also kill during an uncertain creation and prove the restart makes no new attempt.
No persisted PID is used to kill an unknown process.

The native listener binds loopback only, selects a fresh port, and requires a fresh
private capability token before WebSocket initialization. The supervisor retains
its subscribed connection. Native request timeouts are five seconds, pending native
requests are bounded at eight, and incoming frames at 1 MiB. A child exit or native
socket failure immediately revokes all local bindings. Native approval/input
requests are never answered automatically. Startup failure or explicit shutdown
terminates the owned native child and the supervisor's private tmux server.

Every successful new server start rotates `serverInstanceId`. Old bindings cannot
be authorized; project records require explicit same-thread `rejoin`. Ambiguous
native requests are journaled before sending and never automatically retried, even
when a timeout occurred before any effect. This chooses retained/manual recovery
over duplicate threads or inference. A keeper subscription reduces unexpected
unloads; it does not prove an atomic native resume-only-if-loaded primitive.

`binding(projectId)` and `authorizeBinding(candidate)` are internal registry seams:
only registered persisted threads in the live lifetime qualify independently of checkout lease,
and owner/workspace/build/server/thread must match exactly. They support the local
single workspace gateway with a registered thread set; a ticket still names one
exact thread. They are not a registration API, ticket issuer or replacement for
signature/origin/scope verification. No browser sees the native token or endpoint.

## Coder and Cloudflare registration research

Concrete Coder source rules out treating local IDs as authenticated claims:

- [Agent authentication middleware](https://github.com/coder/coder/blob/main/coderd/httpmw/workspaceagent.go)
  parses a Coder agent token, resolves its agent/build against Coder's database,
  checks workspace-owner status and sets a workspace-agent-scoped subject. This is
  not an offline-verifiable JWT or proof obtained from an untrusted JSON manifest.
- [Coder routing](https://github.com/coder/coder/blob/main/coderd/coderd.go) protects
  `/api/v2/workspaceagents/me/rpc` with that middleware.
  [Agent SDK](https://github.com/coder/coder/blob/main/codersdk/agentsdk/agentsdk.go)
  connects through WebSocket plus versioned dRPC; its manifest contains agent ID,
  workspace ID and (on supporting versions) build ID. It is not a verified simple
  REST `/me` identity endpoint.
- [Manifest implementation](https://github.com/coder/coder/blob/main/coderd/agentapi/manifest.go)
  derives metadata server-side and may also deliver secrets in its raw protocol.
  Do not dump a live manifest or send Coder owner/agent tokens to browser code,
  model prompts or logs to implement registration. No live manifest was fetched.
- Coder supports an isolated hostname with `subdomain=true` and `share="owner"`:
  [wildcard app configuration](https://coder.com/docs/admin/networking/wildcard-access-url).
  [Port access documentation](https://coder.com/docs/user-guides/workspace-access/port-forwarding)
  defines app sharing; it is an outer routing gate, not Hive session authority.

Recommended next design (not implemented): a trusted provisioner delivers a
single-use short-lived registration grant to the designated agent/build. Hive
records that grant's independently verified owner/workspace/build/agent binding,
then checks fresh Coder owner/running-build metadata when accepting the supervisor's
key and registry. The grant cannot come from repository content or browser claims.
An alternative direct Coder-token verifier would require a reviewed server-side
Coder identity bridge, not accepting a token as proof without Coder verification.
Do not invent a `/me` REST endpoint or treat an agent-fetched manifest forwarded by
the agent as independently authenticated proof.

Cloudflare can use HTTPS/WebSocket and server-side crypto; existing
`src/lib/coder/client.ts` app auth redirects and
`src/lib/workspaces/app-access.ts` establish a browser's isolated Coder app cookie.
They do not authenticate inbound workspace registration. The future ticket route
must reauthorize owner + current running build + registered live lifetime, then sign
an exact-thread capability. A single private Coder app can host the registered-set
read gateway with exact origin checks; headers forwarded by Coder are not identity
proof. Browser input and approval scopes remain separate, unimplemented authority.
Real Coder cookie/upgrade behavior requires Browser Testing. No live endpoint is
exposed until provisioning/registration authority and bridge integration are reviewed.

## Evidence and remaining gates

```sh
node --test scripts/verify-codex-project-supervisor.test.mjs
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-project-supervisor.test.mjs
```

The second command ran 16 passing tests including three installed-native tests:
empty-thread CLI rejection, actual first text through a local mock provider followed
by same-thread CLI attach, and supervisor SIGKILL/native-child termination. The
remaining tests cover creation/request replay, restart/rejoin, revocation, lock
exclusion, registry tamper, config/version/path/lease denial, expiry, two-project
isolation, provenance-proof denial, read access after checkout absence/lease expiry,
explicit failed history rejoin and exact owner/thread binding. The actual first-text
test includes a fresh-server history rejoin after removing its fixture checkout.
`HIVE_TEST_CODEX_EXECUTABLE` can point the tests to an installed native ELF;
it is a test-runner override, not a production configuration bypass.

Still pending: independent review; installed versioned software wrapper; immutable
native binary distribution; real account first-turn/approval validation; authenticated
registration persistence/provisioner delivery and lease renewal;
actual Coder app transport/browser tests; persistent-volume crash behavior; and
controller revocation/cleanup interlock. This slice does not complete F04/D12 or
activate autonomous production delivery.
