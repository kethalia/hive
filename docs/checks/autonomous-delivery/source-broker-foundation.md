# Source-publication fixture foundation

2026-10-29. Unactivated local foundation. The two new Python modules have no CLI,
host imports, HTTP implementation, credential acquisition or package integration.
Construction requires explicit `fixture_only=True`; this is a test seam, not
production authorization. Native `.git` remains unprotected by the current
runtime, so connecting these modules to native work or a live transport is blocked.

`delivery-source-broker.py` captures selected raw files through directory FDs with
no-follow/nonblocking opens. It rejects traversal, disallowed prefixes, protected
metadata/workflow/environment/key paths, symlinks, hardlinks, special files,
checkout replacement and file replacement during reads. The controller-owned
path policy and checkout device/inode identity are journal-bound. It is not a
universal secret scanner or globally atomic workspace snapshot.

Limits are 100 selected/deleted paths, 1 MiB per file, 5 MiB cumulative captured
bytes, 64 tree objects, 32 operation journals and 256 provider requests per
operation. The byte budget is checked before each sealed object is written.
Git input/output and subprocess lifetimes are bounded; subprocesses use absolute
Git, a private cwd, a scrubbed environment and no shell. Parent object import is
absent: only a bounded fixture-parent seeding method is available.

The broker never reads the workspace's Git configuration/index. A private bare
store with pinned configuration supplies parent objects. Raw hash-object,
mktree and commit-tree produce a commit from immutable captured bytes, explicit
deletions, the expected parent and once-recorded author/timestamp/message. Filters,
hooks, fsmonitor, signing, credential helpers, global/system config and inherited
Git environment do not participate. Storage alternates/grafts/replacement objects,
unexpected hook directories and changed store configuration reject.

The operation journal uses HMAC, mode checks, single-link regular files, atomic
rename, file fsync and parent-directory fsync under an exclusive lock. It binds
request, owner/task/attempt/writer scope, policy, manifest and deterministic commit.
Exact replay retains captured bytes after workspace edits/restart; changed request,
scope or policy conflicts. Unknown/temp, malformed, nonregular or tampered journal
files are preserved and hold the store. There is no pruning/retirement policy;
the 32-operation cap is an explicit fixture limit, not continuous polling support.

`delivery-source-provider.py` offers only fixed GitHub publication actions through
an explicitly injected fixture callback. It constructs fixed-origin paths, rejects
redirects, verifies account/repository/write-permission context before mutations,
and compares blob/tree POST response object IDs with locally constructed raw Git
object IDs. Separate GET readbacks verify the commit's parent/tree and the ref/PR;
this slice does not perform separate blob/tree GETs. Its
only ref mutation creates the deterministic `codex/delivery/<task>/<operation>`
branch. An existing different target is held, never overwritten. There is no
force-push, main/tag update, ref deletion, merge, review or check-status operation.

Ref ACK loss recovers only from the exact expected ref. PR ACK loss performs a
bounded head/base lookup across states and reuses exactly one matching open draft
with pinned repository IDs/head/base/title/body, followed by exact PR readback.
Missing, ambiguous, closed or mismatched results hold without a second PR POST.
Requests are durably charged before dispatch. Ambiguous persisted phases and
unknown object-write outcomes remain held for future reconciliation. Partial
remote effects are retained; no automatic remote rollback is attempted.

Every returned receipt says `fixtureOnly:true,freshAcceptanceAuthority:false`.
A cached `published` receipt is historical, not fresh current-head authorization.
No evidence, task/attempt outcome, source revision, writer lease, quiescence or
release authority is changed by this foundation.

The shared template scaffold includes copies of these source files. They are
excluded from the installed host runtime bundle and no runtime imports them.
The parent independently reviewed the foundation and reran all 19 tests;
[parent evidence](source-broker-local/parent-review.json) records that checkpoint.

The fixed `2026-03-10` header follows the existing repository helpers. GitHub's
[supported API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions#supported-api-versions)
lists it as supported, and the official
[tree creation example](https://docs.github.com/en/rest/git/trees#create-a-tree)
uses that exact header (checked read-only on 2026-10-29).

[Local evidence](source-broker-local/result.json) records 19 tests using real local
Git plumbing and a fake GitHub provider. The fake independently calculates Git
blob/tree/commit object IDs. Tests cover later edits, restart/replay, callback and
environment injection, path/type/size/race policies, journal tampering/FIFO/capacity,
policy/incarnation drift, concurrent-lock refusal, budgets, ambiguous phases,
wrong objects/parents/ref/PR scope, malformed responses, redirects and ACK loss.
No account-backed inference, credential or cloud operation is used.

Remaining gates: actual native read-only metadata projection and protected broker
authority, current registration/lease/source capability verification, trusted
parent import, a live transport with streaming body bounds/deadlines and sanitized
credential handling, exact real GitHub object-serialization proof, journal
retirement/recovery, and transactional source-revision/output-acceptance storage.
The injected synchronous fixture callback is not a preemptible live I/O adapter;
this slice does not claim bounded live network completion. Those gates require
review before runtime/package integration or any real repository mutation.
