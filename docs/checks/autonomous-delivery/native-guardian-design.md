# Native guardian: proposed installed integration

Status: design only, 2026-10-29. No installed runtime, policy, database or cleanup
authority changes are made by this document. The recommendation is one dedicated
trusted subreaper for each native server lifetime, owning the server, private tmux
server, CLI processes and terminal attachment processes. This can be tested in the
existing software test workspace without node credentials, new PID mounts or
broader capabilities. Planned drain is deferred while another project in that
lifetime has active or uncertain work.

The [software proof and limitations](cleanup-capability-next-step.md) remain the
evidence baseline. Four synthetic cases pass. Actual pinned native startup,
commands, protected-path denials, drain and persisted resume pass; a separate
startup failure remains preserved with an unproven cause. Neither that proof nor
this design authorizes checkout deletion or clears existing writer holds.

## Ownership boundary

The current `launchNative` starts a Python parent-death shim that execs the native
namespace wrapper. Its `attach` method separately starts tmux from the host.
`codex-project-terminal.py` independently forks a PTY attachment client. Thus a
guardian around only the current app-server spawn would miss both CLI and terminal
trees. The existing `close()` process kill and `kill-server` calls do not provide
an adopted-descendant empty-tree proof.

Proposed process ownership:

```text
installed host controller (signer, journals, read gateway, authenticated APIs)
  └─ pinned guardian: one thread, one waiter, PR_SET_CHILD_SUBREAPER
       ├─ pinned bwrap wrapper → bwrap monitor → pinned native app-server
       │    └─ native command helpers, tools and nested native children
       ├─ dedicated foreground tmux server
       │    └─ pinned namespace wrapper → same-thread native CLI for each project
       └─ fixed terminal PTY helpers → private tmux attach clients
```

The tmux server uses a new lifetime-specific socket and `-D -f /dev/null`; the
installed tmux manual confirms `-D` stays in the foreground and disables
`exit-empty`. Do not attach an existing default server or adopt a pre-existing
socket. Explicitly disable user configuration, hooks and session restoration.
The guardian launches fixed tmux client operations to create sessions, so every
CLI is descended from the owned tmux server. Terminal helpers also launch through
the guardian; the bridge receives only their bounded terminal stream/control
channel. It never receives a generic shell or spawn operation.

Other projects' independent native lifetimes, ordinary user tmux servers,
specialist workspaces and the host controller itself remain outside this tree.
Host Git preparation/fetch, artifact collectors and external action executors are
also outside it: their writers require separate ownership and completion evidence.
No guardian receipt silently covers them.

## Minimal installed guardian and local protocol

Use a small Linux C program, not Node's child-process reaper plus an independent
wait loop. It is single-threaded, owns every wait, sets and verifies the subreaper
attribute before spawning, retains `SIGCHLD=SIG_DFL`, and never enables
`SA_NOCLDWAIT`. It sets itself non-dumpable and rejects unexpected inherited FDs.
Its own process cannot run model code or load workspace-controlled configuration.
No ptrace supervisor, external process adoption or arbitrary PID target is offered.

The installed host starts it with an inherited private duplex control FD and a
bounded startup descriptor. The FD is the local channel authority; there is no
public Unix socket, HTTP route or caller-supplied port for guardian commands.
The host pins the guardian's installed executable and checks its kernel parent
edge/start identity. The guardian checks its expected direct host parent before
accepting startup. A same-UID pathname or app header is insufficient authority.

Each frame carries `protocolVersion`, `guardianLifetimeId`, `requestId` and an
expected monotonic `admissionGeneration`; malformed, oversized and duplicate
conflicting frames close execution admission. Proposed maximum frame size is
32KiB, with bounded outstanding requests and a bounded exact-replay cache.
Requests are resolved against startup configuration and the host's verified
project ledger, never against model-supplied paths, URLs, commands or PIDs.

| Operation | Narrow meaning |
| --- | --- |
| `startRuntime` | Once only; fixed pinned server/namespace descriptor and fresh private tmux server |
| `recordAdmission` | Acknowledge a controller-journaled project/preparation/lease binding before that binding can execute |
| `attachProject` | Start the fixed same-thread CLI for an already admitted exact project/thread |
| `openTerminal` / `closeTerminal` | Start or stop a fixed attachment helper; no client-selected executable or cwd |
| `closeAdmission` | Irreversibly enter drain for the exact lifetime/generation and ownership-set digest |
| `drain` | Terminate only pinned roots and kernel-confirmed adopted children, then report result |
| `ackReceipt` | Allow a successfully drained guardian to exit after its parent persists the receipt |

