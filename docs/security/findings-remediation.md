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

## Explicit terminal microphone approval

Findings `commit:2013bf58f9488191a12419f6eafb5234` and
`commit:e172a9d020f081918c97f470636f7440`: workspace capture activity now
only requests audio. Hive shows **Enable microphone** inside the requesting
terminal; that action approves one current request in the focused, selected
session. Enter, Compose submission, and touch Enter only prime speaker playback.
The previous 15-second microphone arm is removed. The browser approval gate
applies even when an older or modified relay omits its claim requirement.

An approved call keeps the existing focus-pause behavior. **Stop microphone**
releases tracks and audio resources, cancels pending ownership, and ignores late
permission grants. Capture ending, a failed claim, reconnection, terminal identity
changes, and remounting cannot carry consent into another call. Native/browser
ownership still prevents overlapping views and permission prompts.

Seventy targeted regressions pass. Real Chrome checks cover 13 cases each on
desktop and mobile, including a simulated background capture after `ls`/Enter
with browser microphone permission already granted. Before approval there are
zero permission requests and zero audio frames; approved calls exchange PCM and
Stop ends capture. The adversarial regression fails on `27f7301` by opening
microphone access without approval. Screenshots, counts, logs, and validation
boundaries are preserved in
[`terminal-microphone-consent`](../checks/security/terminal-microphone-consent/).

Approval is for the selected terminal's virtual microphone, not an individual
workspace process: programs with access to that device can read audio while the
call is approved. Deploy the updated web client and refresh existing views;
neither a workspace image upgrade nor terminal proxy change is required for
this browser consent gate. Live deployment verification and Security Cloud
closure remain pending.

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

## Workspace image download verification fix

Finding `commit:77cecf3dcd488191aa1c6f3960b1e173`: notesmd-cli 0.3.4,
act 0.2.74, and KasmVNC 1.4.0 now require repository-pinned SHA-256 checks
before archive extraction or local package installation. Claude's mutable remote
installer is replaced by the Claude Code 2.1.296 native linux-x64 binary,
verified before installation into its standard per-user versions directory and
launcher symlink. Builds no longer fetch a mutable release channel or execute a
remote installer. Updating these versions requires updating their hashes.

Offline regressions execute the Dockerfile's actual install commands in isolated
paths. Valid fixtures install successfully; corrupted artifacts and download
failures cannot reach extraction or artifact installation. KasmVNC verification
runs in all three desktop branches, and CLI/infrastructure branches never
download it. CI smoke checks require the pinned CLI versions in all five images.

All four actual amd64 artifacts match vendor checksum records. Claude's manifest
signature was verified against the signing-key fingerprint documented by
Anthropic. The three CLI binaries report the expected versions; the KasmVNC
package metadata matches its pinned release. Evidence is preserved in
[`workspace-image-artifacts.json`](../checks/security/workspace-image-artifacts.json).
Workspace runtime self-updates and startup tool installation remain separate
from this image-build fix. Existing persistent homes retain their installed
Claude versions; image rebuilding, digest rollout, and Security Cloud closure
remain pending.

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

The template bundles the same reviewed native guard source as the image. When
an older pinned desktop image lacks the library, its existing compiler builds
the guard in a private temporary directory, and startup verifies it before
launching Xvnc. Templates therefore remain deployable with the checked-in image
pins. Rebuilt images supply the prebuilt guard; no external download or insecure
fallback is used. Forced retirement waits for process exit and cleans only
owned stale display artifacts, preserving live or unrelated displays.
The earlier Council finding `commit:09825c4928cc81918315da2d4ff42f68` concerns
retired code absent from this repository. Active profile desktops use the shared
fix, but old Council deployments still need retirement/rollout verification.
No live template rollout or Security Cloud closure is claimed.

## Specialist Coder credential boundary

Finding `commit:edcec789b9f8819194c07cd5157d5c4d`: automatic owner-level Coder
CLI login is now gated to the persistent `software` profile (`ai-dev-k8s`).
The Browser, Game, Electronics, and Infrastructure profiles use their existing
agent credential for workspace-local operations and GitHub external auth.

