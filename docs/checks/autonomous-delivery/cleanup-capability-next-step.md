# Cleanup capability: next decision

**Keep every production writer hold. Do not widen the current pod's privileges
or remove its proc masks.** No supported, working whole-native PID wrapper has
been established in this environment. A dedicated trusted Linux subreaper now
passes the bounded synthetic cases and actual native startup/drain/resume fixture
without adding a PID namespace. Review that software-only design before requiring
infrastructure changes. Its installed integration, complete writer ownership and
receipt authority are still unimplemented; it grants no cleanup authority today.

In plain terms: put a small trusted parent in charge of exactly one coding
runtime, stop that runtime's descendants, and ask the kernel whether any children
remain. This might avoid node access entirely. If its conditions cannot be met,
the concrete fallback is a separate native-runtime container with a matching PID
namespace and proc view. Neither option is approved for production activation.
Adding an ordinary Infrastructure workspace would not itself provide either
capability or node logs; the user need not locate unknown logging infrastructure.

## New evidence, not another identical timeout

The approved `scripts/probe-codex-pid-startup.mjs` matrix ran in 19.5 seconds using
four fresh private real-home fixtures, pinned Codex 0.165, unchanged inherited
proc bind, existing managed permission denies and no account/model inference.
No `turn/start` was called. Exact executable/bwrap pins, kernel start identities,
namespace memberships and bounded wait-channel observations are preserved in
`native-pid-startup.json`.

| Wrapper | Thread request | Startup | Concurrent requirements read |
| --- | --- | --- | --- |
| Current user namespace | Ephemeral | Pass, 241ms | Pass |
| Current user namespace | Fresh persisted | Pass, 242ms | Pass |
| Add whole-native PID namespace | Ephemeral | Eight-second deadline | Pass |
| Add whole-native PID namespace | Fresh persisted | Eight-second deadline | Pass |

The ephemeral request bypasses thread persistence/state-database acquisition in
the pinned source. Its failure means rollout persistence alone cannot explain
the PID-only failure. The successful concurrent read also rules out a globally
unresponsive WebSocket/RPC server. This result is consistent with the earlier
stdio and WebSocket cold-resume failures after the private `/tmp`/alias fix.

A new observation narrows the remaining suspect area: after the PID-only requests,
the native process has multiple nested bwrap descendants in further PID namespaces,
waiting in `do_wait_intr_irq`. The completed baseline cases show only the outer
wrapper and native process. The collector intentionally caps the process walk
at 12 entries and threads at 8 per process. These are diagnostic snapshots, **not an
exhaustive process inventory or quiescence authority**. All previously recorded
fixture identities were independently checked absent/terminated after shutdown;
owned scratch trees were removed. No installed runtime or workspace was changed.

## What the pinned sources establish

Sources were fetched read-only from OpenAI's public `rust-v0.165.0` tag. That is
source-version correspondence, not an independently reproduced ELF build; the
actual fixture separately verifies the installed binary pins.

- [`Session::spawn`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/session/session.rs)
  concurrently acquires persistence/state/auth, bypasses persistence for ephemeral
  threads, then awaits selected environment resolution and instruction/plugin
  setup before exposing the ready session. This motivated the matrix.
- [Environment resolution](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/environment_selection.rs)
  waits for the executor connection/configuration. The observed timeout therefore
  does not identify a single storage call or prove native process deadlock.
- [The Linux helper](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/linux-sandbox/src/linux_run_main.rs)
  runs a bwrap proc-mount preflight, captures its stderr until EOF, then waits for
  the child. Recognized proc failure switches to a no-proc fallback. Those blocking
  reads/waits have no local deadline in the inspected function. The nested waiting
  bwrap descendants make this startup-helper path a concrete suspect, but kernel
  wait channels do not prove which exact call is stalled.
- [Bubblewrap argument construction](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/linux-sandbox/src/bwrap.rs)
  normally creates per-command user/PID/IPC namespaces. No-proc fallback retains
  PID isolation. The source also has a startup-owned
  [`LinuxSandboxPidNamespace::Inherit`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/sandboxing/src/linux_pid_namespace.rs)
  option. Its own contract explicitly permits signals to other same-UID processes.
  It is not a safe transparent fix: switching it would change the command process
  boundary and could affect other project/runtime work. No such override was made.

