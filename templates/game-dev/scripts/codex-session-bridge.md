# Codex session read bridge prototype

This is an opt-in capability spike for Codex **0.165.0**, not an activated workspace
service. No `main.tf`, startup, Coder app, secret distribution, or ticket issuer is
installed by these files. It connects to an already-running loopback app-server;
it never launches Codex, starts a thread/turn, or provides input/approval APIs.

## Trust boundary and configuration

The proposed Coder app is an isolated subdomain app with `share = "owner"` and a
loopback target. That is an outer access boundary, not an identity header trusted
by this bridge. Coder describes workspace app access for shared users in its
[sharing documentation](https://coder.com/docs/user-guides/shared-workspaces).
Therefore the bridge independently requires a signed Hive capability. A forged
`X-Coder-User`, app cookie, `Origin`, or thread ID alone does not authenticate.

The future Hive issuer must use the current workspace ownership/running-build and
connected-agent checks in `src/lib/agents/workspace.ts`, authorize the stored
project/thread association, and derive the app origin server-side. Follow
`getIsolatedWorkspaceAppAuthRedirect` for Coder app-cookie setup. Never give the
workspace a copied owner Coder credential or signing private key. Coder app
provisioning, browser-cookie behavior, actual cross-origin WebSocket upgrades,
revocation, and issuer deployment remain unverified integration work.

The host supervisor must independently provision this private configuration file
(owner-only mode 0600), a private state directory (0700), and a pinned Ed25519
**public** key. These are not values accepted from browser claims or repository
handoffs. Example placeholders, not deployment configuration:

```json
{
  "schemaVersion": 1,
  "protocolVersion": "0.165.0",
  "binding": {
    "ownerId": "trusted-owner-id",
    "workspaceId": "trusted-workspace-id",
    "buildId": "trusted-build-id",
    "serverInstanceId": "trusted-native-server-lifetime-id",
    "threadId": "trusted-existing-thread-id"
  },
  "hiveOrigin": "https://hive.example.com",
  "appOrigin": "https://codex-session--main--workspace--owner.coder.example.com",
  "nativeUrl": "ws://127.0.0.1:4500",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "keyId": "hive-session-key-1",
  "stateDirectory": "/home/coder/.local/state/hive/codex-session/example",
  "port": 13341
}
```

This initial bridge serves exactly one configured thread per instance. It retains
the configuration externally rather than accepting an arbitrary native URL,
rollout path, or conversation from web input. The supervisor must preserve the
native Codex home outside removable checkouts, persist the project/thread/native
server association, and rotate `serverInstanceId` when the native server changes.
The native protocol does not return a cryptographic server-lifetime identity;
that binding is a supervisor responsibility, not a guarantee provided by this file.

The runtime needs Linux, the installed util-linux `/usr/bin/flock`, Node, and `ws`
**8.21.3**, currently resolved by this repository's
`pnpm-lock.yaml`. In the checkout, normal repository dependency installation
provides it. A distributed workspace artifact must include this script and its
locked `ws` dependency in a directory where Node ESM resolution can find it.
Copying only the script to `~/.local/bin` is insufficient. This prototype performs
no package installation and does not modify user Codex configuration.

```sh
node templates/ai-dev-k8s/scripts/codex-session-bridge.mjs /absolute/private/config.json
```

The bridge listens only on `127.0.0.1`. `/healthz` reports process health without
conversation data; it does not prove native session availability. `/session`
requires the exact configured `Origin` and app `Host` on its WebSocket upgrade.
No query parameters are accepted. Real Coder proxy forwarding must be tested;
do not loosen Host/Origin validation to make an unverified deployment work.

## Capability and wire protocol

Send the first WebSocket message within five seconds:

```json
{ "type": "authenticate", "ticket": "<signed compact JWT>" }
```

The protected header must contain only `alg: "EdDSA"`, `typ: "JWT"`, and the exact
configured `kid`. The claims must contain only:

| Claim | Required value |
| --- | --- |
| `iss`, `origin` | Exact configured Hive origin |
| `aud` | Exact configured Coder app origin |
| `sub` | Independently configured owner ID |
| `workspaceId`, `buildId`, `serverInstanceId`, `threadId` | Exact host configuration binding |
| `scope` | `session:read` |
| `iat`, `exp` | Integer Unix seconds; not future-issued, unexpired, positive lifetime at most 60 seconds |
| `jti` | Unique nonce, 16–200 allowed identifier characters |

No ticket is accepted from a URL, cookie, forwarded identity header, or Coder
owner credential. No alternate algorithm or dynamically downloaded key is used.
The private signing key belongs exclusively in the control plane. Accepted nonces
are persisted before opening the native connection and replay remains rejected
after a bridge restart. Expired nonces are pruned; a full 4096-entry cache rejects
new authentication. A private OS lock permits one verifier per binding/state
directory. Node opens an owner-only lock file without following symlinks and passes
the retained file descriptor as fd 3 to `/usr/bin/flock --exclusive --nonblock 3`.
The helper exits after acquisition; Node's shared open file description retains
the kernel lock until its descriptor closes, including on abrupt process death.
These are Linux [flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html),
also exercised by the local regression test. The lock inode is never deleted or
replaced, and no PID-based stale-lock judgment occurs. Replay state is read only
after acquisition. Missing locking support or invalid private paths fail startup;
deployment must validate the actual persistent filesystem's locking behavior.

The socket closes at ticket expiry, and each incoming authenticated message checks
expiry again. Before expiry, send `{type:"renew",ticket:"<fresh ticket>"}` to retain
the same socket and native connection. The same signature, binding, origin, scope,
TTL, and replay checks apply, and the new expiry must extend the current deadline.
The response is `{type:"renewed",expiresAt:<Unix seconds>}` or
`{type:"renewalRejected"}`. Rejection leaves the old deadline intact. The control
plane must freshly reauthorize every renewal (for example, around 45 seconds);
cached authorization must not mint an indefinite sequence of tickets. Revocation
enforcement is bounded by the remaining ticket lifetime, not immediate; immediate
revocation needs an additional mechanism before stronger promises are made.

After verifying the native initialization reports exactly 0.165.0, the bridge sends
`{type:"authenticated", protocolVersion:"0.165.0", binding:...}`. The client then
uses the adapter's ordinary `initialize`, `initialized`, `thread/resume`, and
`thread/turns/list` messages. The supported RPC subset is deliberately smaller than
the native protocol:

Native notifications are discarded until version validation and authentication
acknowledgement are complete. Subscription and history hydration occur afterward,
so an unsupported native server cannot leak early conversation events and the
normal snapshot/live reconciliation remains available.

- `initialize`: client metadata only; the bridge initializes its own native
  connection and returns sanitized version/platform metadata.
- `initialized`: exactly once after the client initialize response.
- `thread/resume`: exact configured thread ID plus `excludeTurns: true`. No
  model, path, history, permissions, or instruction overrides.
- `thread/turns/list`: exact configured thread, full items, `asc`/`desc`, limit
  1–100, and an optional bounded opaque cursor; only after successful subscription.

The bridge checks `thread/loaded/list` before forwarding resume and refuses a
known-unloaded thread. **That check and resume are not atomic.** Codex 0.165.0 has
no verified resume-only-if-loaded option; an unload between calls can reconstruct
the same persisted thread. It does not fork or initiate inference, but a strict
never-reconstruct guarantee requires a host lifecycle lease/keeper or a native
atomic primitive. This is a remaining activation gate, not a silent fallback.

All writes, shell commands, process APIs, account APIs, configuration changes,
unknown RPCs, arbitrary thread enumeration, and client responses to native
approval requests are rejected. Native server requests produce only an
`hive/session/actionRequired` notice, with no sensitive request payload; approval
and input must remain in the native CLI. Actual multiple-client approval routing
still requires validation before enabling an unattended workflow.

Only configured-thread turn/item lifecycle and text/command deltas, plus selected
history invalidations, are forwarded. History and item payloads are projected to
supported display fields. Hidden reasoning and unknown tool payloads become
identity-only placeholders. The bridge writes no transcript or model output log.

Limits: 16 client sockets, 1 MiB frames/results, 2 MiB outbound buffered data, eight
in-flight RPCs, 256 unique request IDs per connection, a 32-message burst with
16/second replenishment, five-second native requests, no compression, and no native
redirect following. Duplicate IDs, malformed messages, oversized traffic, and
unsupported versions fail visibly. This is bounded protection, not a general
multi-tenant service isolation boundary against processes running as the owner.

## Validation

```sh
node --test scripts/verify-codex-session-bridge.test.mjs
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-session-bridge.test.mjs
```

2026-10-29: all **15** checks passed with the native opt-in. Fourteen use a local mock
native transport and freshly generated test keys, including rejection of early
events from an unsupported server and SIGKILL recovery without replay acceptance.
The fifteenth starts an isolated
real Codex 0.165.0 app-server and tmux CLI, authenticates a signed-capability Node
client through this bridge, executes two fixed no-inference shell turns through
the test's separate native owner connection, verifies history/live output in both
views, and asserts exactly one native thread is loaded. Test credentials and
temporary native storage are removed afterward. No existing conversation or
account authentication is inspected.

The native check is skipped by default so CI without Codex/tmux does not silently
download or launch those tools. It is a protocol/terminal check, not a real browser
or Coder app deployment. Browser acceptance belongs in `browser-testing` after
the issuer, supervised native runtime, private Coder app, and distribution artifact
are wired and independently reviewed.
