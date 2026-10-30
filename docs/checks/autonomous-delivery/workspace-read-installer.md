# Standalone workspace read installation

`install-workspace-read.py` installs only the independent three-member read
package. Its fixed no-args stdin schema accepts `schemaVersion: 1`, gzip `archive`,
`archiveSha256` (expanded tar), `manifestSha256`, and `config`. Validation of every
request/config/member/hash happens before any subprocess is launched. Gzip input
is limited to 65536 bytes and expanded tar to 131072 bytes. Concatenated/trailing
gzip data, extra/duplicate/link/path-traversal members and non-Ed25519 public keys
are rejected. No credentials or private issuer keys belong in this request.

Packages live under `~/.local/share/hive/workspace-read/<archiveSha256>`, with
private immutable members verified before reuse. The config remains a private
single-link nonsymlink file at `~/.config/hive/workspace-read.json`. Existing
owner-owned nonwritable config parents retain their permissions. A private
installer lock, HMAC-authenticated current process record, append-only history and
logs live in `~/.local/state/hive/workspace-read`. Per-build read nonce state is
preserved. Interrupted staging directories are retained.

The installer pins the root-owned, nonwritable real `/usr/bin/node` executable to
major version 24 and records its hash/device/inode. It records the new PID before
readiness and checks UID, boot ID, process start time, executable/hash, exact argv,
owned loopback listener and health config/manifest/raw-config hashes. It does not
trust a health response from another process or follow a health redirect.

An exact verified already-running request is reused without rewriting its config
or restarting it. A different request against a live service, a changed executable
under the same PID/start time, inaccessible process metadata, or an unknown
listener retains a hold. The installer never kills or adopts a process.

A missing original process, a changed boot ID, or a reused numeric PID with a
*different* start time proves the recorded instance absent. A fresh start is then
permitted only if the fixed port is free; the unrelated reused PID is untouched.
`TIME_WAIT` is handled using normal `SO_REUSEADDR` restart semantics, without
`SO_REUSEPORT`. Failed/uncertain startup retains its attempted process record and
cannot silently retry. Prior records and per-build state remain available.

Run the bounded proof explicitly in the software workspace:

```sh
node scripts/probe-workspace-read-install.mjs
```

The pure suite covers archive/config validation, filesystem protections and
process-identity distinctions. The actual suite starts the real Node CLI inside
a private home and network namespace, verifies reuse/restart/holds, and forces a
real startup failure by retaining the service's exclusive lock. It never binds
the primary network namespace's port 13342 or changes the primary home.

One observation is explicitly synthetic: this unprivileged user namespace maps
the actual root-owned Node inode to UID 65534. The outer test independently checks
real UID 0, inode/device, executable bytes/hash and version, then a **test-only**
entry translates that exact inode's stat UID. Product code, request/config and
environment contain no bypass. Remaining Node/config/package/PID/listener/health
and lifecycle behavior is real. Reboot and reused-PID records are deliberately
re-signed isolated fixture history, not an actual host reboot or modification of
an unrelated process. A subreaper tracks only the fixture's own child processes.

The actual test is opt-in outside this proof runner:
`HIVE_WORKSPACE_READ_INSTALL_NATIVE=1 node --test scripts/verify-workspace-read-install.test.mjs`.
Its namespace capability is not assumed in ordinary CI. Failed fixture homes and
first-failure logs are retained; successful fixtures remove only their temporary
home after their exact owned service processes have exited and been reaped.

Template/package/app integration remains owned by the primary agent. This proof
activates no Coder parameter, workspace, template, Cloudflare resource or existing
application action, and starts no project/native/inference runtime.
