# Security Cloud findings remediation

Source: the CSV export supplied on 2026-10-12, containing 22 diff-scan findings for `kethalia/hive` (7 high, 9 medium, 2 low, 4 informational). All exported statuses are `new`; live Security Cloud queries returned no records in this session. This document tracks repository work, not cloud resolution status.

Initial review base: `eeaaa47`. The reports describe historical revisions, so each finding needs verification against current code and deployment boundaries. “Confirmed” below refers to source inspection, not proof of deployed exploitability.

## First fix

Finding `commit:586a0bdebe348191a71e954ce45e4654`: terminal paste uploads must handle SSH stdin and stderr errors independently of child process errors. Stream failures reject the upload, clear its timeout, and terminate SSH. Error listeners remain installed so late events cannot crash the web process; a later successful close cannot override an earlier failure. Upload file/count limits are unchanged.

Validation: the new real Writable EPIPE regression fails on the original source with an uncaught exception, and passes with the fix. Targeted helper and route tests cover normal uploads, stream failures, late events, startup failure, and transfer timeout.

## Auth-service fix

Finding `commit:b09307b841448191844b374f0398337f`: require a dedicated
`AUTH_SERVICE_SECRET` on all auth-service calls except the exact `GET /health`
probe. The auth service validates configuration before listening and authenticates
requests before routing or reading bodies. The shared web client and terminal
proxy send the credential, refuse missing/malformed configuration, and reject
redirects. The request logger no longer includes raw session IDs.

The existing login and token handler tests now use the production request guard.
Additional HTTP regressions verify that session IDs alone and incorrect service
credentials cannot invoke protected handlers. The deployment charts and Compose
files wire the new credential to all three services. The deployment runbook
describes provisioning the credential and upgrading clients before enforcement.

Helm lint and rendering were run in the reused Infrastructure workspace
`daniel/backup-rollout-verification`; it remains running for its existing task.
The validation's temporary directory was removed and evidence is preserved at
[`auth-service-caller-auth-helm.json`](../checks/security/auth-service-caller-auth-helm.json).
Production secret provisioning and rollout verification remain pending; this
repository fix does not change a live deployment or Security Cloud finding state.

## Workspace app isolation fix

Findings `commit:93258b1bcd6881919b1f2be96204fc98` and
`commit:77d897a572848191b10d536984967ccc`: retire the same-origin workspace
proxy, including direct navigation and script resources. All old proxy methods
return inert `410` JSON without resolving a user/workspace or contacting Coder.
The legacy tool panel now uses authenticated Coder app URLs, and both tool
surfaces deny camera/microphone access. Server actions reject app hosts covered
by Hive's cookies and authentication redirects that change the selected origin.
Normal forms, downloads, clipboard use, pointer lock, and fullscreen remain
available in the app's own origin.

Chrome desktop/mobile checks verify that workspace content cannot read Hive's
DOM/API responses, receive its session cookie, or reuse its microphone grant.
They also cover host-overlap rejection, fullscreen, tab continuity, and inert
legacy navigation/script requests. The app-auth endpoints are simulated; live
Coder app connectivity still requires rollout verification. Evidence is preserved
in [`workspace-app-isolation`](../checks/security/workspace-app-isolation/).

## Session-cookie isolation and fixation fix

Findings `commit:113a7b7e251c81919b7c8f05a3750c13` and
`commit:09602bc411208191a99b3ae90931beab`: production uses
`__Host-hive-session` with Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain.
The cookie signature has a new purpose so an old stolen value cannot be renamed
and replayed. Existing users must sign in once. Web session lookup, the request
proxy, and terminal authentication reject every duplicate of the selected cookie
name, including empty or identical values, before signature verification or
session lookup. Neither browser ordering nor timestamp selects an account.

Old configured/derived cookie domains remain deletion targets on login/logout.
The Cloudflare Worker keeps live cookies host-only; PUBLIC_COOKIE_DOMAIN only
applies to legacy deletion headers. HTTP development keeps the unprefixed cookie
with no Domain/Secure attribute. Public production requires HTTPS and prefix
support; the local production-stage Compose stack permits plaintext only when
both web and terminal URLs use supported loopback authorities. Secure production
cookie attributes remain enabled.

Separate terminal hosts authenticate with 30-second tickets bound to the public
terminal host, a SHA-256 digest of the exact request path/query, and browser origin. Tickets use a
separate HMAC purpose and cannot authenticate Hive web requests. The browser
obtains a fresh ticket from a same-origin, Origin-checked POST for each connection
or status/event request; it sends tickets in a WebSocket subprotocol or HTTP
Authorization header, never in URLs/storage. Proxy HTTP requests omit cookies and
refuse redirects. Authentication still checks the live session/token store, and
existing Coder workspace/agent and clone-proof authorization remains in force.

Deployment must coordinate web/terminal versions and public-origin settings.
Browser boundary evidence is preserved in
[`session-cookie-isolation`](../checks/security/session-cookie-isolation/).
Live rollout and Security Cloud resolution remain pending; see the migration
instructions in [deployment.md](../deployment.md).

