# Isolated native launcher checkpoint

The software host has an explicit `nativeIsolationEnabled` opt-in. Managed-project
template configuration selects it; managed projects still default off globally.
The updated package must be checked in the dedicated test workspace before native
manager/source channels are enabled. `managerEnabled:true`
requires this flag, but this checkpoint does not enable manager/source production
channels or assert writer quiescence.

The installed host derives HOME at
`~/.local/share/hive/codex-native/home` and persistent CODEX_HOME at
`~/.local/share/hive/codex-native/codex`. Native device login belongs in that
CODEX_HOME; no primary authentication is copied. Startup replaces only the
installed generated configuration and requirements, retaining authentication and
native history. The interactive nightly CLI updater remains separate from the
pinned 0.165.0 vendor runtime.

`codex-native-namespace.mjs` pins the native ELF, code-mode host, bwrap and rg.
The namespace mounts the managed checkout root, dedicated native storage, exact
read-only WS token, immutable vendor runtime, explicit system files and read-only
managed requirements. Host controller/signing directories are not mounted.
The native environment is constructed from a fixed allowlist and contains no
Coder owner/agent or GitHub credential. The dedicated native process can use its
own login for model requests; model commands have no network access.

Managed constraints require approval `never`, the sole named permissions
profile, global protected-path read denials, disabled web/MCP/apps/plugins/hooks,
and legacy sandbox-mode restrictions. The legacy restrictions are necessary:
the prior standalone probe established that a profile allowlist alone did not
fence native `command/exec` with a legacy danger-full-access policy. The read
bridge never exposes that RPC. The profile grants minimal system reads and the
thread workspace only; a tool-supplied `workdir:"/"` does not widen the workspace
roots in the actual runtime test. An adjacent managed project remains unreadable
and unwritable.

The inherited kernel lock requires the explicit chain
`host → pinned bwrap wrapper → pinned bwrap monitor → pinned native`.
`--sync-fd 3` accounts for the second bwrap process. The supervisor attests exact
PPID edges, executable paths, device/inode, kernel start time and boot ID; the
host-only Python lease helper independently verifies those identities, hashes
and the signed policy digest. It rejects missing, extra or substituted monitors
and changed native identity. It does not accept arbitrary descendants. The lease
helper remains outside the namespace and is unavailable to model commands.

## Actual runtime evidence

Run in the primary software profile, using installed Codex 0.165.0 and a local
Responses fixture only (no account inference or copied authentication):

```sh
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-native-namespace.test.mjs scripts/verify-codex-project-supervisor.test.mjs
python3 -m unittest scripts.agents.test_codex_project_lease scripts.agents.test_managed_projects
node --test scripts/verify-codex-host-package.test.mjs
```

The new actual-native suite checks:

- Native authenticated WS and tmux CLI attach to the same persisted thread;
  attach adds no inference request.
- Root, hostile-workdir, child and resumed model commands can write their own
  checkout but cannot read or write another managed project, native token,
  token symlink or native configuration. Managed requirements, native and parent
  `/proc` aliases, environment and a known open parent token FD are unreadable.
  A live loopback listener is inaccessible from model commands.
- Thread resume cannot select danger-full-access; a turn override and legacy
  direct-command override are rejected.
- History survives restart after the checkout is removed. Readiness uses the
  existing managed root and creates no replacement project checkout.
- The real Python lease verifier accepts the exact attested chain and rejects
  missing/extra/substituted monitors and changed native start time.
- SIGKILL of the wrapper, monitor or host terminates the recorded native chain.
  Reopening the same supervisor state proves inherited OS-lock release.

The original broader profile/proc/escalation/MCP controls remain in
`native-authority-isolation.md` and its standalone probe. These are local
runtime proofs, not evidence of a live template rollout or independent
production completion. No browser or public endpoint is activated here.

## Remaining capability gates

Dependency downloads and network API tests from model commands are deliberately
unavailable. They require separately authorized host brokers with fixed inputs;
this checkpoint does not widen command network or filesystem permissions.
The outer native engine is trusted; the managed policy isolates its model tools,
not a compromised native executable. Pinning and exact process checks address
replacement, not vendor compromise.

The earlier background-process probe did not establish a complete trusted
process inventory. Writer quiescence therefore remains held even after a turn
or the known process chain exits. Actual installed-package readiness and a
bounded signed-in test-workspace pilot remain parent-controlled gates.

Parent verification reran the 33 actual-native checks and 33 Python lease/lifecycle checks successfully. The test account completed a fresh device sign-in in the dedicated CODEX_HOME; no account inference has been claimed by these local fixtures.
