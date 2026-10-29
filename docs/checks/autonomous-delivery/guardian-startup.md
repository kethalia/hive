# Private guarded host startup attestation

This checkpoint adds installer-to-outer startup framing and exact worker readiness
to the guardian foundation. It grants no preparation, source-producer or cleanup
authority. The installed outer deliberately rejects both admission and elective
drain until independent controller authorization is implemented. An inner signed
journal is evidence, not that authorization.

The installed entry is the fixed `codex-workspace-host-outer.mjs`, without arguments.
Configuration must enable `guardianEnabled` and `nativeIsolationEnabled`. The
existing direct entry cannot accept a guarded configuration. The outer starts only
the package-pinned `codex-workspace-host-worker.mjs` under the pinned guardian ELF;
it accepts no executable, script, authority-module or command from the installer
frame. Its private journal resides at `~/.local/state/hive/codex-host-guardian`.
Uncertain previous lifetimes remain held rather than adopted after restart.

The installer creates a private socketpair and inherits one endpoint as outer FD3.
Each startup message is one newline-terminated JSON object, at most 32 KiB. Input
must arrive within five seconds. Duplicate, extra-key, oversized and malformed
start frames reject. The start frame is exactly:

```json
{
  "schemaVersion": 1,
  "type": "start",
  "nonce": "<canonical base64url encoding of 32 random bytes>",
  "configSha256": "<64 lowercase hex>",
  "packageManifestSha256": "<64 lowercase hex>",
  "nodeSha256": "<64 lowercase hex>",
  "port": 32123
}
```

The installer holds those expectations independently. The outer checks the exact
private installed configuration bytes, package manifest and executing Node binary.
The worker reads configuration once, hashes the same bytes it parses, and includes
`startup:{configSha256,port}` in its inherited-channel hello. Its PID must match
the guardian's launch acknowledgment. The worker calls `guard.ready(startup)` only
after `startWorkspaceHost` has bound the configured listener. A hello alone cannot
produce startup attestation. Existing library fixtures may omit startup metadata;
their `startupAttestation()` then rejects.

The outer's ready frame has the exact start fields with `type:"ready"`, plus:

- `phase:"open"`, `lifetimeId`, `bindingDigest`, `generation`, `ownershipDigest`;
- `workerSha256`, `guardianSha256`;
- `projects`, an array of `{projectId,bindingDigest}`;
- `outerIdentity`, `guardianIdentity`, `workerIdentity`, each containing exactly
  `{pid,parentPid,startTime,bootId,executable,device,inode}`. Kernel start ticks,
  device and inode are decimal strings.

The outer refreshes the exact worker identity and both Node digests before exposing
this frame. Worker parent must be the exact launched guardian; guardian parent must
be the outer process. The guardian becomes nondumpable, so its executable identity
is the pinned preactivation observation. Fresh `/proc/PID/stat` start/parent and
`/proc/PID/status` real/effective/saved/filesystem UIDs still must match; root-owned
proc-directory metadata does not replace those checks. No descendant search or
inaccessible-executable fallback is allowed.

The installer must independently validate the nonce, configuration/package and
binary identities, current kernel chain, and ownership of the listening socket by
the exact worker PID before accepting health. A saved private receipt is only
usable while these checks still succeed; it is not permission to restart or
adopt an old tree. The outer's startup channel closes after its single response;
the separate worker control channel remains live. No HTTP readiness credential,
owner token, argv, environment or signer material appears in the frame.

Local validation: 30 guardian/outer tests passed, including delayed readiness,
wrong configuration rejection, closed-lifetime attestation rejection and bounded
private framing. Existing detached-writer, inherited-FD, clone/ptrace, crash,
exact replay, foreground tmux and PTY drain tests remain passing. These are local
fixtures, not an installed workspace proof or independent controller drain grant.
CF's worker/listener composition and the parent's installer/listener verification
are separate checkpoints; no cloud or account inference was performed here.