Specialist pod entrypoints clear inherited `CODER_SESSION_TOKEN` and remove
this deployment's persisted Coder CLI session before launching the agent. This
runs before all agent startup scripts and terminals, rather than racing with
repository bootstrap. Default, XDG, and custom config roots inside the private
workspace home are covered. Other deployment logins and non-auth settings are
preserved. Shared/symlinked credentials and unsafe or ambiguous paths stop
startup without deleting their targets or logging secrets. The primary
pod command and owner-login module retain their existing behavior.

Live credential metadata confirmed `coder:all` with unrestricted resources.
On a disposable Infrastructure workspace, cleanup removed the persisted owner
login and blocked workspace management, while agent-based GitHub authentication
continued to work. The primary credential was unchanged and its management
commands remained available. Profile regressions and Terraform checks are
preserved in [`coder-credential-boundary`](../checks/security/coder-credential-boundary/).

Apply updated templates and restart specialist workspaces to clear old processes
and run the pre-agent migration. Local file removal does not revoke previously
copied tokens; review/revoke exposed credentials separately with exact key IDs.
No production template rollout or Security Cloud closure is claimed. Owner-token
access within the primary software workspace is a deliberate retained capability,
so processes in that workspace remain trusted with orchestration authority.

## Remove tmux snapshots and command restoration

Finding `commit:beb03b5055a48191b33374352232c78c`: workspace images no
longer bundle tmux-resurrect/tmux-continuum or enable pane capture, periodic saves,
or restoration. The Coder registry tmux module was a second installer and restore
path: it is replaced by a plain attach-or-create Coder app, with a Terraform
`moved` block retaining the existing app identity.

Before startup completes, a one-time migration archives only the unmodified
module-generated `.tmux.conf`, recognized by its normalized content hash. The
backup is owner-only. Custom configurations, linked files, plugin caches, and
previously saved pane output remain preserved. Existing custom plugin settings
need owner review; no live snapshot cleanup or cloud closure is claimed.

Real tmux checks retain the same server, pane process, live history, and F12 menu
across two attach/detach cycles with no snapshot hooks. Image smoke checks run
that probe in every variant and reject bundled plugin directories. Migration
regressions cover repeat startup, configured intervals, personal files, links,
and existing snapshots. Infrastructure validation covers all five templates,
including mocked running/stopped plans and a successful migration of a fresh
workspace's actual module-generated configuration. Evidence is preserved in
[`tmux-snapshot-removal`](../checks/security/tmux-snapshot-removal/).

Deploy updated templates and workspace image digests before restarting affected
workspaces. Running servers retain loaded hooks until they exit. See
[tmux session lifetime](../terminal/tmux-sessions.md) for the restart behavior and
legacy-data boundary.

## Selection gestures and terminal clipboard writes

Finding `commit:745807de8770819193d07f503330274f`: unsolicited OSC 52 requests
now require an explicit Copy action. Automatic copying is limited to one reply
from the same terminal within three seconds of releasing a deliberate mouse or
held touch selection. New pointer activity, blur, resize, disposal, and inactive
panes cancel pending access. Clipboard reads still return empty data.

Mobile held touch drags now use tmux's mouse selection, with native selection
handles suppressed. A deferred ClipboardItem starts the write during release so
tmux can return its text asynchronously. Browser denial falls back to Copy.
Real tmux/Chrome regressions check exact single-line and multiline copied text,
desktop copying, cancellation, links, separate panes, and unsolicited output.
The workspace controls response content; this does not authenticate its contents
or prove that a response during an approved selection matches the highlighted
range. Web rollout, physical Safari verification, and Cloud review remain pending.
See [touch selection](../terminal/touch-selection.md).

## Specialist handoff cleanup authorization

Finding `commit:cc856e47e0fc8191a6dd335ea8175231`: the shared routing contract
requires the primary workspace to record identity and disposition from its own
creation or reuse action before a specialist handoff. Records include Coder
deployment, workspace/owner/template UUIDs, creation time, and task identity.
Specialist claims, returned artifacts, and suggested commands cannot create or
overwrite that primary record or reclassify a workspace as disposable.

