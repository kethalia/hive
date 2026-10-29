# Standalone native guardian foundation

This checkpoint implements new standalone files only. The installed supervisor,
namespace, lease helper, runtime bundle and cleanup authority are unchanged.
Shared template scaffolds carry the source files, but do not compile or install
the guardian. The [guardian design](native-guardian-design.md) remains the integration
contract. There is no public endpoint or production activation.

`codex-native-guardian.c` owns one immutable set of at most eight root descriptors
and 32 project bindings. Its sole waiter uses the subreaper mechanism and Linux
`__WALL`. A private inherited Unix stream FD is checked against the direct parent
with `SO_PEERCRED`; length-prefixed frames are bounded at 32KiB. Request IDs are
strictly sequential. Only the immediately preceding exact frame can replay its
cached reply. Changed, older, partial-timeout and oversized requests revoke the
channel and trigger an abort drain, not a successful receipt.

The JS client verifies ELF bytes, SHA-256, real paths, owner/mode and stable file
metadata before supplying executable/cwd FDs. C independently checks the inherited
file identities and rechecks executable metadata immediately before `fexecve`.
C does not independently implement SHA-256: the reviewed trusted client is the
hash verifier. Package immutability and exclusion from model writes remain
required; an arbitrary caller-supplied expected digest is not deployment trust.

The parent verifies the guardian executable and direct-parent/start identity at
the READY handshake, before activation locks guardian dumpability. After that,
same-UID `/proc/exe` access is intentionally unavailable. A future lease identity
mode must incorporate this continuous pinned control channel; the existing
three-edge process check has not been relaxed or changed.

Root roles are native server, tmux server and terminal helper. Unexpected essential
root exit closes the lifetime; an ordinary terminal-helper exit does not stop
another active root. The current descriptor set is fixed at bootstrap and each
descriptor launches at most once. Dynamic terminal reconnects, project admission
and real foreground-tmux composition are subsequent integration work.

The client requires explicit journal callbacks for begin, ready, launch intent,
closure intent, receipt acceptance and indeterminate state. There is no in-memory
production fallback. Tests deliberately inject an in-memory fixture journal;
this checkpoint does **not** implement durable HMAC journals or server receipt
ingestion. `authorizeDrain` is a trusted installed-controller callback, never a
browser/model boolean. It must return the exact entire project binding set and
independent stop-decision IDs. The C layer checks that complete set before
irreversibly closing admission. The future controller must implement the durable
multi-project barrier and verify these stop decisions.

Drain uses proc children only for targeting. Each target must first pass
`pidfd_open` and `waitid(P_PIDFD, ..., __WALL | WEXITED | WNOHANG | WNOWAIT)` child
verification. Only all-child `ECHILD` after closure produces the native-tree result.
Each pass is bounded by four seconds, 128 targeting candidates per read, 2048 wait
calls and 512 reaps; inner loops check their budgets. A failed pass remains held.
On controller loss, a held guardian retains adoption ownership and retries at
five-second intervals; it must not be forcibly killed to make a cleanup check pass.

The receipt binds lifetime, ownership and launch-descriptor digests, verified
guardian identity, closure/drain request IDs and generation. It explicitly says
`scope: managed_native_tree_only` and `cleanupAuthorized: false`. The parent must
persist it before acknowledging guardian exit. A journal failure, lost controller
or guardian crash leaves the lifetime indeterminate; a replacement's empty tree
cannot certify the old one. Receipt durability and host registration challenges
are unimplemented caller integration, not inferred from this callback API.

## Validation

Run `node --test scripts/verify-codex-native-guardian.test.mjs`. The suite compiles
the C source with `cc -std=c11 -O2 -Wall -Wextra -Werror` into task-private scratch.
All 19 tests pass on the current Linux x86-64 software workspace, covering:

- Whole-project stop authorization and deferral; outside sibling writers survive.
- Double-fork/setsid, nested subreaper, CLONE_PARENT and non-SIGCHLD descendants.
- Live threads after leader exit, bounded concurrent forks and owned ptrace.
- Inherited unlinked writable FDs; no further writes after drain.
- Guardian FD/credential-environment exclusion from child execs.
- Pin mutation, duplicate launch, journal failure and controller-channel loss.
- Guardian-crash nonrevival, malformed framing and exact replay without another fork.
- Normal terminal-helper exit without revoking another active root.

The foundation guardian-crash test kills a lifetime before launching roots. The
earlier [synthetic subreaper proof](native-subreaper-proof.json) separately proves
that an active writer survives supervisor death and therefore needs a hold. A
composed installed active-guardian crash/recovery drill remains required.

Run the separate optional real-binary fixture with
`HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-guardian-foundation.mjs`.
[Final native evidence](guardian-foundation/native.json) records pinned Codex
0.165 startup, one deterministic loopback canned Responses turn, allowed command
execution, four token/auth/proc/symlink denials, guardian drain, a new lifetime,
same persisted thread resume/read, repeated controls and another drain. Final
run: 2.154 seconds, one canned request, zero account inference or external calls.
Synthetic credentials/history are task-private and removed only after verified
drain. The probe keeps scratch state if a drain is unverified.

Do not erase the mixed readiness evidence. The
[first failure](guardian-foundation-native-first-failure.json) reached native
thread start but missed the fixture's five-second canned-turn completion wait;
it connected in 5461ms and still drained its owned tree successfully. Its missing
request/event diagnostics prevent a causal conclusion. The subsequently added
timing/category diagnostic run passed in 1.498 seconds, and the final role-aware
run passed in 2.154 seconds. The canned-turn deadline was not increased. These
successful runs establish compatibility, not a stability guarantee or an
explanation of the earlier failure.

## Still blocked before installed use

- Release-built/pinned guardian ELF and software-only package installation; no
  workspace compilation or mutable runtime path in production.
- Exact guardian identity mode in supervisor/lease verification, durable journals,
  controller loss/crash recovery and signed server-side receipt/challenge handling.
- Actual owned foreground tmux, same-thread CLI and terminal PTY stream integration;
  complete descendant ownership across their reconnect/exit cases.
- Durable shared-project admission, delayed callback fencing and independent host
  broker/external-operation quiescence. An injected fixture approval is not that
  controller implementation.
- Real test-workspace validation of the installed composition and all prior
  namespace credential/override/child controls.

No writer hold, external-operation status, verification result, task completion
or cleanup permission changes in this checkpoint.
