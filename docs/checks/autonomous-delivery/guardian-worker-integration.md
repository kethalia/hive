# Guardian-owned host worker

Status: integration building block, disabled until composed worker validation.
No template activation, account inference, server receipt ingestion, writer-fence
release or checkout cleanup is implemented here.

The trusted outer launcher owns the durable journal and a pinned guardian. The
guardian owns one pinned Node worker. The existing software host runs inside that
worker, so its native namespace process, tmux server, CLI panes, Python PTY
helpers and their descendants belong to the same adopting tree. No existing
process is adopted. The worker-to-bwrap-to-monitor-to-native lease identity chain
is unchanged; the guardian is an additional ancestor above the worker.

This placement also encompasses locally spawned Git and artifact helpers.
It does not prove absence of external effects, remote writers or other processes
outside the tree. Existing independent writer holds remain necessary.

## Package and channel

`codex-host-guardian.mjs` exports `openGuardedHost`. Its installed composition
must provide the reviewed package directory and manifest SHA, exact worker
module name, Node executable SHA/path, private working/state directories, runtime
binding digest and independent authorization callbacks. The whole manifest and
every declared file are checked before spawning. The guardian is the fixed
package sibling `codex-native-guardian`; its build metadata is supplied by the
reviewed build-time pipeline. There is no runtime compiler or ambient fallback.

The C control channel remains guardian FD3. A separate socketpair inherited at
startup is handed to the worker as its FD3, after closing the guardian control
descriptor and all unrelated descriptors in that child. The guardian verifies
both channel peers against its direct parent PID/UID. The outer peer verifies
the worker's hello PID against the exact launch result. There is no public Unix
socket or network endpoint. No SCM_RIGHTS or generic dynamic spawn API is added.

Worker frames are bounded newline JSON with independent monotonic request IDs,
32 outstanding/active requests and bounded output buffering. The only outer
operations are hello, admit and fence; the worker accepts closeAdmission. Replay,
oversized/malformed frames and channel loss fail closed. Terminal bytes continue
through the existing worker-owned terminal transport, never this control stream.

## Worker interface

```js
const guard = await connectGuardianWorker({
  fd: 3,
  onCloseAdmission: async (barrier) => persistAndCloseWorkerAdmission(barrier),
  onLost: () => revokeWorkerExecution(),
});
let token = await guard.admit({ projectId, bindingDigest: projectBindingDigest });
token = await guard.executionFence(token);
guard.assertAdmission(token); // Immediately before the native/write operation.
```

The token distinguishes `projectBindingDigest` from the runtime `bindingDigest`;
it also carries the lifetime, admission generation and complete ownership-set
digest. A new project changes the generation, so old tokens need a fresh fence.
The guard closes synchronously before invoking the durable close callback.
Pending work must recheck after every await. The inner callback must persist its
closed barrier and fence input, tool responses, first prompts, progression,
terminal input, lease renewal and preparation dispatch. It must not exit the
worker before its ACK, and must not wait for new outer admission/fence requests
queued behind that barrier.

Admission starts empty and appends at most 32 project bindings. Exact repeat
admission is idempotent; a changed binding for an existing project is rejected.
The initial composition retains one preparation intent per project per worker
lifetime. Admission precedes Git preparation: its digest covers exact owner,
workspace/build, project/repository/provider-account, task/request ID, base SHA
and original request digest. Lease ID and checkout incarnation do not yet exist
at that point. The worker must append their actual verified values to its durable
controller journal after preparation. A fresh stop decision independently binds
that final lease/incarnation, renewal sequence and task/attempt cursor; preparing
or missing final bindings defer elective drain. The initial admission digest is
never overwritten. Another preparation requires a new safe lifetime or a
separately reviewed admission-ID extension.

`authorizeAdmission` must independently resolve the installed controller's
current project/lease binding. Returning the incoming object without verification
is allowed only in a synthetic fixture. It is invoked both for admission and
each execution fence. Callback deadlines are bounded.

## Durable barrier and receipt

`authorizeDrain` must establish a **durable controller-wide closed-generation
barrier**, bound to the exact lifetime, full ownership set and current task/lease
state. It returns an independent decision ID for every project. A transient
"idle" lookup or a model/user-supplied boolean is insufficient. Any active,
uncertain or missing project decision defers the entire planned drain, preserving
other projects sharing that worker.

The outer serializes admission/fence requests with drain. It HMAC-signs and
fsyncs its close intent before asking the worker to close. The worker ACK binds
the full set, generation, ownership digest and unique barrier ID. Only then does
the guardian close its own admission and terminate/reap the entire owned tree.
Only kernel all-child `ECHILD` with `__WALL` yields a receipt.

The outer persists the receipt before guardian ACK/exit. It includes guardian
identity/lifetime and launch digests, project stop-decision IDs, the worker's
barrier ACK, worker PID and package/worker/Node hashes. It remains
`scope: managed_native_tree_only` and `cleanupAuthorized: false`. Server-side
challenge validation, receipt ingestion, external-writer reconciliation and
completion evidence are separate gates.

The journal uses a private HMAC key, atomic rename plus file/directory fsync and
an OS flock. A new launch accepts only a previously recorded successful `closed`
lifetime. An aborted, corrupt, crashed or otherwise incomplete lifetime blocks
restart; a replacement guardian's empty tree never certifies earlier processes.
The journal retains prior receipt history with bounded capacity. There is no
import/adoption or automatic receipt repair path.

## Current validation and remaining composition

The focused suites currently pass 27 tests: 22 guardian C/client cases and five
outer/worker cases. The outer fixture launches an actual Node worker, foreground
tmux server, a writing pane and a Python forkpty attachment. It checks the exact
kernel parent edges, refuses an active-project stop, confirms writes continue
while deferred, verifies the synchronous inner fence and then confirms all owned
processes disappear after ECHILD. Failed inner barrier, uncertain restart,
package-import tampering, replay and oversized channel frames are negative cases.

An intermediate fixture had a missing brace in generated JavaScript and timed
out before hello; no runtime inference or receipt was produced, and its owned
tree was aborted/drained. The fixture now syntax-checks its generated worker
before launching. This was a test construction error, not evidence of runtime
readiness.

The explicit essential `host` role requires a private worker channel and is the
only root role that accepts software profile plus Coder agent token/file/URL
environment. Owner session credentials remain rejected; other root roles retain
their original environment allowlist. This does not replace native namespace
credential-denial checks.

Still required before installed activation: actual software worker integration,
every inner admission/response fence,
outer/native/CLI/PTY composition with the pinned native runtime and local mock,
lease identity verification under the new ancestor, namespace denial of the
outer journal/key/control capabilities, crash/lost-ACK drills, and trusted
controller barrier/receipt channels. No new inference account is needed for
these local composition tests.

The separate CI terminal-helper failure remains unresolved: the original run
observed `indeterminate` after the unchanged 100 ms assertion wait. Exact failing
revision C/client code passed 150 iterations on Node24 and 150 on official
Node22.23.4, and both complete parallel runtime suites passed. Sanitized failure
reason, guardian exit code/signal and journal reasons are now included on test
failure. No production behavior or test timeout was relaxed; see the retained
CI diagnostic record for exact counts and provenance.
