# Independent workspace read service

The new `hive-read` boundary supplies fixed read operations for generic terminals
and file links without managed-project enrollment, native Codex startup or an SSH
fallback. It has its own package and process lifecycle. No existing action is
switched to it and `HIVE_WORKSPACE_READ_ENABLED` remains default off.

The server selects a profile from the deployment-owned template-ID map and uses
`resolveVerifiedWorkspaceHost` to verify the current Coder owner UUID, running
build, unique connected agent and exact owner-only subdomain app at loopback
port 13342. It rechecks the full binding after the read. Credentials stay in the
normal backend Coder client; only the canonical short-lived app-scoped cookie
crosses to the app. The new fixed transport export cannot choose another path,
URL, header set or cookie jar.

`POST /workspace/read` accepts only an issuer-signed ticket with exact
owner/workspace/build/agent/template/app/profile identities. An identity request
alone permits a null lifetime. Its signed reply binds the random service lifetime,
response key, expected installed manifest and canonical public config digest.
Every subsequent ticket and response must match that lifetime/key. Nonces are
bounded and durably consumed under an exclusive service lock, including across
service restarts. The response key is not hardware attestation: trust comes from
the freshly verified owner-only Coder app and deployment-approved installation.

The Python helper accepts only these operations:

| Operation | Behavior |
| --- | --- |
| `sessions` | Lists the fixed `web` tmux socket, filters reserved clone sessions, and returns 64 entries per page. A changed inventory invalidates its cursor; more than 1024 sessions is an explicit error. |
| `directory` | Verifies an exact session target and reads its pane current directory. Clone CWD reads remain available; no private managed Codex socket is opened. |
| `paths` | Resolves up to 128 candidates using CWD, fallback and `~/` semantics, then checks regular-file/directory existence within the configured projects root. It returns indices and statuses, never file contents. |

All five known profiles permit session/CWD reads. File existence reads preserve
the catalog's File Browser policy: software, game and electronics permit them;
browser and infrastructure reject the operation explicitly. Unknown templates
require a deployment mapping. The default configured projects root remains
`/home/coder`; it is not restricted to managed project directories.

Outside lexical or real projects-root paths return `outside_supported_root`,
including symlinks escaping that root. Permission failures and unsupported file
kinds return `unavailable`; absent files return `missing`. These distinctions must
survive future UI integration. This is a deliberate bounded support boundary,
not a claim of complete parity with the old shell-based symlink behavior.

The helper never accepts a command, executable, environment, socket or root from
the request. It uses fixed argv with no shell and cannot create, attach, rename,
kill or send input to a session. Test-only constructor dependencies isolate the
`web` socket and listener in temporary directories/ports; installed config has no
such fields. The production service uses only its fixed socket and loopback port.

Request envelopes are limited to 786432 bytes, helper requests to 589824 bytes,
and replies to 131072 bytes. Tmux clients have a two-second deadline and bounded
output; the enclosing helper has a five-second kill/reap bound. HTTP input and
concurrency are bounded. The app-cookie exchange/post/response stream has a
10-second total deadline, finite chunk counts and bounded cancellation. Caller
abort and late identity replies cannot issue a subsequent read.

The independent package contains exactly `manifest.json`,
`hive-workspace-read.mjs`, and `hive-workspace-read.py`. Its manifest is:

```json
{"schemaVersion":1,"files":{"hive-workspace-read.mjs":"<sha256>","hive-workspace-read.py":"<sha256>"}}
```

`manifestSha256` hashes the exact manifest bytes. `archiveSha256` hashes the
expanded tar, following the existing host convention. The private install path is
`~/.local/share/hive/workspace-read/<archiveSha256>`. The service rechecks package
hashes before and after reads and rejects a private issuer key in its public config.

The fixed no-args CLI reads only `~/.config/hive/workspace-read.json`. The exact
config keys are `schemaVersion`, `binding`, `profile`, `projectsRoot`, `home`,
`hiveOrigin`, `issuerKeyId`, `issuerPublicKeyPem`, `packageDirectory`,
`manifestSha256`, `stateDirectory`, and `port`. `binding` contains `coderOrigin`,
`ownerId`, `workspaceId`, `buildId`, `agentId`, `templateId`, `appOrigin`, and `appId`.
The port is 13342 and state path is
`~/.local/state/hive/workspace-read/<buildId>`. Existing owner-owned nonwritable `.config` parents are preserved; only the config
file and service-owned state/package need private permissions. No Hive account
enrollment or Coder credential is stored in this config. The installer must independently pin the
package/config and exact process/listener; `/healthz` alone is not authority.

Run `node scripts/probe-workspace-read.mjs` for the bounded local proof. It records
exact source hashes before/after, runtime identity, test counts and package bounds.
Actual tmux/files, signed local HTTP, app-cookie exchange code and owner/build/app
rechecks are exercised. Coder API/auth responses are explicit fixtures, with no
live account request. All-profile tests use profile configs in the software
workspace; they do not claim installations in all five workspace templates.

Independent installer and template/app wiring, actual Coder app validation,
existing action dispatch, generic terminal writes, browser integration and live
Cloudflare deployment remain separate gates. This proof activates none of them.
