# Generic terminal Workers slice (F07)

This implementation covers ordinary terminal allocation, list, attach/reconnect,
input and resize. It does not enable a deployment flag or change a remote resource.
`HIVE_GENERIC_TERMINAL_ENABLED` defaults off. Node's terminal path is preserved.
The existing managed Codex project/session transport is a separate path.

## Existing contracts reused

`createSessionAction` allocates a validated name; it does not execute SSH or start
a process. It is now an explicitly reviewed portable server action, with a
Cloudflare flag check. Actual creation happens on attach through the existing
fixed `buildPtyUrl` command and Coder reconnecting PTY. List uses the existing
authenticated signed workspace-read service, including its installed identity
and profile pins. No write capability is added to that read service.

The browser keeps its existing `hive-terminal-v1` protocol, input/resize envelopes,
request-bound 30-second Hive terminal ticket and reconnect UUID. The Worker
negotiates only that protocol and never forwards the ticket/cookie upstream. The
private auth binding supplies the current session and owner token. A current
Coder user read plus exact owned workspace/current-build/connected-agent membership
must match before attach, and again every20 seconds with a five-second bound.
Unknown auth, account/origin drift, missing/ambiguous agent or changed build closes
the attachment. Transient authorization unavailability uses recoverable1013; an
expired/revoked session uses4401, owner drift4403 and build/offline drift4404,
so a workspace restart does not incorrectly sign the owner out. Ticket TTL bounds admission; fresh private session checks govern
an already-admitted connection. No database/encryption key belongs to this relay.

The pinned official Coder SDK specifies the reconnecting PTY endpoint and its
binary JSON input/resize protocol. The Worker uses those same semantics and
forces shell output to binary, preventing output from impersonating ready/pong
controls. It does not accept caller commands, paths, Coder origins, clone proofs
or arbitrary upstream URLs. [Coder PTY API source](https://github.com/coder/coder/blob/v2.38.4/codersdk/workspacesdk/workspacesdk.go#L383),
[input protocol](https://github.com/coder/coder/blob/v2.38.4/codersdk/workspacesdk/agentconn.go#L231).

## Lifetimes and budgets

Each attachment lasts at most150 seconds or its earlier session/credential/preview
expiry. The existing browser reconnects using the same reconnect UUID and tmux
`new-session -A`; closing an attachment does not kill the remote shell, tmux or
its programs. A reconnect transition can be visible, and uncertain input is not
automatically repeated. The local provider fixture verifies stable remote identity;
actual Coder/browser continuity remains a separately authorized preview check.

An authorized connection requests the existing one-hour workspace deadline
extension, coalesced to approximately once a minute. The refresh first checks
current ownership. Extension failure does not fabricate healthy status or grant
authority. The API also permits304 when an extension is unnecessary. Connection
length and refresh cadence keep the bounded request count below the Workers Free
per-invocation subrequest allowance; this is not an account-wide billing cap.
[Coder deadline API](https://coder.com/docs/reference/api/workspaces#extend-workspace-deadline-by-id).

Handshake is bounded at10 seconds, private/provider reads at5 seconds, auth replies
at64 KiB and workspace/user replies at1 MiB. Both parallel reads settle before
their authorization lifetime returns. Late ignored-abort upgrade responses are
closed. New service secrets must be explicit binding configuration; no ambient
fallback, owner credential copy, local CLI or SSH is used.

Relay limits are1 MiB per delivered message,4 MiB cumulative per direction,512
messages per second, and four active attachments per isolate. When available,
`bufferedAmount` is an additional guard; it is not assumed present in workerd.
Budget exhaustion closes the attachment for reconnect. The message bound runs
after delivery: Workers buffers incoming frames before dispatch and has its own
32 MiB incoming-message limit. This code does not claim a1 MiB preallocation bound
or a global connection quota. Both peers and listeners are closed on failure;
the reservation remains held while in-flight refresh work drains.
[Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/).

## Dispatch and acceptance limits

The app Worker handles exact `/ws` under the explicit flag and enables the bounded
same-origin ticket route only under that flag. Ticket issuance admits only the
six ordinary terminal selectors; audio, clone/cwd and diagnostic endpoints remain
unsupported in this slice. Rename/kill exports still use SSH, have no live
frontend callers, and remain outside the portable action allowlist. Voice/uploads,
audio, clone mutations and coherent diagnostic/keepalive history remain F07 work.
No native cleanup, source publication or release authority follows from this shell.

The separately requested `/api/projects` dispatch repair allows only GET with both
project-discovery and native-gateway flags. Actual session and strict query
validation still run; methods and missing flags remain closed. It does not enable
opening, task preparation or manager execution.

Local tests cover the ticket/session/provider boundary, owner/build changes,
strict parameters, protocol isolation, resize, budgets, expiry/reconnect and
refresh drainage. Actual local workerd crosses private synthetic auth/Coder
service bindings and real WebSocket upgrades, binary echo/resize, sanitized close,
stable reconnect identity, output budget, expiry and current-session revocation.
No live provider, browser, cloud resource or production activation is represented
by that fixture. Its first run completed all12 checks but a harness assertion
expected11; that result is retained separately. A later proof caught refresh
error classification being flattened after parallel-read drainage; it is also
retained, and the corrected final proof passes all12 checks. Exact final sources/results are
recorded under `generic-terminal-local/`.