The [official sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing#prerequisites)
confirm the bundled helper's dependence on unprivileged user namespaces. They do
not promise whole-app-server PID wrapping with a mismatched inherited proc view,
or supply a complete detached-writer termination contract. The working ordinary
namespace controls already demonstrate basic bundled-helper availability; simply
installing another bwrap is not a supported diagnosis of this failure.

## Why another AppArmor allow rule is not the next step

The repository's current `hive-codex-v1` already permits a proc mount at
`/newroot/proc/` with the expected flags. Its older canary documentation also
records fresh-proc EPERM followed by native's successful no-proc fallback.
Nothing observed justifies broad capabilities, unconfined policy or disabling
proc masking.

The actual kernel reports 6.8.0-134-generic. Upstream
[Linux 6.8 `mnt_already_visible` / `mount_too_revealing`](https://github.com/torvalds/linux/blob/v6.8/fs/namespace.c#L5272)
provides a plausible non-AppArmor reason: a less-privileged mount namespace cannot
create a filesystem view that reveals content hidden by locked child mounts.
This matches the existing runtime's masked/read-only proc submounts, but the
Ubuntu-patched call path and effective locked flags have not been traced. This
is a source-grounded explanation to investigate, **not a confirmed attribution
of the observed EPERM**. It is also distinct from the retained-proc startup hang.

## Software-only candidate: one trusted subreaper per native lifetime

`prctl(PR_SET_CHILD_SUBREAPER, 1)` makes the calling process an adoption point
for orphaned descendants. The setting survives exec but is not inherited by
forked children. A dedicated supervisor must set and verify it **before** spawning
the native wrapper, and spawn no unrelated children. Double forks and `setsid`
do not by themselves remove that ancestry.
([Linux subreaper API](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html))

The relevant upstream Linux 6.8 code is stronger than a proc snapshot:
`exit_notify` holds `tasklist_lock`, reparents children, then publishes the
exiting parent's zombie state. `__do_wait` checks child lists under the same lock.
A live eligible child prevents `ECHILD`; a group leader with live threads cannot
be reaped as a completed process. These mechanisms support the following
**conditional design argument**, not an implemented guarantee: after admission
is closed, a continuously living trusted supervisor whose entire descendant
tree is confined to that ownership can conclude that tree is empty when its
all-child wait returns `ECHILD`. There is no gap where a dead parent has been
reaped while its children await future adoption.
([Kernel adoption/wait implementation](https://github.com/torvalds/linux/blob/v6.8/kernel/exit.c#L623))

The proposed supervisor would use these constraints:

1. Use one trusted thread and one waiter. Keep `SIGCHLD` at `SIG_DFL`, never
   `SIG_IGN` or `SA_NOCLDWAIT`, and prevent untrusted mutation of supervisor
   memory, signal disposition, FDs or control socket. Do not use Node's child
   process machinery as a second reaper. Preserve current signer and command
   isolation; a subreaper is not a security sandbox.
2. Close admission durably before drain, including first prompts, CLI attach,
   child creation requests and runtime replacement. Terminate the exact root and
   newly adopted direct children. Use `__WALL` with `waitpid(-1, ..., WNOHANG)`
   or `waitid(P_ALL, ..., WEXITED | WNOHANG | __WALL)`; never `__WCLONE` alone,
   `__WNOTHREAD`, or a process-group-only wait. A zero/no-event return is still
   pending, not success. Retry interruptions within a deadline; only `ECHILD`
   is the candidate empty-tree result.
   ([Wait semantics](https://man7.org/linux/man-pages/man2/waitpid.2.html))
3. Waiting does not enumerate live adopted children. An own-thread proc children
   list may provide targeting hints, but cannot establish emptiness. A candidate
   target must be pinned by pidfd and confirmed as this supervisor's child with
   `waitid(P_PIDFD, ..., WEXITED | WNOHANG | WNOWAIT | __WALL)` before pidfd-directed
   signaling. No concurrent reaper may invalidate that relationship. Enumeration
   failures, signal denial, a fork storm or a deadline retain the hold. Never
   signal a PID supplied by the model or kill an entire workspace group.

Ordinary wait omits clone children whose exit signal is not `SIGCHLD`; this is why
`__WALL` is mandatory even when all normal native processes use fork.
`CLONE_PARENT` gives a new process its caller's parent, so a descendant can create
a sibling or a direct supervisor child, but cannot skip above that supervisor.
The trusted supervisor itself must never use `CLONE_PARENT` to launch the root.
([Clone API](https://man7.org/linux/man-pages/man2/clone.2.html),
[kernel parent assignment](https://github.com/torvalds/linux/blob/v6.8/kernel/fork.c#L2623))

Nested subreapers can delay adoption until they are killed; they do not eliminate
the live ancestor connecting them to the supervisor. Newly created nested PID
namespaces require a separate case: orphan adoption stays in that namespace,
while its init remains connected to the outer tree. Reaping the nested init has
a kernel-level namespace shutdown invariant. Do not assume this covers joining
an existing externally owned namespace; prevent access to such namespace FDs.
([Kernel namespace shutdown](https://github.com/torvalds/linux/blob/v6.8/kernel/pid_namespace.c#L170))

Ptrace and thread edge cases must be explicit negative controls, not silently
excluded from the test. The supervisor must not trace unrelated processes;
external tracers or altered wait behavior must prevent successful attestation.
Descendant threads, a leader exiting before its threads, and a descendant tracing
another owned descendant all need coverage. No source review here establishes
that every existing host/native privilege path meets these conditions.

**Crash recovery is deliberately asymmetric.** If this supervisor dies before
recording its final result, a replacement's `ECHILD` says nothing about the old
tree: orphans may have moved to an unrelated ancestor. Mark that lifetime
indeterminate and retain its writer hold. `PDEATHSIG` is not a substitute for
draining detached descendants. A successful receipt must bind boot identity,
supervisor start identity, native lifetime, closed-admission generation and exact
registered projects, then persist before releasing the lifetime lock.

External host brokers, pre-existing tmux/CLI processes, passed writable FDs and
remote effects are outside this tree. They need separate fenced ownership and
drain evidence. Process exit also must not be promoted to proof of artifact
durability or cancellation of every asynchronous filesystem operation. A shared
native lifetime remains a shared drain unit; this cannot kill one project's
descendants while guaranteeing another project in that runtime stays active.

The initial bounded experiment is complete; the exact results and remaining
coverage are below. Integration changes the verified parent chain, so the
existing lease attestation needs an explicit reviewed mode.

## Completed software proofs and their limits

`scripts/probe-native-subreaper.c` is fixture-only, never packaged. Its final
synthetic run completed four cases in approximately 1.1 seconds, recorded in
`native-subreaper-proof.json`:

| Fixture | Observed result |
| --- | --- |
| Double-fork/setsid, ignored SIGTERM, inherited unlinked writable FD | Writer active before drain, stopped after all-child ECHILD |
| Nested subreaper with detached writer | Adoption/drain succeeds; no remaining writes |
| Direct clone child with SIGUSR1 exit signal | Ordinary wait incorrectly excludes the live child; `__WALL` keeps it pending and permits correct drain |
| Abrupt supervisor SIGKILL | Writer continues and no successful receipt exists; a separate test-driver subreaper contains and cleans only this negative fixture |

Each successful case deliberately omits targeting once and confirms the hold
remains. An unrelated sibling writer keeps writing during the tested supervisor's
drain, then the outer fixture driver cleans its own children. Process targeting
is capped at 24 children per read; each drain has a four-second deadline, a
512-wait-call budget and 128-reap cap, checked inside the reap loop as well as
outside it. Exceeding these bounds cannot yield success. Source/executable hashes,
boot ID and supervisor start identities accompany the synthetic evidence.

`scripts/probe-codex-subreaper.mjs` compiles that same fixture and runs the actual
pinned native binary under it, with the current unchanged namespace permissions.
`native-subreaper-compatibility.json` records fresh WebSocket initialize,
requirements, thread start, one deterministic loopback canned response to make
history durable, allowed command execution, token/auth/proc/symlink read denials,
closed-admission drain, restart, same-history resume/read, repeat command/denials
and another final ECHILD drain. It used no account inference, credentials or
external service, and took 6.05 seconds. All owned scratch state was removed.

Preserve the mixed stability evidence: `native-subreaper-compatibility-first.json`
records an earlier successful 8.3-second run. The subsequent
`native-subreaper-compatibility-first-failure.json` records `socket_unavailable`;
that harness discarded native stderr and asserted before emitting detailed JSON,
so the cause remains unestablished. The diagnostic harness now retains only fixed
error categories and uses a bounded eight-second connection deadline. Its fresh
connection took 2748ms, exceeding the prior roughly 2.5-second refused-connection
budget. That supports a readiness-budget hypothesis, not a retrospective proof
of the lost failure. Production timeouts were not changed.

Reproduce the synthetic cases by compiling the C file with
`cc -std=c11 -O2 -Wall -Wextra -Werror` into task-private scratch, then running
the resulting executable once for each argument `detached`, `nested_subreaper`,
`clone_signal`, `supervisor_crash`. Run the separate actual-native fixture with
`HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-subreaper.mjs` from this checkout.
It compiles only its own scratch helper and removes that private fixture afterward.

Still unproved: adversarial `CLONE_PARENT`, leader/thread lifetime, ptrace,
concurrent fork storms, actual native child execution and CLI attachment under
the proposed ownership boundary. Source analysis is not a substitute for those
tests. In particular, current `launchNative` starts the private tmux CLI through
host-side `execFileSync`, outside the app-server subtree. Draining only the server
would not include that CLI or its descendants. An installed guardian must own
both, or the CLI needs independent fenced lifetime/drain evidence. Shared server
work requires an all-project admission barrier; no automatic drain may interrupt
another project's active work. Neither synthetic ECHILD result changes these
production ownership gaps or establishes a signed completion receipt.

## Concrete minimal Infrastructure fallback

Prepare a canary-only template design, with no live apply yet:

1. Add a dedicated native-runtime container. Let the container runtime create its
   PID namespace and matching `/proc`; retain default proc masks, non-root UID,
   all capabilities dropped, NoNewPrivs, the existing AppArmor profile and managed
   per-command restrictions. Do not add the failing extra whole-native PID layer
   inside that container. Do not enable `shareProcessNamespace` or hostPID.
2. Mount only the dedicated native history/auth directory, approved managed
   checkouts, pinned runtime/policy and exact read-only WebSocket token required
   by that container. Keep controller signing state and owner credentials out.
   Preserve the durable history volume when the runtime container stops.
3. Keep the trusted host controller outside the native container's process and
   mount boundary. Record the exact pod/container/native lifetime through a
   trusted provisioner/runtime channel. The current direct-parent PID lease
   attestation cannot simply be reused across containers; it must be replaced by
   a reviewed container-lifetime attestation, without trusting model-supplied IDs.
4. Add a narrow trusted drain operation that closes admission, stops attached CLI
   writers, terminates that exact runtime and obtains affirmative lifetime-exit
   evidence. A Coder build's `healthy` flag, a successful API deletion request or
   an empty process scan is insufficient. If Kubernetes/CRI status is used, its
   precise guarantee about namespace-init death must be established and bound to
   the exact container identity; otherwise an external runtime/cgroup observer is
   needed. No runtime socket, node credential or cgroup write belongs in model
   reach.

This changes placement/lifecycle rather than granting the model more privileges.
It still requires infrastructure implementation and a real canary. A provisioned
controller-only cgroup with `cgroup.kill` plus verified empty membership is an
alternative, but no delegated writable subtree exists now; adding a node-level
service would be a larger change than the proposed container split.

One native container shared by projects remains one drain unit. Drain only after
all its projects can safely stop, or choose separate containers/runtimes per
project. Killing a shared lifetime must never be described as independent
per-project cleanup. Readable history must survive the supervised restart.

## Exact unresolved facts and acceptance gate

- Which nested native helper/preflight waits, and why it fails only under the extra
  PID namespace with inherited proc. Method deadlines and wchan snapshots do not
  settle this. A source-scoped synthetic debug trace or upstream minimal report
  could narrow it without account inference; do not repeat unchanged probes.
- Whether a canary native container with runtime-matched PID/proc preserves actual
  WS startup, CLI attach, child execution, resume and all credential-denial controls.
- Which trusted lifecycle signal establishes exact namespace-init death and
  prevents replacement-lifetime confusion; how the lease signer verifies it.
- How global drain admission is serialized across parallel project work, active
  terminals, pending first prompts, native-source journals and runtime replacement.
- Whether detached/double-fork/session-escaped writers and inherited/unlinked FDs
  stop under that exact canary boundary while an unrelated project outside it stays
  live. These must be positive-control tests, not inferred from turn completion.

Until those facts and tests are satisfied, automatic checkout removal and positive
writer-quiescence assertions stay disabled. The new matrix narrows the diagnosis;
it does not establish cleanup permission or production completion.