The host still constructs reviewed namespace policy through the existing module.
The immutable startup descriptor includes its digest, installed package/native
pins and exact launch vectors. The guardian validates fixed program identities
and operation shapes; it does not accept later arbitrary bwrap flags. All
arguments originate in trusted installed code. This avoids recreating a general
process-execution API inside the guardian.

The initial implementation may limit terminal sessions and guardian children
conservatively. Hitting any bound defers work or retains a hold; it never drops
ownership entries. Guardian protocol and terminal payloads use separate framing
and bounded buffers, so terminal text cannot become a guardian command.

## Admission is larger than process spawning

The host must serialize execution admission with the guardian state. A guardian
that only refuses new OS children cannot stop an existing CLI or native socket
from submitting a new turn.

Maintain a durable, append-only ownership set for the entire native lifetime,
including every project, preparation intent, lease incarnation and native root
or child thread admitted to it. Removing a project from a renewed registration
does not remove it from that ownership set. Keep the existing 32-project bound
for the initial design; if the lifetime ledger is full, defer new admission until
a safe drain/replacement rather than forgetting earlier writers.

Before each execution operation the host checks the same lifetime/generation and
journals its identity. This includes first prompts, manager progression, turn
steering, approval/tool responses that can release execution, CLI attach, terminal
input and lease renewal. Every asynchronous continuation rechecks the generation
after awaiting. A pending callback cannot submit a result into a draining server.
Read-only history operations remain separate while the server is available.

For a planned cleanup, acquire a durable workspace/runtime admission barrier:

1. The delivery controller and host agree on the complete lifetime ownership-set
   digest, relevant task/attempt cursors and expected lease renewal sequences.
   Missing, stale or contradictory ownership data retains the hold.
2. Classify every admitted project as safe to stop or protected. A project is safe
   only when its delivery work has reached a controller-approved stop boundary,
   or it has an explicit effective pause/stop decision, and no new task is queued
   for that runtime. A completed native turn or an apparently idle CLI alone is
   insufficient. Uncertain prompts, child mappings, progression results or queued
   host preparation protect the project until reconciled.
3. If any other project is protected, return `deferred_active_project` or
   `deferred_uncertain_ownership`. Do not kill its terminal, child, manager or
   server to satisfy the requesting project's cleanup. Retain the checkout and
   writer hold. A permanently busy shared server can indefinitely defer cleanup;
   per-project runtimes are a later isolation choice, not an implicit fallback.
4. If the whole set is safe, persist the closed generation before requesting
   guardian drain. Block task dispatch, registration-driven admission, progression
   callbacks and lease renewal against that generation. Revoke terminal grants,
   close terminal input channels and discard pending input. Do not confuse this
   with interrupting unrelated projects in different lifetimes.
5. Tell the guardian to close admission for the exact frozen set. Native work
   already in flight may exist until it is killed; admission closure itself is
   not a quiescence statement. The guardian never reopens a closed generation.

The barrier must span server and host mutations, not just a browser session or
an in-memory JavaScript queue. The specific database row/transaction integration
is a subsequent reviewed change; no existing manager progression API should be
repurposed as an implicit global drain authorization.

## Drain algorithm and exact identity

The guardian first stops owned input/CLI/PTY roots, then the app-server root,
using pidfds. It repeatedly obtains targeting hints from its own children list,
opens each candidate pidfd, and verifies child relationship with
`waitid(P_PIDFD, ..., WEXITED | WNOHANG | WNOWAIT | __WALL)` before signaling.
It reaps with all-child `__WALL` semantics. Zero/no-event means pending. Only final
`ECHILD`, after closed admission, is the candidate empty-tree result. Proc absence,
turn completion, a successful signal syscall and native terminal inventory are
never substitutes.

Use monotonic deadlines and syscall/reap budgets inside every loop, including the
inner reap loop. A process in uninterruptible sleep, signal denial, discovery
error, fork storm or exhausted budget returns `held`, never success. Keep the
guardian alive and admission closed while that lifetime remains unresolved;
do not release its lock or relaunch on the basis of a timeout. No broad process
group or workspace kill is permitted. The synthetic proof's bounds are test
bounds, not a demonstrated production capacity setting.

