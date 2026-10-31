# Software project host packaging (preview inactive)

The source now composes signed project enrollment, a durable first-task journal,
managed checkout preparation, one native Codex supervisor, registration, read
streaming, and a separately authorized terminal. No template startup was enabled,
no template version activated, and no workspace credentials copied by this slice.

## Installed boundaries

`node scripts/build-codex-host-bundle.mjs /absolute/new/output-directory` builds
only from the installed lockfile. esbuild 0.28.2 bundles ws 8.21.3 locally into
`vendor/ws.mjs`; the first-party modules remain separate so their CLI guards do
not accidentally execute when imported. It copies the reviewed Python helpers
and writes a file-digest manifest. The workspace performs no npm install. A
package import test proves importing the entry point does not start listeners.

`install-codex-runtime.py` downloads only the fixed official npm tarball:
`https://registry.npmjs.org/@openai/codex/-/codex-0.165.0-linux-x64.tgz`.
It checks the embedded SHA-512 integrity before extracting regular vendor files,
rejects links/path escapes/duplicates and oversized archives, preserves failed
stages, and refuses to overwrite an existing runtime. The dedicated tree is:

```text
~/.local/share/hive/codex-runtime/0.165.0-linux-x64-c06a67fd8ac76508/
  vendor/x86_64-unknown-linux-musl/
```

Both the app-server and its tmux CLI use this executable. Its SHA-256 is
`c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`.
The wrapper also pins code-mode-host, bwrap, and rg. Native `--version` and the
app-server initialize response must independently report the supported 0.165
runtime. The protocol remains experimental; this is an explicit compatibility
pin, not a general promise that newer Codex releases work.

Nightly interactive CLI maintenance remains separate. Its only coordinator
exemption uses an embedded reviewed path/hash, kernel `/proc/PID/exe` exact path,
matching device/inode, owner and permission checks, and a digest cache keyed by
inode/size/mtime/ctime. Missing, deleted, replaced, unreadable, symlinked or
hash-mismatched executables remain blocking. Mutable manifests, argv, repository
files and environment values cannot nominate an exempt executable. Ordinary
interactive Codex and Claude processes continue blocking their updater.

## Explicit startup configuration

