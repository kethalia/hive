# Real-home native readiness correction

The first account pilot failed before the launcher returned: no model catalog,
root thread, child or prompt was reached. Preserve that outcome in
`native-account-pilot-first-failure.json`. The task-private diagnostic identified
`command/exec` rejection (-32600): native's generated helper alias under
`CODEX_HOME/tmp/arg0-linux` conflicted with the global native-home read denial.
Initialize and effective managed requirements were correct.

Two fixture assumptions hid this in the earlier local proof. Codex refuses helper
alias creation when CODEX_HOME is under `/tmp`, and those temporary home mounts
implicitly created a `/tmp` directory inside the namespace. Real home paths
exercise alias creation and do not provide that accidental scratch directory.

The canonical namespace now mounts a private empty directory read-only over
only `CODEX_HOME/tmp/arg0-linux`, selecting the pinned vendor helper fallback,
and supplies a private `/tmp` tmpfs before mounting the dedicated home paths.
It retains the existing auth/config/history, global read denials, network denial,
managed profile, capabilities and process identity chain. Existing alias files
are hidden by the mount, not deleted. No credential or history read is added.

`probe-codex-runtime-alias.mjs` reconstructs three cases in synthetic homes under
the primary task checkout, using no account or model request:

1. Original mounts reproduce the managed-denial conflict.
2. Read-only aliases alone clear that conflict but expose missing scratch space:
   native sandbox construction exits1.
3. Read-only aliases plus private `/tmp` execute the positive control and retain
   token/config/requirements read denials (exit0).

The native namespace regression now uses a real-path synthetic home. Actual
0.165 WS, remote CLI, root/child commands, hostile workdir, resume, history after
checkout removal, process identity and abrupt-death controls pass. A synthetic
`auth.json` remains byte-for-byte unchanged and cannot be read by commands.
A short fixture path keeps the private tmux Unix socket within its kernel path
limit; no production socket path was changed.

Validation:

```sh
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-runtime-alias.mjs
HIVE_TEST_NATIVE_CODEX=1 node --test scripts/verify-codex-native-namespace.test.mjs scripts/verify-codex-project-supervisor.test.mjs
node --test scripts/verify-codex-host-package.test.mjs
```

Results: three alias controls pass, 33 actual native/supervisor tests pass with
no skips, and three package checks pass. No actual-account inference has run.
The dedicated test workspace's failed empty synthetic checkout was removed only
after preserving its private receipt and result, checking its original inode,
confirming it was empty and finding no pinned native app-server. The official
host remains healthy and its dedicated authentication is retained. See
`native-account-pilot-first-cleanup.json`. Installing the reviewed correction and
passing installed readiness are required before retrying the account pilot.

## Independent parent rerun and timing regression

The parent's first independent run failed at the persisted-binding assertion
(`session_not_available`, 32/33 tests passed). Its full log is preserved as
`native-real-home-parent-first-failure.log`. An immediate unmodified rerun passed
33/33. **That original failure remains unreproduced; its cause is not established.**

A separate deterministic two-second provider delay exposed a timing error in the
same test sequence: native had already persisted the user item, so the test
attached the CLI and checked the pane after a fixed one-second sleep while the
answer was still running. This negative control is preserved in
`native-real-home-delayed-negative-control.log`; it is not presented as a
reproduction of the parent's earlier binding failure.

The test now waits for the actual first `turn/completed` event, then reconciles
history within a ten-second test deadline. It polls the actual terminal text
within a five-second rendering deadline. Initial prompt and history errors are
retained in failure assertions. The two-second provider delay remains in the
regression fixture. No production RPC timeout, persistence rule or namespace
code changed. The full delayed-fixture suite passes 33/33. Actual real-home tests
must run from a checkout outside `/tmp`; the fixture rejects `/tmp` working
directories instead of silently reintroducing the original alias blind spot.