Introduce an explicit execution identity mode, proposed `isolated-guardian-v1`:

```text
host → pinned guardian → pinned bwrap wrapper → pinned bwrap monitor → native
```

Record and recheck each edge, unique PID, boot ID, kernel start ticks, executable
device/inode/path and SHA-256, plus native policy digest and guardian protocol.
Hold pidfds for roots; pin the private tmux server similarly. Do not weaken the
lease helper to accept an arbitrary descendant or reuse the old three-edge mode.
The lifetime identifier is a fresh random value bound to those identities and
the independently verified owner/workspace/build/server registration.

Managed leases retain their existing ID/generation and checkout incarnation.
Renewal additionally requires this guardian to be live and `OPEN`, the exact
recorded ownership binding, and matching admission generation. Renewal continues
to increment `renewalSequence`; closure or replacement never revives expired or
released leases. Cleanup requests bind the final sequence and incarnation, so a
receipt from an earlier lease or native lifetime cannot be reused.

## Receipts, crash behavior and durable history

The minimal guardian does not need a signing key. It emits its bounded result on
the private inherited channel and then remains irreversibly `DRAINED`: no spawn,
attach or reopen command is accepted. The host validates channel/lifetime/state,
persists an HMAC-authenticated local receipt atomically with directory fsync,
then acknowledges it and observes the exact guardian exit. It must persist the
receipt before releasing the lifetime lock or allowing replacement execution.

Proposed receipt fields are:

```text
schemaVersion, receiptId, protocolVersion,
ownerId, workspaceId, buildId, registrationId, registrationGeneration,
serverInstanceId, guardianLifetimeId, guardianProcessIdentity,
packageDigest, guardianDigest, nativeDigest, policyDigest,
admissionGeneration, ownershipSetDigest, drainRequestId,
closedAt, completedAt, monotonicDurationMs,
nativeRootIdentity, tmuxRootIdentity, finalWaitResult="ECHILD",
waitFlags="__WALL", reapedCount, result="managed_native_tree_empty"
```

The immutable referenced ownership set carries each project, preparation intent,
task/attempt binding, repository/revision, lease ID/generation, renewal sequence
and checkout incarnation. Store identifiers and digests, not prompts, environment
values, tokens or raw process argv. Exact duplicate receipt delivery is
idempotent; a changed body under the same receipt ID is rejected.

| Failure boundary | Required behavior |
| --- | --- |
| Host controller loses its control channel | Guardian closes admission and attempts a bounded abort drain of its own lifetime. No planned-cleanup/completion claim follows merely from host death. |
| Guardian dies before a durable verified result | Mark the old lifetime indeterminate. A replacement guardian's `ECHILD` cannot certify those reparented descendants. Keep holds and quarantine old execution bindings. |
| Host dies before persisting a result | Conservative minimum: retain hold, even if the guardian finished killing its tree. An unsigned leftover report is not imported as authority. |
| Host dies after durable receipt but before acknowledgement | Recovery may verify that exact immutable receipt and frozen generation; guardian remains incapable of launching work. Never apply it to a new lifetime. |
| Receipt delivered but response lost | Retry exact receipt bytes; do not run another drain or extend its authority. |
| New build, changed package/policy or stale registration | Reject reuse as current authority; preserve old facts for reconciliation. |

Abrupt loss of execution authority may stop all projects sharing that failed
runtime. That is a fail-stop response to authority loss, distinct from elective
cleanup; it does not justify stopping a healthy shared runtime for one finished
project. Other runtimes remain untouched.

Preserve the dedicated native CODEX_HOME, project metadata, journals and history.
After an authorized clean replacement, resume the same thread through the new
registered native lifetime. Do not resubmit an uncertain first prompt or replay
model tool effects. Read history does not require recreating a checkout. During
an indeterminate old lifetime, retain available read snapshots and report the
blocked execution state; this design does not promise a new history-only native
server can safely share a still-live history writer's home.

## Remote observation is not cleanup completion