Before each stop or delete, fresh Coder metadata must match the primary record
and the operation must target the verified UUID. Missing or mismatched evidence
causes retention. The primary also checks task completion, preserved results,
and other active work. Automatic cleanup remains authorized for verified
task-created disposables; reused, persistent, primary, and unrelated workspaces
retain their existing protections.

Contract checks cover the required provenance, authority, identity checks, and
retention rules, and verify that all five profiles ship the same instructions.
This is a procedural safeguard for the trusted primary agent, not a Coder API
authorization mechanism or proof that a compromised agent cannot delete data.
No live workspace was stopped or deleted for this change. Template rollout,
managed-context refresh, and Security Cloud review remain pending.

## Explicit terminal retry after final failures

Finding `commit:62ec3a2baa848191987856c226e78552`: the Retry terminal connection
button can start a fresh attempt after a final authentication, permission,
clone-proof, or clean terminal-close failure. A final failure still stops scheduled
reconnects and browser foreground/online recovery; only explicit Retry opts into
a new attempt. Existing URL refresh and connection authorization run again,
including fetching a new terminal ticket when configured. Repeated clicks during
an in-flight attempt cannot create duplicate connections. Another final rejection
stops recovery again.

Five regressions fail against the original guard and pass with the fix, covering
fresh authorization, URL refresh, automatic-recovery suppression, duplicate
clicks, successful reconnection, and repeated final rejection. Existing hook and
terminal integration checks also pass. Live rollout and Security Cloud closure
remain pending.

## Safe workspace-board keyboard navigation

Finding `commit:205cc7eee8d48191a9baef63850e08f5`: workspace-tab navigation
uses a fixed tab selector followed by an exact identifier comparison. Stored
board keys are no longer interpreted as CSS, so quotes, backslashes, newlines,
and selector fragments cannot break the lookup or redirect focus to another tab.
Arrow keys, Home, and End retain their selection and focus behavior. Existing
keys are preserved without a storage migration.

Sixteen regression cases cover four unusual keys across all four navigation
keys; fourteen fail against the original lookup. Existing component and board
state/integration checks also pass. This repository fix does not change Security
Cloud finding state.

## Accepted focus-follows-mouse behavior

Finding `commit:c3d4f68efe1c8191aa3fc56a2cc1ebbb`: on 2026-10-14, the owner
explicitly confirmed that pointer movement should redirect terminal typing.
Desktop focus-follows-mouse is intentional and will be retained. Moving across
a terminal pane selects its session and focuses its xterm input; a separate click
is not required. See the pane mouse-move handler and `selectSession` in
[`MultiSessionWorkspace.tsx`](../../src/components/workspaces/MultiSessionWorkspace.tsx).

