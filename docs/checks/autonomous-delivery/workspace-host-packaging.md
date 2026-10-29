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
Current lease TTL is one hour; dirty-safe installed-controller renewal is the next
bounded change, not silently assumed. Manager tools stay disabled until their
signed envelope/server consumes `currentProjectContext(threadId)`:
`{projectId, preparationIntentId, repositoryId, revision, leaseId, leaseGeneration}`.
That context is derived from the host journal, active registered native thread and
verified lease; a model-selected delivery task ID is not the preparation intent.
Trusted delegation/evidence persistence is a further manager activation gate.