Planned drain needs a narrowly scoped, persisted controller challenge issued
before closing the old runtime. It binds the exact registration/lifetime,
ownership digest and generation. Receipt ingestion must be able to finish that
challenge after the native server exits; requiring an actively running native
connection would make successful drain unreportable. Conversely, do not broadly
accept revoked registrations: only the outstanding planned-drain challenge for
that exact old lifetime can finish, subject to fresh owner/build authorization
and transactional generation checks. A new lifetime cannot satisfy it.

The existing host signing identity can publish the verified receipt through a
dedicated fixed scope. The server must check the independently issued challenge,
trusted package/protocol and exact binding under the same transaction that
records the observation. The model and manager dynamic tool receive no signing
operation or ability to claim the producer role.

The result establishes only the owned native process tree's termination.
`src/lib/delivery/repository.ts` also requires external operations to be quiescent
and external effects reconciled. Do not set those fields to `none` merely because
the native tree is empty. Host Git writers, collectors, pending external actions,
passed writable FDs, unmanaged owner processes and asynchronous I/O obligations
need their own checks. Unknown cases retain the existing writer fence.

Even a complete writer observation is only one cleanup precondition. The managed
checkout helper must still require independent completion/production/artifact
evidence, exact revision/incarnation/renewal sequence, no lease, clean tracked and
untracked/ignored state, no references/mounts, and remote commit preservation.
Its production deletion authority remains disabled until that complete path is
implemented and reviewed. A guardian receipt is never a replacement completion
certificate.

## Secret handling and distribution

Keep all signer keys and controller journals outside the native mounts. Guardian
control/receipt FDs are close-on-exec and explicitly closed in every untrusted
child before exec. Inherit only intentional stdio/PTY channels and the exact
read-only native token mechanism already required by the namespace. No owner
Coder token, GitHub token, signing key, controller socket, lifecycle lock or
configuration directory is inherited by model-executed children.

Do not put a lifecycle lock in untrusted descendants as a substitute for crash
proof. The host and guardian may hold the lock; if both die its release only
allows recovery inspection, never an automatic new native launch. The durable
unfinished-lifetime record keeps execution blocked. Private directory permissions
alone are insufficient against same-UID model commands: retain actual filesystem,
proc/FD, memory-access and child-inheritance denial tests.

Package a reviewed architecture-specific guardian ELF from a pinned CI toolchain,
record source and executable digests, and verify its ELF/platform/hash/ownership
on install and launch. Add it to the existing immutable package manifest and
software-only opt-in path. No workspace compiler/download, shell-generated
binary, dynamic dependency install or nightly CLI updater may replace it. A
static build is preferable if its reviewed toolchain is available; otherwise
the exact runtime loader/library dependencies must be pinned and tested. The
synthetic local `cc` build is evidence, not the release artifact.

The existing annotation archive budget still applies. If the package exceeds
that budget, fail packaging rather than truncate or widen deployment privileges.
This design introduces no node daemon, delegated cgroup, host socket, service
account permission, new proc mount or infrastructure workspace requirement.

## Review and validation checkpoints

1. Finish adversarial fixture coverage: CLONE_PARENT, live threads after leader
   exit, ptrace, nested namespaces, fork/reparent storms, deadline exhaustion,
   pidfd identity races and supervisor crash. Preserve an outside writer positive
   control and never accept omitted targeting as an empty-tree result.
2. Implement the local guardian/identity mode with production flags off. Test
   real pinned native WS, CLI, child execution, resume and existing credential
   denials; verify foreground tmux, PTY descendants and startup failures are owned.
3. Test the admission barrier with two projects: B actively computing, awaiting
   input, holding a CLI, having an uncertain prompt and receiving a delayed
   progression response must each defer A's elective drain. After an authorized
   common stop boundary, both trees drain and histories remain readable.
4. Test durable receipt/registration races, controller and guardian crash windows,
   lost acknowledgements, lifetime replacement, lease renewal and stale cleanup
   replay. No receipt may clear external-operation or verification holds.
5. Install only the reviewed disabled package into the persistent test workspace
   through the parent's inactive-template workflow. Repeat the real command,
   CLI/child/lease and process-isolation proof there with synthetic local responses;
   no account inference is required for this gate.

Only after those separate checkpoints should a further review consider enabling
trusted native-tree observations. Checkout removal and delivery completion remain
separate authority decisions. No implementation edits accompany this design.