The accepted tradeoff is that an accidental pointer crossing while typing can
send commands or sensitive text to a different workspace terminal. This decision
accepts that interaction, rather than treating pointer-driven focus itself as a
bug. It does not accept hidden or inactive panes receiving input or focus being
stolen from dialogs or other text fields; those boundaries still require separate
verification. No behavior change, new browser validation, or Security Cloud
resolution is claimed by this documentation update.

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
| `commit:edcec789b9f8819194c07cd5157d5c4d` | high | Coder CLI auto-login exposes user Coder tokens to workspace code | Owner login is limited to the primary software profile by design; specialist pre-agent migration clears this deployment’s inherited/stored owner credentials. Live management/GitHub checks pass; production rollout and any exposed-token revocation remain pending. |
| `commit:b09307b841448191844b374f0398337f` | high | Auth service exposes tokens with only a session ID | Repository fix adds service authentication, updated clients, required secret wiring, and HTTP regressions. Live secret provisioning and staged rollout remain pending. |
| `commit:8896576e73508191aad9981022235120` | high | Unpinned remote installer in production Docker image | Repository fix removes the remote installer and keeps only checksum-pinned release archives. Both real artifact hashes/architectures and the native install command were verified. Live image rollout remains pending. |
| `commit:113a7b7e251c81919b7c8f05a3750c13` | high | Auto-derived cookie Domain broadens session scope | Repository fix removes live Domain scope, changes the signature purpose, and uses a protected production cookie name. One fresh login and coordinated web/terminal rollout are required. |
| `commit:2013bf58f9488191a12419f6eafb5234` | medium | Workspace code can silently activate the browser microphone | Repository fix requires explicit approval for each pending terminal microphone request; ordinary Enter cannot grant consent. Web deployment/refresh and cloud closure remain pending. |
| `commit:e172a9d020f081918c97f470636f7440` | medium | Workspace code can activate and read the browser microphone | Same explicit browser approval fix as 2013bf58. Approved audio is available to programs sharing that terminal's virtual microphone; live rollout/cloud closure remain pending. |
| `commit:77d897a572848191b10d536984967ccc` | medium | Workspace proxy can reuse Hive microphone permissions | Repository fix removes active proxy content and denies microphone/camera in tool frames. Chrome tests confirm Hive's permission is not reusable on the app origin. |
| `commit:cc856e47e0fc8191a6dd335ea8175231` | medium | Agent handoffs can authorize destructive workspace deletion | Shared instructions require primary-owned provenance, fresh identity checks, and verified UUID targets; handoffs cannot grant deletion authority. Contract checks cover all profiles. This is procedural guidance; rollout and Cloud review remain pending. |
| `commit:77cecf3dcd488191aa1c6f3960b1e173` | medium | Unverified downloads in published workspace base image | Repository fix adds checksum gates and pins the native Claude release. Image rebuild/digest rollout and cloud closure remain pending. |
| `commit:beb03b5055a48191b33374352232c78c` | medium | Persistent tmux scrollback can expose terminal secrets | Repository fix removes both image plugins and the startup installer/restore path; exact generated home configs are archived. Template/image rollout, custom-config review, historical-data cleanup, and cloud closure remain pending. |
| `commit:09602bc411208191a99b3ae90931beab` | medium | Duplicate session cookies enable session fixation | Repository fix rejects all duplicate selected-name cookies across web/proxy/terminal and ignores legacy names in production. Live migration verification remains pending. |
| `commit:586a0bdebe348191a71e954ce45e4654` | medium | Paste image upload can crash Hive web process | Fixed in this slice; reproduced EPIPE on the baseline and added regression coverage. |
| `commit:6cc2606c14648191b1013e97870401a4` | medium | Paste uploads can exhaust web and SSH resources | Repository fix caps raw bodies before parsing, limits aggregate files/admission per web process, and transfers sequentially with cancellation cleanup. Live rollout verification remains pending. |
| `commit:745807de8770819193d07f503330274f` | low | Untrusted workspace output can poison the local clipboard | Automatic writes require a selection release; other requests offer Copy. Real tmux/Chrome checks pass. Response content remains workspace-controlled; web/device verification and Cloud review remain pending. |
| `commit:c3d4f68efe1c8191aa3fc56a2cc1ebbb` | low | Hover focus can leak keystrokes to workspace terminals | Owner accepted focus-follows-mouse on 2026-10-14, including accidental pointer crossing redirecting typing. Preserve the behavior; hidden/inactive-pane and dialog/text-field boundaries require separate verification. No Cloud closure claimed. |
| `commit:91db3652bf588191ae50cf242a1db567` | informational | Unpinned Codex updates allow startup-time supply-chain execution | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:66d6747a76288191be7b68df43d8504b` | informational | Prisma baseline blocks Helm upgrades with existing schemas | Pending current-source and deployment verification; no remediation or cloud closure claimed. |
| `commit:205cc7eee8d48191a9baef63850e08f5` | informational | Unsafe board keys can crash tab keyboard navigation | Repository fix uses a fixed selector and exact identifier comparison. Unusual-key regressions cover arrows, Home, and End; deployment verification and Cloud closure remain pending. |
| `commit:62ec3a2baa848191987856c226e78552` | informational | Manual terminal retry is blocked after final failures | Repository fix lets explicit Retry start a fresh authorized attempt. Final failures still stop scheduled/lifecycle retries; regression coverage passes. Live rollout and Cloud closure remain pending. |

Findings must only be closed in Security Cloud after their exact accessible record and remediation evidence have been checked. This slice changes no Cloud finding state.