The installed `codex-workspace-host.mjs` takes no arguments and reads only the
private regular file `~/.config/hive/codex-host.json`. It requires software profile
and Node 24+, verified package assets and the dedicated runtime. The exact schema
is below; values are provisioned independently by the trusted template/control
plane, never copied from a browser ticket, repository, model or app headers:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "profile": "software",
  "binding": {
    "coderOrigin": "https://coder.example.com",
    "hiveUserId": "HIVE_USER_UUID",
    "ownerId": "CODER_OWNER_UUID",
    "workspaceId": "WORKSPACE_UUID",
    "buildId": "CURRENT_BUILD_UUID",
    "agentId": "CONNECTED_AGENT_UUID",
    "templateId": "SOFTWARE_TEMPLATE_UUID",
    "appOrigin": "https://EXACT_PRIVATE_APP_HOST",
    "appId": "PRIVATE_APP_UUID"
  },
  "hiveOrigin": "https://EXACT_HIVE_ORIGIN",
  "issuerPublicKeyPem": "-----BEGIN PUBLIC KEY-----\nDEPLOYMENT_PUBLIC_KEY\n-----END PUBLIC KEY-----\n",
  "issuerKeyId": "DEPLOYMENT_KEY_ID",
  "port": 13341,
  "model": "gpt-6.1-sol",
  "effort": "low",
  "managerEnabled": false
}
```

This sample is intentionally not executable configuration. Coder's private
owner-only subdomain app must point to the configured loopback port. Hive still
independently checks the owner, active build, connected agent, template, exact
private app, project ownership and registration generation before issuing any
capability. Configuration alone cannot register a native thread with Hive.
The wrapper creates no Codex auth, settings, trust entries or skills.

The host starts with signed discovery/enrollment only. Preparing the first task
starts the single supervisor and replaces the same loopback listener with the
registered gateway. Subsequent projects join that supervisor; they do not start
another app-server. A startup or runtime failure does not authorize inference.

## Fixed project operations and journal

All project HTTP operations are POSTs carrying only `{ticket}`. The Ed25519
capability has the existing independently configured nine-field host binding,
exact issuer/audience, one-use nonce and at most 60 seconds lifetime. Supported
path/scope pairs are:

| Path | Scope |
| --- | --- |
| `/projects/discover` | `projects:discover` |
| `/projects/resolve` | `projects:resolve` |
| `/projects/open` | `projects:open` |
| `/projects/tasks/start` | `projects:task:start` |
| `/projects/tasks/status` | `projects:task:read` |

Resolve queries the agent's own GitHub account and stable repository ID, verifies
its credential-free canonical URL, and returns the default branch SHA. Open
repeats that check and enrolls a controller-owned project UUID without a checkout
or native thread. Its reply always includes `currentTaskId`, `nativeThreadId`
and `terminalSessionName`, each nullable. Stable repository identity cannot be
enrolled under two project UUIDs on one host.

Task start accepts only controller-selected repository/account/project/task/request
IDs, SHA, configured model/effort, and actual user text. Text is at most 32768 UTF-8
bytes and rejects ASCII controls except tab, LF and CR. The outer signed body is
bounded to 96 KiB so allowed JSON escaping plus base64 fits. Before any clone,
thread creation or prompt, the host atomically journals the immutable request and
digest in its private HMAC-signed controller state. The journal retains the
original text privately for crash recovery; it is never returned in status.

One writer and one preparation intent per project are supported. Same-intent
retries reuse the journal; changed payloads fail. Preparation uses only the managed
root. A ready owned lease is inspected without requiring clean edits; interrupted
preparation resumes only with its signed matching lease. The managed helper checks
the expected GitHub account with the same agent token before repository lookup and
clone. No caller provides a filesystem path, URL, shell command or credential.

The supervisor records its own single creation intent before native thread/start.
An empty loaded thread is registered but cannot be attached by CLI. After the
control plane independently registers it, the host submits the journaled **actual**
first prompt once and attaches CLI only after native history is persisted. No
seed/dummy prompt exists. Ambiguous first submission is never resent. The host's
five-second installed timer continues pending transitions independently of a
browser. Control-plane registration still requires the durable intent reconciler;
closing the browser is not registration authority.

Read bindings remain independent of checkout leases. Rejoining persisted history
after cleanup does not recreate the checkout. If native resume fails, the host
reports unsupported/blocked state rather than inventing history. Execution,
first-prompt and terminal attachment continue requiring the exact verified lease.

## Terminal and preview relay

The browser uses a separate `session:terminal` ticket. `/terminal` accepts only
first-frame authenticate, input, resize and renewal; it exposes no native RPC.
The host validates the registered exact thread plus signed checkout lease at
authentication, renewal, input and each second. Expiry/revocation closes the PTY.
Input and output, queue depth, frame size, connection count and message rate are
bounded. Only a fixed Python stdlib PTY helper runs; it verifies the private signed
project and supervisor records, exact current lease, and existing exact tmux
session before attaching. No shell or client-selected command is launched.

The private socket is `~/.local/state/hive/codex-project-supervisor/tmux.sock`.
Session names are derived from the verified project ID. Closing the PTY detaches
the client and preserves the tmux session. Native child lifetime still follows the
supervisor's parent-death and registration revocation rules.

Coder's actual app cookie was verified as Secure, HttpOnly, SameSite=Lax. Therefore
workers.dev preview uses the separate same-origin Worker relay, not an assumption
that a cross-site browser WebSocket will send that cookie. Fixed internal exports
exchange only `/session` or `/terminal` app cookies. Those cookies remain request
local and never reach browser JSON, URLs or logs. Owner credentials go only to the
canonical Coder API. Read and terminal grants keep native app audience even when
the presentation URL is `/api/projects/<UUID>/session` or `/terminal` on Hive.

## Evidence and remaining activation gates

On 2026-10-29 at approximately 18:22 UTC:

- `HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-project-supervisor.test.mjs`:
  20 passed, no skips. Installed native 0.165 rejects empty-thread CLI attach;
  actual first text against a **local mock provider** persists and CLI attaches to
  the same thread. SIGKILL stops the native child and permits a fresh lifetime.
  No account-backed inference or additional agent session was used.
- Controller: 7 tests covering no-clone enrollment, registered first prompt once,
  restart reuse, ambiguous prompt, dirty lease reuse, HMAC/OS-lock boundaries,
  strict request limits and trusted preparation context.
- Terminal: 4 tests, including an actual Python PTY attached to an isolated tmux
  fixture. Session survives disconnect; wrong scope, replay, binding changes,
  expiry and lease revocation are rejected.
- Managed lifecycle: 27 tests; GitHub discovery/resolve: 14; updater: 10;
  runtime installer: 3. Package: 2 tests build the local locked artifact and import
  it without starting a listener.

Activation remains disabled pending parent review, trusted per-build template
configuration, inactive preview packaging/test-workspace build and browser relay
validation. Native account login/inference remains a separate explicit gate.
The installed controller now renews the one-hour checkout lease while fewer than
15 minutes remain; the check runs every minute. Manager tools stay disabled until their
signed envelope/server consumes `currentProjectContext(threadId)`:
`{projectId, preparationIntentId, repositoryId, revision, leaseId, leaseGeneration}`.
That context is derived from the host journal, active registered native thread and
verified lease; a model-selected delivery task ID is not the preparation intent.
Trusted delegation/evidence persistence is a further manager activation gate.


### Dirty-safe lease renewal checkpoint (2026-10-29)

The fixed installed `codex-project-lease.py` accepts only a project UUID on stdin.
It verifies the signed controller and supervisor journals, exact task/lease/source/
checkout incarnation, and Linux parent/native PID, kernel start time, boot ID and
executable device/inode identity under the managed checkout lock. It cannot revive
an expired or released lease. The renewal preserves lease ID/generation and dirty,
untracked and ignored work; a monotonic `renewalSequence` invalidates every older
cleanup request and completion authorization. Cleanup remains unavailable in the CLI.
The helper receives no owner, GitHub, agent or OpenAI credential environment.

Every prepared task with a native thread is inspected for expiry regardless of
controller phase, including registration outages and ambiguous-prompt blocks.
Only running/awaiting-first-prompt phases may extend a valid lease; expiry and
provenance failure revoke execution even if the renewal helper is unavailable.

Failure durably fences first input and terminal execution before attempting the
exact active root-turn interrupt and exact private tmux-session termination.
History remains readable, including after controller restart without checkout
recreation. A bounded native loaded-thread inventory must establish idle state;
unmapped active threads or an incomplete inventory retain `reviewRequired`. Known
child interruption/observation routing is a separate pending checkpoint; this
slice does not claim that all delegated work has stopped.

Actual installed 0.165 with the local mock provider revealed a native ephemeral
title-generation thread during the second prompt while CLI was attached. Its
`parentThreadId` was null and it remained active after the root interrupt returned.
The mock received a separate “Generate a concise, single-line task title” request.
The regression preserves the same project thread for CLI/history, proves root
interruption and read-only restart, and requires a review hold for that unmapped
active thread. No account-backed inference was used. The native runtime may perform
its own ancillary inference; one project thread does not imply one provider request.

Private 0600 journals, keys and PID checks are not isolation against hostile code
running under the same Unix UID. Manager activation additionally requires actual
native permissions/sandbox enforcement protecting controller/signing state,
native transport credentials and process credential aliases, or a separate signer
identity. Signed observer payloads alone do not establish independent evidence.

Validation commands for this checkpoint:

- `python3 -m unittest scripts.agents.test_managed_projects scripts.agents.test_codex_project_lease`
- `node --test scripts/verify-codex-host-package.test.mjs scripts/verify-codex-project-controller.test.mjs`
- `HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-project-supervisor.test.mjs`

Scoped canonical JavaScript Biome lint also covers the intentional ASCII-control
validation suppression and terminal output-loop fixes. Template copies and the
artifact manifest are left for the parent’s coordinated sync after review.

Checkpoint results: 33 Python tests and 18 package/controller/terminal tests pass.
The parent reran these against the staged source, excluding concurrent D04 edits.
The complete opt-in installed-native supervisor suite passes, including real local
mock first prompt, CLI attach, interruption and history-only restart. No skip was
used in that native run.

### Explicit pre-execution retry checkpoint

`POST /projects/tasks/retry` requires a separately signed `projects:task:retry`
capability. Its request contains exactly schema version, project ID, task ID and
retry request ID. It cannot replace text, source SHA, model or lease identity.
The controller serializes retry decisions and journals at most 32 accepted retry
receipts per task. A repeated receipt returns current status without another
attempt, including after restart or a lost acknowledgement. An already-running
intent returns status without invoking the runtime. The original first-prompt
request ID and signed intent remain unchanged.

Recovery is limited to the fixed pre-execution reason allowlist, explicit durable
no-prompt/no-creation-attempt flags and managed `not_created`/no-lease state, or
an exact ready/live checkout with independently inspected source, lease and
incarnation plus supervisor proof of a known empty thread. Interrupted clone
stages, changed/expired leases, revoked execution, legacy missing flags and
uncertain creation/input remain held. Creation and first-input attempt flags are
saved before their non-idempotent native calls.

Installed native 0.165 cannot currently satisfy the empty-history proof for a
new loaded thread without a rollout: `thread/turns/list` and
`thread/read {includeTurns:true}` both reject. A metadata-only read returning an
empty `turns` field is deliberately not treated as history evidence. In this
case retry returns the existing readable blocked status and does not schedule
work. The ready/live positive branch is covered by explicit empty-history test
fixtures, not claimed as a real-runtime capability. Normal pending registration
continues under its original intent separately from explicit blocked-task retry.

Validation: controller/discovery suites cover retry scope, immutable input,
concurrent duplicates, lost acknowledgement/restart, replay after a second
failure, changed lease/incarnation, uncertain history, legacy flags and revoked
execution. The opt-in installed-native supervisor test records the unsupported
empty-history proof without account-backed inference.

### Installed native-child routing checkpoint

The supervisor exposes installed-only `registerChild(managerThreadId,
childThreadId, spawnCallId)` and `readNativeHistory({managerThreadId,
childThreadId,spawnCallId})` callbacks. Neither is a browser RPC or HTTP operation.
The mapping is signed in the existing supervisor journal, bounded to 64 children
per project, and pinned to the exact parent and native server lifetime. Conflicting
spawn/child ownership is rejected. Prior-lifetime mappings are not silently
adopted. The trusted observer must derive these identities from actual native
spawn observations; the callback does not itself authenticate model assertions.

Only mapped child `turn/started`, `turn/completed` and `item/completed`
notifications reach the installed observer. Child raw-response/started-item
content and unknown children are not forwarded. Known-child history requires no
execution lease, reads one page of at most 20 turns, bounds response bytes and
preserves `nextCursor` so the observer can retain a partial-history hold.

Execution revocation attempts exact active-turn interruption for the root and
all currently mapped children. A late native-proven child mapping after
revocation queues another interruption pass. Uncertain interruption, unknown
active threads, incomplete inventory or an exhausted inspection deadline retain
review status; other projects and their mapped children remain untouched.
Supervisor shutdown awaits the installed observer's bounded close operation
before releasing the native process and OS lock.

The wrapper supplies these callbacks and the current server instance identity,
but explicitly keeps native evidence ingestion disabled. The stronger producer
isolation gate remains pending. Focused tests cover routing, conflicting IDs,
read-after-lease-loss, partial/stale history, child interruption, delayed mapping,
other-project isolation and awaited shutdown.
