# Managed checkout lifecycle evidence

Date: 2026-10-29. Scope: F05/F06 bounded prototype; concurrent writer isolation remains a D11 gate.
No startup/template activation, live GitHub clone, existing checkout cleanup, or production deletion
was performed. The production CLI cannot delete a checkout: it only records a cleanup request.

Sources:

- `templates/ai-dev-k8s/scripts/managed-projects.py`
- `templates/ai-dev-k8s/scripts/github-projects.py` (existing agent external-auth and metadata validation)
- `scripts/agents/test_managed_projects.py`
- `docs/autonomous-delivery.md` and `docs/autonomous-delivery-epic.md`

## Ownership and storage contract

The helper owns newly created directories at
`~/projects/.hive-managed/github/<numeric-stable-repository-id>`. The durable project directory
contains a separately removable `checkout` child, preserved interrupted staging directories, and
completion evidence. Existing primary clones and worktrees cannot be adopted. No caller path,
remote URL, provider other than GitHub, or alternate managed root is accepted. Production home
comes from the OS account database, not a caller-supplied `HOME` value.

Private state lives at `~/.local/state/hive/managed-projects` with an independent 32-byte HMAC key,
a signed root receipt, and signed per-project receipts. The helper neither reads nor replaces the
installed workspace/worktree lifecycle helpers' receipts or keys. Root and project device/inode
identity and private ownership are checked. Receipt writes use a private temporary file, fsync,
atomic replacement, and parent directory fsync. A nonblocking OS `flock` serializes helper writers
and is released on process exit. Receipt integrity protects provenance against substituted task
data; it is not a sandbox against arbitrary code already running as the same workspace owner.

The project receipt records schema version, provider, stable repository ID, credential-free
canonical URL, creation timestamp, project and checkout identities, Git configuration digest,
exact commit, preparation ID, staging attempts, last task, cleanup requests, lease generation,
and the current task lease. A lease contains an opaque ID, task ID, generation and expiry.
Lease expiry alone never permits takeover or cleanup. The same writer must present the current
ID and generation to renew/resume; a second task fails closed. Releasing the lease requires the
actual HEAD to equal the supplied full revision and no detected process references. Dirty files
can be retained on release, but subsequent clean preparation or deletion refuses them.

Native Codex home/history is outside the managed project tree. This helper never starts Codex,
creates a thread, moves native history, or changes the session transport. Session/project registry
integration must preserve that separation when F04/F05 are connected.

## Local CLI contract

Input is one JSON object on stdin, at most 8192 bytes, with no command-line arguments. Common
fields are `schemaVersion: 1`, `provider: "github"`, `repositoryId` (positive numeric string), and
`operation`. Unknown fields are rejected. Success is `{ "ok": true, "data": ... }`; failure
contains a fixed error code and exits nonzero. No raw provider responses or Git stderr are emitted.

| Operation | Additional fields | Result |
| --- | --- | --- |
| `prepare` | `taskId`, full lowercase 40-character `revision`; optional current `leaseId`, `generation`, `ttlSeconds` (30–3600; default 900) | Project/checkout directories, exact revision, status, renewed lease and preserved staging names |
| `inspect` | None | Recorded project state and current lease, allowing recovery after interrupted preparation |
| `releaseLease` | `taskId`, current `leaseId`, integer `generation`, actual `revision` | Updated state with no active lease |
| `requestCleanup` | `taskId` matching the latest task | `status: "controller_authority_unavailable"`, `checkoutRetained: true`, `requestId` |

Inspection reports the signed record and, for `ready` checkouts, verifies checkout inode,
Git storage/configuration and canonical remote before returning `checkoutVerified: true`.
It deliberately does not require clean source: unfinished edits remain readable and resumable.
Other states return `checkoutVerified: false`; they do not authorize execution.
An interrupted clone can leave a recorded checkout identity before publication completes. Always
use `prepare` with the inspected lease to reconcile it before launching a consumer.

For an already active task with unfinished edits, the manager should `inspect`, validate the
existing task/lease binding, and reuse that same checkout and native session. `prepare` is a
clean exact-revision operation, not a dirty-work resume operation: it rejects uncommitted work
without modifying the checkout or lease. There is no automatic expiry-based takeover. A future
supervisor resume operation must validate the live lease and checkout without silently resetting
edits or creating another clone; `inspect` alone is not a grant to a different task.

## Repository verification and Git execution

Each prepare resolves the stable ID through fixed `api.github.com/repositories/<id>` using the
existing `github-projects.py` agent-only external-auth boundary. GitHub's returned numeric ID,
pull permission, HTML URL and clone URL must agree. API redirects and environment proxy settings
are disabled. Canonical rename/transfer changes currently fail closed for explicit reconciliation.

Git uses the verified credential-free HTTPS URL. Agent auth is supplied through a temporary
private askpass helper and token file, removed when the Git call finishes. Tokens are absent from
command arguments, remote/config URLs and inherited environment. Coder owner session tokens,
OpenAI keys, inherited Git configuration overrides, trace settings and credential helpers are not
forwarded. System/global Git configuration, templates, hooks, fsmonitor, file/ext transport,
redirects and LFS smudge are disabled. Each Git subprocess has a 45-second deadline, a 2 MiB
stdout cap, suppressed stderr, and its own process group, terminated on failure. A GitHub metadata
response is capped at 1 MiB with a 10-second socket timeout; there is not yet an overall operation
deadline across all subprocesses or a streaming metadata deadline.

