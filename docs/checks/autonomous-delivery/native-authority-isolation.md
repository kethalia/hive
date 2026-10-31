# Native authority isolation gate

Status: the isolated local fixture passes on pinned Codex 0.165.0. The production
host launcher is unchanged and native evidence ingestion remains disabled.
Quiescence remains a separate unresolved gate.

## Official contract and local prerequisites

The [official permissions documentation](https://learn.chatgpt.com/docs/permissions)
describes named filesystem/network profiles, exact deny paths, and Linux
bubblewrap/seccomp enforcement. These profiles govern local commands; MCP,
connectors and other execution surfaces need separate controls. A default profile
alone is not enforced policy. The
[managed configuration documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration#control-available-permission-profiles)
defines administrator-owned profile allowlists and global deny-read requirements.
On Unix the system requirements source is `/etc/codex/requirements.toml`, separate
from user `CODEX_HOME`.

Hive already has the narrow `hive-codex-v1` AppArmor prerequisite and validated
node selector documented in [the sandbox rollout](../../codex-restricted-sandbox.md).
The existing isolated readiness diagnostic passed on the primary software
workspace with native 0.165.0, all five host capability masks zero and
`NoNewPrivs: 1`. An initial command using ambient default configuration failed a
broad root mount; that failure did not establish a platform-wide sandbox outage.
No Kubernetes, AppArmor, system config or primary-session settings were changed.

## Runnable proof and observed results

Run from the repository with the pinned native distribution installed:

```sh
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-authority-isolation.mjs
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-authority-isolation.mjs --profile-only-control
```

The first command must exit zero. The second is an intentional failing control
and must exit two. It demonstrates why a profile allowlist by itself is not the
complete native policy. Neither command uses account credentials or an external
model provider. All model replies and delegation are supplied by a loopback mock;
all protected files and malicious configuration are synthetic temporary fixtures.
The probe caps provider requests, RPC duration and command output, shuts down its
private runtime, and removes only its own temporary tree.

Evidence: [hardened fixture](native-authority-isolation.json),
[profile-only failing control](native-authority-profile-only.json), and
[existing readiness diagnostic](native-authority-readiness.json).
The native ELF digest is
`c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`.

The fixture mounts its own managed requirements at `/etc/codex` in a temporary
bubblewrap user/mount namespace. It uses a separate native home and permits only
minimal runtime files, the exact native ELF, and its fixture workspace. Protected
fixture directories, native configuration, `/proc` and managed requirements are
denied. A live local listener supplies the command-network positive control.
The actual native root turn, resumed root turn and spawned child each execute
commands successfully: workspace reads/writes succeed; protected reads/writes,
symlink escape, native `/proc/root` and environment aliases, and network access
fail. Parent process root/FD/environment aliases are also denied, with the outer
user namespace providing an additional boundary for those parent accesses.

A configured untrusted MCP process that would write a synthetic marker never
runs. Approval escalation produces a native tool rejection. A prohibited named
profile at thread start/resume falls back to the managed profile; a prohibited
turn override is rejected. Redefining the managed profile in ordinary config is
rejected. Results are checked from native command items and effective profiles,
not from the model's final text or a command exit code alone.

The failing control found a concrete 0.165 behavior: with only
`allowed_permission_profiles`, native `command/exec` accepted legacy
`sandboxPolicy: {type: "dangerFullAccess"}` and read/wrote synthetic protected
files. The hardened requirements additionally set
`allowed_sandbox_modes = ["read-only", "workspace-write"]` and exact global
`[permissions.filesystem].deny_read` entries. The legacy command override is then
rejected. Omitting `read-only` from that legacy allowlist causes native startup
validation to fail for permission profiles. Hive's web gateway exposes neither
`command/exec` nor arbitrary profile/config changes, but that gateway restriction
does not replace the native policy requirement.

## Production launcher proposal — not activated

1. Install a versioned, hashed native namespace launcher alongside the pinned
   bundle. Generate managed requirements from trusted installation identities
   and paths. Mount that file read-only as `/etc/codex/requirements.toml` only in
   the dedicated native process namespace; do not alter the interactive CLI's
   global policy or user settings.
2. Use a dedicated persistent native `CODEX_HOME`, separate from controller,
   registration and signing state. Bind only required runtime files, native
   history/auth state and the managed project storage into the namespace.
   Do not mount controller signing directories. Expose the native WebSocket
   token as an exact read-only file needed by the app server, and deny its path
   and aliases to every command. Do not inherit owner, GitHub or agent credentials.
3. Pin the managed default and sole selectable named profile, both legacy
   sandbox modes above, `approval_policy = never`, exact global deny-read paths,
   and an empty MCP allowlist. Disable unneeded apps/plugins/hooks/web access.
   The profile grants minimal execution paths and dynamic native workspace roots;
   repo/user/turn settings cannot redefine it. Require effective managed-policy
   verification during startup and validate every start/resume response.
4. Attest the **specific** host → pinned bubblewrap → pinned native executable
   chain. The proof observes native as the wrapper's direct child, not the host's
   direct child. Record each PID, kernel start time, boot ID, executable inode and
   digest, and verify both exact parent edges before renewal. Keep the existing
   direct-parent path as a separately defined mode; never replace it with a broad
   descendant search. Reject missing/extra/unverifiable process identities.
5. Preserve OS locks and native lifetime revocation through the wrapper. Verify
   parent-death and abrupt-wrapper-death behavior, same-thread CLI/history,
   lease-helper identity checks, pinned package replay and actual installed
   template configuration before enabling native production evidence.

The proof uses the native stdio protocol. Actual production WebSocket-token
placement, same-thread CLI attachment and installed-template lifetime behavior
still require integration proof; synthetic protected files do not substitute
for those checks.

The probe's temporary namespace is a proof harness, not the production launcher.
Its broad fixture-root bind and writable proc bind are not proposed production
mount rules. Mode 0600 and same-UID HMAC files alone remain insufficient against
model-controlled commands. The production implementation must preserve the proven
managed restrictions and narrower mount scope; otherwise use a separately
isolated signer/executor identity rather than asserting producer independence.

## Background work and quiescence

The local provider also starts a real detached Python writer with closed standard
streams and a new session. It writes a heartbeat before the foreground command
returns. After native turn completion the heartbeat stops advancing in this
fixture, while the shared private app server remains alive. However, a bounded
inspection of that app server's descendants did not establish an exact worker
PID/start-time identity. This is **not** affirmative proof that all execution or
external side effects have stopped, and the report sets `quiescenceAuthority`
to false.

Delivery writer holds must remain until an independently tracked tool-session or
sandbox-process boundary proves termination of the exact writers. A future
per-attempt namespace/cgroup broker may supply that proof without killing the
shared native server, but neither idle thread metadata, tool success nor this
single stable heartbeat can release the hold. Unknown child processes, external
services and incomplete process observations remain held.
