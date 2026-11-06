# Fixed-inventory read-only Git metadata

This opt-in native namespace mode protects the entire `.git` directory for each
approved managed checkout. Normal working-tree writes and reads of host-updated
Git refs remain available. It changes no installed host flag, starts no account
inference and grants no publication, preparation or cleanup authority.

`metadataReadOnly:true` requires `executionMode:"isolated"` and an installed
`metadataAuthority` callback. Legacy configurations without a prior protected
launch keep their existing behavior. Once a protected launch has been journaled,
the same registry cannot fall back to an unprotected configuration. New project
enrollment in the existing protected native lifetime is rejected.

## Authority and physical identity

Before launch, the supervisor records a reservation-requested state and invokes
the callback once with the exact fixed project inventory. It accepts only:

```text
{runtimeId, runtimeGeneration, policyDigest, metadataPolicyDigest,
 nativeLaunchId, launchIntentDigest,
 approvals:[{projectId, repositoryId, taskId, leaseId, leaseGeneration,
             checkoutIncarnation, checkoutIdentity:{device,inode}, revision,
             admissionId, admissionGeneration, firstNative:true}]}
```

The callback must reserve first native execution atomically against independently
persisted controller authority, checking finalized checkout provenance and no
unresolved previous writer. It must not turn a replay or an uncertain outcome into
fresh authority. There is no default callback or installed factory in this slice.
The local fixture callback is explicitly synthetic. A scan, inode number, private
journal or `firstNative` boolean from a model/request is not sufficient authority.

The response is strict and must cover exactly the requested projects and leases.
Runtime/admission generations are positive integers. Device/inode identifiers are
decimal strings. The managed helper now exposes these from its existing signed
receipt in summary/inspect, after its existing provenance validation; replacement
of the checkout still rejects. No caller supplies filesystem paths.

The callback has a five-second bound. Timeout, invalid response or uncertain
startup leaves a durable reconciliation hold rather than retrying creation.
Approval and resulting directory pins are retained in the signed supervisor
registry. A later independently authorized new lifetime/reconciliation mechanism
is still required to reopen that protected registry; this slice proves native
thread resume within one approved lifetime, not automatic process restart.

## Mount construction

The trusted worker opens the managed root, each exact checkout and its `.git`
directory with retained directory FDs. Checkout FD device/inode must equal the
approved signed-receipt identity. `.git` is opened relative to that pinned checkout
FD. The namespace mounts:

1. The managed root read-only.
2. Each exact approved checkout read-write.
3. Each checkout's entire `.git` read-only.

The read-only parent prevents replacing or moving checkout mountpoints. The
read-only `.git` mount prevents replacing its root and writing any config, refs,
objects, hooks or other metadata. Cross-mount hardlinks cannot create a writable
alias to that metadata. Unapproved checkouts never acquire writable mounts.

A bounded scan rejects symlinks, nonregular files, multiply linked regular files,
foreign ownership/group-writable metadata, alternates, common/shared Git storage,
worktree markers and nested mounts. Limits are 8,192 entries, 256 MiB of aggregate
file sizes and depth 32, with streaming directory reads and a bounded mount-table
read. This scan assumes the independently authorized pre-native phase has excluded
previous/unmanaged writers; it is not proof that a concurrent external writer was
stopped. It never adopts unknown historical Git metadata.

Pinned bwrap supports `--bind-fd` and `--ro-bind-fd`. A fixed trusted Python
pre-exec opens only `/proc/<exact-worker>/fd/<retained-fd>` before entering the user
namespace, checks worker start/boot identity and directory device/inode, then
execs bwrap. This also works for tmux CLI attachment, which cannot inherit arbitrary
worker FDs directly. bwrap consumes and closes the metadata descriptors before
native execution. The worker→bwrap→monitor→native PID chain remains unchanged.
No extra shell, daemon, vendor binary or general FD transport is introduced.

Path checks are additional rejection checks, not mount-source authority. An actual
fixture replaces the checkout pathname after command construction; descriptor
mounts still expose the original approved checkout and metadata, while later
attachment validation rejects the changed pathname. Model commands cannot reopen
the worker's descriptors through proc aliases because the existing managed
permissions continue denying `/proc` and host credential/state locations.

The home-independent protection policy digest is
`6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b`.
Its canonical descriptor is exported as `METADATA_READ_ONLY_POLICY`; the digest is
separate from the deployment's complete runtime `policyDigest`.

## Actual pinned-runtime evidence

[Local evidence](git-metadata-local/result.json) records the pinned 0.165 runtime
against a local canned Responses server. Root, one actual native child and a
resumed thread each executed 11 negative checks: config/ref/object writes,
unlink, `.git` rename, checkout rename, hardlink, symlink alias, worker FD alias,
native proc-root alias and a nested user/mount namespace attempt. Working-tree
writes and metadata reads were positive controls. Same-thread tmux CLI attachment
succeeded. An atomic host ref update became visible to native Git without a new
mount. Hostile parent-directory cwd was rejected during native sandbox setup on
the read-only parent; it did not execute a rename there. The nested namespace
attempt failed; the test does not claim which nested kernel operation denied it.

Initial failures are preserved separately. Native startup timeouts occurred in
the first new fixture and again in a final parallel run in both the new fixture
and existing legacy namespace fixture (55/57 passed). Their cause remains unknown;
one earlier parallel run and the final unchanged sequential run both passed
57/57. This availability issue is separate from the passing protection checks and
remains an installed-pilot gate. A separate captured native launch became
TCP-ready in 612 ms. A subsequent real readiness failure was diagnosed:
native sandbox setup creates a `.codex` marker under cwd, so the newly read-only
managed parent was unsuitable. Protected mode now runs readiness in the first
approved writable checkout, keeping its Git submount read-only. Two later fixture
issues—an incorrect observer API and expecting a hostile-cwd command to run rather
than fail during setup—were corrected without relaxing protection. The observer
fixture's leftover runtime was stopped using its exact recorded pidfd identity;
its processes were verified gone, and fallback cleanup was corrected.

Reproduce with a fresh evidence filename:

```sh
HIVE_TEST_NATIVE_CODEX=1 \
HIVE_GIT_METADATA_EVIDENCE_PATH=/tmp/git-metadata-parent.json \
node --test --test-concurrency=1 scripts/verify-codex-git-metadata.test.mjs \
  scripts/verify-codex-project-supervisor.test.mjs \
  scripts/verify-codex-native-namespace.test.mjs
python3 -B -m unittest scripts/agents/test_managed_projects.py
```

Run actual native fixtures from the primary checkout, not a `/tmp` checkout, to
exercise real-home native alias behavior. Default tests skip native execution.
No production/template activation, external provider writes, account inference or
writer-quiescence/cleanup acceptance is implied by this proof.