## Paste upload resource bounds

Finding `commit:6cc2606c14648191b1013e97870401a4`: terminal paste uploads now
allow 10 files, 10 MiB per file, and 20 MiB total. The authenticated route acquires
admission before body reads: one active request per user and four requests per
web process, with no queue. Excess requests receive `429` and `Retry-After`.
Limits apply independently to each web process/replica.

The raw request has a 21 MiB ceiling including multipart overhead and unused
fields. Streamed bytes are checked before multipart parsing, regardless of an
absent or misleading Content-Length; oversized bodies receive `413`. A fixed
buffer bounds metadata overhead for tiny chunks. A conservative boundary scan
caps all multipart parts (files and unused fields combined) at ten before
`FormData` can allocate entries. Scanning and parsing use the same canonical,
validated boundary, including quoted/duplicate Content-Type parameters. The
client checks the same aggregate file limit before uploading.

Files are read/transferred one at a time, as raw bytes without full-file base64
copies. SSH stderr is drained without retaining its content. Disconnects and a
120-second request budget cancel body reads, Coder agent lookup, and SSH; the
local SSH/Coder process group is killed and its close awaited before admission
is released. Credential-store waits also end on abort. Their underlying Prisma
queries cannot be cancelled, so a separate per-process limit holds one pending
lookup per user and four total until the queries actually settle. Busy lookups
receive `429`/`Retry-After`; late results cannot restart cancelled uploads and
late failures are observed. The workspace command checks the complete file size
before publishing a path and removes partial temporary files on exit.

Regressions cover chunked/forged-length bodies, aggregate boundaries, saturation,
slot release, stalled read cancellation, sequential transfers, and the original
EPIPE failure. Real subprocess checks verify process-group cancellation and
execute the production storage command against binary and truncated payloads.
Review regressions demonstrate that 100,000 empty fields/files below the byte
cap never invoke the parser, and stalled credentials return `504` without
retaining upload admission. Both regressions fail on the original PR commit
`f2377af` and pass with the review fixes.
Live rollout and Security Cloud resolution remain pending.

## Production Coder installation fix

Finding `commit:8896576e73508191aad9981022235120`: the web image no longer
downloads/executes `coder.com/install.sh` before installing the pinned CLI.
It downloads only the Coder 2.33.0 release archive selected by BuildKit's
`TARGETARCH`, checks the repository-pinned SHA-256 before extraction, and runs
`coder version` after installation. Missing and unsupported architectures fail
before any download. A version upgrade must also update the architecture hashes.

Eight install-command/pin regressions run in normal test/coverage CI: both supported
architecture branches, checksum mismatch, download failure, missing/unsupported
architecture, removal of the remote installer, and pins matching the verified
release record. The tests execute the
Dockerfile shell command with isolated paths, download fixtures, and fixture
hashes; failed verification cannot extract or execute the binary.

Both real release archives match the existing repository pins and Coder's
published checksum manifest. Their ELF machine types match amd64 and arm64.
The exact install command was also run against the real verified amd64 archive,
including executable permissions, archive cleanup, and the version smoke check.
Evidence and validation boundaries are preserved in
[`coder-install-artifacts.json`](../checks/security/coder-install-artifacts.json).
No local Docker daemon is available; arm64 runtime execution and full image
builds were not performed locally. Rebuilding/deploying the image and live
Security Cloud resolution remain separate rollout steps.

## Desktop listener isolation fix

Finding `commit:f7118176d1788191a5d41f8e0b9c23e1`: managed desktops now expose
only a loopback WebSocket endpoint through an explicit owner-only Coder app.
The pinned module already requested loopback TCP, but KasmVNC 1.4.0 still opened
wildcard UDP and existing user configuration could widen its listener. A
repository-owned launcher loads an image-built native bind guard only into
Xvnc, preventing all non-loopback IPv4/IPv6 binds. Raw VNC and X11 TCP are
disabled. Other desktop preferences are preserved and desktop applications run
without the guard. Startup checks both guard behavior and the actual owned
socket before reporting readiness; missing/invalid guards fail closed.

Live Chrome checks through the real Coder app confirm anonymous denial, owner
desktop display, keyboard input, and reconnection. Peer connections are refused;
runtime inspection shows only `127.0.0.1:6080` and no backend UDP listener.
Adversarial persisted network settings cannot override the boundary. Native and
template regressions and Terraform validation pass. Evidence is preserved in
[`desktop-listener-isolation`](../checks/security/desktop-listener-isolation/).

Rebuild desktop images and merge the generated image-pin update before updating
desktop templates/restarting workspaces. The new launcher requires the guard
in the image; applying templates against old images leaves the desktop stopped.
The earlier Council finding `commit:09825c4928cc81918315da2d4ff42f68` concerns
retired code absent from this repository. Active profile desktops use the shared
fix, but old Council deployments still need retirement/rollout verification.
No live template rollout or Security Cloud closure is claimed.

## Next slices

