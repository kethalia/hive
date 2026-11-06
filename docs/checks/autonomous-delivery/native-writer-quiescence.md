# Native writer quiescence investigation

**Result: keep the production writer hold.** A whole-runtime PID namespace has
an affirmative kernel lifetime boundary, demonstrated with the actual pinned
native runtime and detached writers. It is not yet compatible with native
thread resume in this software pod. No launcher, template, privilege or
production flag was changed by this investigation.

## Native API limits

The [official app-server reference](https://learn.chatgpt.com/docs/app-server#api-overview)
and installed 0.165 generated types expose experimental
`thread/backgroundTerminals/list`, `terminate`, and `clean`. Standalone
`command/exec/terminate` and `process/kill` identify connection-scoped registered
sessions. These APIs describe session management; they do not promise a complete
inventory of descendants that have detached from those sessions. `process/spawn`
is explicitly outside the native command sandbox and is never exposed by Hive's
browser gateway.

The probe deliberately uses **trusted fixture-only `process/spawn`** to stress
that outer boundary. It is not evidence that model commands escaped the
managed sandbox. Its Python process opens an output FD, forks, starts a new
session, forks again, ignores SIGTERM, closes stdio, unlinks the output file and
continues writing through the inherited FD. The tracked native process exits.
The thread's terminal inventory is empty; terminal cleanup succeeds; writes
continue. This is a concrete reason not to equate that inventory with a complete
native-server process boundary. The sole inference request uses a local mock.

## Actual bounded proof

```sh
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-writer-quiescence.mjs
pnpm exec biome check scripts/probe-codex-writer-quiescence.mjs
```

The committed JSON evidence is `native-writer-quiescence.json`. The fixture uses
only temporary owned files and bounded processes. It checks positive writes
before shutdown and retains a host read FD for the unlinked file, so a pathname
scan cannot falsely establish that writing has stopped.

Two outer PID-namespace runs use the pinned bwrap reaper as namespace PID 1 and
actual Codex 0.165 beneath it. The host verifies the init's executable identity,
kernel start time and namespace membership, opens a pidfd, rechecks the start
identity, and waits for pidfd exit after either an exact init kill or abrupt
wrapper death. Both detached writers stop, including their unlinked-FD writes.
An unrelated outside process continues writing throughout. This proves isolation
from processes **outside that namespace**, not from another project sharing the
same native server.

Linux specifies that terminating a PID namespace's init kills the namespace's
processes and prevents subsequent forks into that dead namespace. Processes
cannot enter ancestor PID namespaces. This kernel boundary is stronger than a
successful process scan or a quiet heartbeat interval. The heartbeat assertions
are regression controls; the proposed authority would be the pinned init/pidfd
exit. See the [Linux PID namespace manual](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).

Namespace inode numbers were reused between sequential fixture runs. An inode
alone must never identify a lifetime. A future receipt must bind the unique
controller lifetime, boot ID, exact init identity and already-open pidfd.

## Compatibility blocker and read-only diagnosis

The current profile is software/cli, AppArmor `hive-codex-v1 (enforce)`, effective
capabilities zero and `NoNewPrivs:1`. Its cgroup filesystem is read-only; there is
no delegated writable subtree for a cgroup drain proof.

- Creating an unprivileged PID namespace works.
- Creating a fresh `/proc` with bwrap fails with `Operation not permitted`.
- Retaining the existing protected host `/proc` bind allows native initialize
  and explicit process/spawn, but `thread/resume` times out at the bounded ten
  second limit. Separate exploratory runs also timed out on thread/start with
  both native-as-PID1 and the bwrap reaper. That combination is unsupported.
- Returning to the current launcher namespace restores the same persisted
  thread and its local-mock answer without additional inference.

Read-only inspection of the existing cluster repository found the deployed
AppArmor policy source at
`k8s-cluster/infrastructure/codex-sandbox/files/hive-codex-v1`, SHA-256
`3f62a08d4b694def82c75d419cb68ce2c2a1a2fb402a932421944291da30ba29`.
It already explicitly allows the proc mount destination and expected flags.
The current pod's `/proc` has runtime-installed read-only and masked submounts.
These are a plausible kernel mount restriction; **the exact denial cause is not
confirmed without node audit/syscall evidence**. There is no justified AppArmor
allow-rule change to apply from the evidence currently available.

Next Infrastructure-only diagnosis is narrowly scoped: correlate the fixture's
proc-mount failure with AppArmor/kernel audit, verify actual mount flags against
that existing rule, and inspect whether locked runtime proc masks cause the
kernel denial. Preserve capabilities zero, privilege escalation disabled and
runtime masks. If supported, investigate a PID-only proc view with equivalent
protection as a separate bounded canary; do not assume it works or replace the
pod with an unmasked/privileged configuration. A separately delegated,
non-model-writable per-runtime cgroup with `cgroup.kill` and `populated=0` is an
alternative design requiring explicit infrastructure provisioning, not an
available capability here.

## Integration proposal after the blocker is resolved

A shared native runtime cannot provide independent per-project namespace drain.
Killing its namespace also stops every other project and child in that runtime.
Choose explicitly between:

1. A whole-runtime drain barrier only after all registered project work can be
   interrupted safely. Close execution admission durably, stop every recorded
   remote CLI/terminal writer, prevent new turns, flush source journals, then
   terminate the exact namespace init and await its pinned pidfd exit. Persist
   the drain receipt before restarting and registering a new lifetime. Resume
   each existing thread; never replay an uncertain first prompt. Reads survive
   through native history, with a reconnect during restart.
2. Separately isolated native runtimes per project to permit independent drains.
   That changes the current shared-runtime architecture, process identity and
   registration contracts; it is not a small quiescence flag.

A receipt could establish that no process in the drained lifetime can continue
local writing. It would not establish production success, absence of external
jobs, unknown host-side writers, or safety of remote side effects. Network is
currently disabled for model commands, but future network/IPC brokers must
supply their own completion fences. No API in this probe grants cleanup or
clears the existing D04 hold. Full native WS/CLI/child/resume/override tests,
detached/nested-process controls, concurrent-project admission tests and a
reviewed installed-package canary are required before such a receipt becomes
trusted authority.