The exact requested commit is fetched and checked out detached. Reusing the same task/revision
retains the same checkout inode. A released checkout can move to a new exact revision only after
clean/process checks and fresh remote branch reachability checks for local refs, HEAD and reflogs.
Git configuration policy 1 pins a normalized digest and the canonical origin before commands
run in an existing checkout. Git's own config parser runs outside that checkout with includes
explicitly disabled. Only complete, unique upstream pairs are excluded from the pinned digest:
`branch.<valid-ref>.remote=origin` and `branch.<valid-ref>.merge=refs/heads/<valid-ref>`.
This permits a normal feature branch and `git push -u origin <branch>`. Changed remote/push URLs,
includes/conditional includes, credential helpers, hooks, filters, fsmonitor, other branch options,
duplicate/incomplete upstream pairs and non-origin upstreams remain rejected. There is no digest
refresh from caller configuration; receipts without policy 1 fail closed. Local bare fixture
transport is constructor injection in the tests only;
there is no production CLI option or environment switch to enable it.

## Interrupted preparation

The lease and staging inode are recorded before cloning. An interrupted unsealed stage is kept
as evidence and never executed or deleted. A retry verifies its signed identity and lack of process
references, then uses a new stage, with at most three attempts for that preparation ID. An unsigned,
missing, symlinked or substituted stage blocks recovery. Exhausted attempts require operator
inspection; the helper does not erase evidence to reset the budget.

A completed clone is journaled as `publishing`, including its inode, config digest and exact
revision, before its atomic rename to `checkout`. Recovery handles interruption on either side
of that rename without another clone. A filesystem/power failure during initial root/project
creation can leave an unsigned directory; it is retained and refuses automatic adoption.

## Cleanup authority remains unavailable

`requestCleanup` only records intent. It accepts no completion boolean, evidence payload,
controller key, deletion operation or test-mode switch. Production controller verification and
its authorization transport are deliberately unimplemented, so operational deletion stays disabled.

An internal Python test seam exercises the prospective validator with a separately keyed fixture
authority. Its signed evidence binds repository ID, task ID, exact revision, project/checkout
identities and the latest cleanup request ID. It includes a controller completion event/policy
version, immutable artifact object version and digest, and a production observation bound to that
same revision and artifact digest. Tests do not prove an R2 upload or production observation.

The validator requires all of the following before removing only the checkout child:

- No active task lease; unchanged HEAD, signed identity, canonical origin and configuration.
- No tracked changes, untracked files, ignored files or stashes. Legitimate ignored build outputs
  are conservatively retained; there is no recognized-generated-directory deletion exception.
- No same-user process cwd, executable, open file descriptor or mapped file under the checkout.
  Inaccessible same-user process metadata fails closed. The boundary does not cover a privileged
  process hidden from the workspace's `/proc` view.
- No mounts, linked worktrees, nested repositories, symlinks or special filesystem nodes.
- Fresh GitHub identity verification and remote fetch; every local ref, HEAD and reflog commit
  must be reachable from current origin branches. Tags-only or deleted-branch retention is
  insufficient and blocks deletion.
- Completion evidence persisted outside the checkout, followed by repeat clean/process/identity
  checks and platform support for symlink-resistant `shutil.rmtree`.

Project identity, signed receipts, completion evidence and interrupted stages survive fixture
checkout removal. A later preparation can rehydrate a new checkout; prior cleanup authorization
does not match the new inode or request. The helper lock coordinates cooperating helper calls,
not arbitrary concurrent owner processes: a real host supervisor must fence writers/consumers
during the final validation/removal interval before this internal seam can become operational.

## Executed checks

Run from the repository root:

```sh
python3 -m unittest scripts/agents/test_managed_projects.py -v
python3 -m py_compile templates/ai-dev-k8s/scripts/managed-projects.py
git diff --check
```

The 23 local tests use temporary bare Git repositories and isolated homes. They cover exact
revision/inode reuse, generation fencing, second-writer rejection, expired lease retention,
primary/history preservation, interrupted clone and post-rename recovery, bounded recovery and
stage substitution, disabled CLI deletion, independent fixture authority and wrong-revision
rejection, retained evidence and rehydration, tracked/untracked/ignored work, process cwd/open
file references, linked worktrees, mounts, symlinks, private receipt tampering, unpublished refs
and reflog-only commits, production credential/environment construction, real local feature
branch/upstream pushes through release and fixture cleanup, rejection of 14 unsafe/ambiguous
configuration changes, and preservation of dirty active-task edits and leases during inspection.
Inspection also rejects a replacement checkout at the same path and a changed remote. Process
enumeration in these fixtures is bounded to the test process and explicitly tracked real child;
this avoids unrelated same-UID nondumpable CI processes. Real cwd/open-file detection remains
covered, along with explicit inaccessible-process rejection. Production enumeration and its
PermissionError fail-closed behavior are unchanged; no runtime flag enables this fixture scope.

Next activation gates: independent review; versioned trusted helper installation; real GitHub
agent auth and canonical identity validation; controller project/session registry binding;
durable controller-issued completion/artifact/production evidence; supervisor quiescence fencing;
process and filesystem checks on the actual persistent volume; and D11 concurrent task isolation.
No cleanup or workspace startup integration should be enabled by this fixture evidence alone.