1. Provision the auth-service credential and validate its staged rollout in Infrastructure.
2. Verify isolated File Browser/editor/desktop connectivity after the app-origin fix is deployed.
3. Verify the host-only cookie migration and ticket-based terminal/audio/status authentication after coordinated deployment.
4. Review workspace credential scope, desktop listeners, and remaining workspace-image supply-chain artifacts.

Browser execution belongs in `browser-testing`; live infrastructure validation belongs in `infrastructure`. This first slice uses code-level checks in the software workspace.

## Finding inventory

| Finding ID | Severity | Exported title | Repository status / next check |
| --- | --- | --- | --- |
| `commit:93258b1bcd6881919b1f2be96204fc98` | high | Noauth File Browser admin exposed under Hive origin | Repository fix retires the proxy and loads authenticated tools on isolated app hosts; Chrome boundary regressions pass. Live app connectivity verification remains pending. |
| `commit:f7118176d1788191a5d41f8e0b9c23e1` | high | Unauthenticated KasmVNC exposed on workspace network | Repository fix confines managed TCP/UDP binds to loopback behind owner-only Coder apps. Real Chrome/peer/socket checks pass; image/template rollout remains pending. |
| `commit:09825c4928cc81918315da2d4ff42f68` | high | Council KasmVNC listens network-wide with weak/no auth | Council launcher/template is absent from current source. Active profile desktops use the shared isolation fix; retired/live Council deployments still require verification. |
| `commit:edcec789b9f8819194c07cd5157d5c4d` | high | Coder CLI auto-login exposes user Coder tokens to workspace code | Coder-login module still enabled; verify actual token scope before selecting remediation. |
| `commit:b09307b841448191844b374f0398337f` | high | Auth service exposes tokens with only a session ID | Repository fix adds service authentication, updated clients, required secret wiring, and HTTP regressions. Live secret provisioning and staged rollout remain pending. |
| `commit:8896576e73508191aad9981022235120` | high | Unpinned remote installer in production Docker image | Repository fix removes the remote installer and keeps only checksum-pinned release archives. Both real artifact hashes/architectures and the native install command were verified. Live image rollout remains pending. |
| `commit:113a7b7e251c81919b7c8f05a3750c13` | high | Auto-derived cookie Domain broadens session scope | Repository fix removes live Domain scope, changes the signature purpose, and uses a protected production cookie name. One fresh login and coordinated web/terminal rollout are required. |
| `commit:2013bf58f9488191a12419f6eafb5234` | medium | Workspace code can silently activate the browser microphone | Revalidation required: current audio code consumes a recent single-use terminal gesture; arbitrary-process activation still needs adversarial testing. |
| `commit:e172a9d020f081918c97f470636f7440` | medium | Workspace code can activate and read the browser microphone | Same microphone activation boundary as 2013bf58; do not close solely because a gesture gate was added. |
| `commit:77d897a572848191b10d536984967ccc` | medium | Workspace proxy can reuse Hive microphone permissions | Repository fix removes active proxy content and denies microphone/camera in tool frames. Chrome tests confirm Hive's permission is not reusable on the app origin. |
| `commit:cc856e47e0fc8191a6dd335ea8175231` | medium | Agent handoffs can authorize destructive workspace deletion | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:77cecf3dcd488191aa1c6f3960b1e173` | medium | Unverified downloads in published workspace base image | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:beb03b5055a48191b33374352232c78c` | medium | Persistent tmux scrollback can expose terminal secrets | Confirmed persistent pane capture remains enabled; decide on opt-in retention behavior. |
| `commit:09602bc411208191a99b3ae90931beab` | medium | Duplicate session cookies enable session fixation | Repository fix rejects all duplicate selected-name cookies across web/proxy/terminal and ignores legacy names in production. Live migration verification remains pending. |
| `commit:586a0bdebe348191a71e954ce45e4654` | medium | Paste image upload can crash Hive web process | Fixed in this slice; reproduced EPIPE on the baseline and added regression coverage. |
| `commit:6cc2606c14648191b1013e97870401a4` | medium | Paste uploads can exhaust web and SSH resources | Repository fix caps raw bodies before parsing, limits aggregate files/admission per web process, and transfers sequentially with cancellation cleanup. Live rollout verification remains pending. |
| `commit:745807de8770819193d07f503330274f` | low | Untrusted workspace output can poison the local clipboard | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:c3d4f68efe1c8191aa3fc56a2cc1ebbb` | low | Hover focus can leak keystrokes to workspace terminals | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:91db3652bf588191ae50cf242a1db567` | informational | Unpinned Codex updates allow startup-time supply-chain execution | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:66d6747a76288191be7b68df43d8504b` | informational | Prisma baseline blocks Helm upgrades with existing schemas | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:205cc7eee8d48191a9baef63850e08f5` | informational | Unsafe board keys can crash tab keyboard navigation | Selector interpolation remains; regression and safe element lookup pending. |
| `commit:62ec3a2baa848191987856c226e78552` | informational | Manual terminal retry is blocked after final failures | Pending current-source and deployment verification; no remediation or cloud closure claimed. |

Findings must only be closed in Security Cloud after their exact accessible record and remediation evidence have been checked. This slice changes no Cloud finding state.
