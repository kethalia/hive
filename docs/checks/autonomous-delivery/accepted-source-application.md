# Protected accepted-source application

This is an **inert internal composition**, not an installed source-application
authority. `ManagedProjects._apply_accepted_source(...)` imports the new
`managed-source-apply.py`. No dispatch/CLI operation, environment flag, public
endpoint or host factory calls it. All validation uses task-owned local Git
fixtures; no provider writes or account inference occur.

## Required authority and ordering

The caller supplies three capabilities as installed objects, never request fields:

1. `authority.verify(physicalExpected, operationId)` independently authorizes the
   protected metadata producer and validates freshly signed accepted-source facts.
   The new read-only `/source-publication/state` endpoint can supply those facts;
   it explicitly grants neither publication nor execution permission. Its
   response alone, a prior publication receipt, and a local HMAC journal are
   insufficient. The server application reservation/factory is still missing.
2. `input_barrier.enter(physicalExpected, operationId)` returns a durable hold with
   `verify(expected, operationId, producerOrNone)` and `complete(expected, source)`.
   The installed factory must prove the actual manager root is terminal and
   known-child, observer, command, CLI and input work has drained. Late or unknown
   writer facts retain the hold. There is **no waiting-tool or mid-turn exemption**.
   The hold also prevents another source operation. It is separate from physical
   cleanup/quiescence authority and cannot claim unknown background work stopped.
3. `objects.read_object(kind, oid)` supplies the sealed broker's exact immutable
   object bytes. No path or URL is accepted. Type, Git object ID, commit parent,
   target tree, depth and byte limits are rechecked before HEAD changes.

`physicalExpected` contains project/repository/preparation-task identity, lease
ID/generation, immutable physical `revision`, checkout incarnation/inode pins and
the previously applied source context. The preparation task is not silently
equated with a model-selected delivery task: the trusted adapter must bind the
exact owner/manager/delivery-task/operation scope before normalizing server facts.

The normalized verifier result has exactly:

```text
operationId, sourceContext{revisionId,version,headSha},
previousSourceContext|null, parentSha, treeSha, manifestDigest,
metadataIdentity{checkout:{device,inode},git:{device,inode}},
producer{runtimeId,runtimeGeneration,admissionId,admissionGeneration,
         producerDigest,checkoutIncarnation,barrierGeneration,
         metadataPinsDigest,metadataPolicyDigest,namespaceReceiptDigest},
expiresAt (seconds, fresh and at most 30 seconds ahead)
```

The whole seven-field server admission tuple and opaque metadata digests are
retained. `metadataPinsDigest` is not recomputed from just the two inode pins.
Every normalized response is copied before comparison, so mutable callback
objects cannot rewrite earlier authority. The producer tuple, predecessor and
target remain immutable across recovery; only factual freshness may refresh.
Changed admission/lifetime/barrier generation holds rather than adopting a new
producer. Historical accepted output never authorizes rollback.

## Metadata transaction and recovery

The helper takes the existing managed writer lock and verifies the active lease,
signed receipt, checkout provenance and independent input barrier. It opens and
retains checkout, `.git` and private operation directory FDs. Git receives only
the pinned `.git` FD; fixed HEAD/index links, reads and renames use directory FDs
and no-follow operations. Callback/path revalidation adds refusal checks; it is
not the basis for redirectable pathname writes.

The signed managed receipt records a durable `sourceUpdating` intent. Sealed
objects are verified/imported and fsynced. Original index bytes are preserved
privately. A candidate index is built using `git read-tree -i -m old new`, without
`-u`, filters or worktree commands. Every preexisting staged difference must keep
its original mode/object/deletion in the candidate. Nonoverlapping staging is
preserved; overlapping changes hold. Ordinary SHA-1 index v2 is supported.
Unmerged stages, intent-to-add, assume-unchanged, sparse/split indexes and
unsupported extensions retain their original bytes for explicit review.

Candidate HEAD/index files are fsynced privately; their device/inode/content
digests enter the signed journal **before** hard-linking to the fixed Git lock
names. An existing lock is accepted only if its inode belongs to this operation.
Foreign locks are never deleted or adopted. The expected detached HEAD and index
digest are checked with both locks held. Branch-attached HEAD is unsupported.

The operation progresses through `intent → prepared → head_applied →
index_applied → applied`. HEAD and index rename atomically through the pinned Git
directory, with directory fsync before phase advancement. Recovery recognizes
only the original or accepted HEAD and original or candidate index, with the
recorded candidate inode for installed outputs. A third state stays held. Owned
private aliases are removed only after the metadata transaction; resulting HEAD
and index have one link. Original index recovery bytes remain private.

There is deliberately a conservative gap: if `read-tree` finishes changing the
private candidate index but the `prepared` journal has not been written, a retry
retains that candidate and reports `source_artifact_changed`. It does not adopt
or overwrite uncertain staging. A test covers this exact boundary. Phase tests
are not a claim of automatic recovery from every instruction-level crash.

After metadata application, `acceptedSource`, `sourceLastApplied` and cleared
`sourceUpdating` are persisted **before releasing the managed lock**. The helper
then freshly reloads the signed receipt, rechecks lease ID/generation/task/expiry,
physical base, incarnation, source/operation and actual HEAD/index, and repeats
independent authority/input checks. Only then does it complete the independent
barrier. No managed write or lock follows release. A rejected or lost release
acknowledgement recovers as completed-operation replay, without reapplying Git
metadata, and still requires fresh authority.

Managed inspection at this point describes physically consistent metadata; it
is **not execution permission**. The independent server/controller barrier must
remain mandatory for every command/admission. A test makes release fail after
the receipt is ready and proves the independent hold remains active. Source-aware
prepare/cleanup is explicitly unavailable; ordinary release still checks process
references, including the retained metadata FDs. New source operations must fail
the independent operation-bound hold. Final receipt reload rejects a concurrent
trusted lease release; renewal may extend the same lease but cannot change its
identity or source. The installed orchestration that enforces these conditions
is not wired in this slice.

## Managed lease and work preservation

The original `revision`, lease identity/generation and checkout incarnation never
become the accepted source head. `acceptedSource` is separate. Pending application
returns `checkoutVerified:false` and blocks renewal/release. Once applied,
renewal additionally requires actual HEAD and both private controller/supervisor
source contexts to match, while validating the original physical base. Legacy
records with no accepted source retain their existing behavior. A source-aware
lease release keeps the physical base; prepare and cleanup remain held for these
records until their separate lifecycle contracts are implemented.

No command resets, checks out, refreshes or writes worktree files. Tests compare
every dirty, ignored, untracked and symlink worktree entry's bytes/target, mode,
inode and mtime before/after, and preserve nonoverlapping staged contents through
two accepted source advances. There is no `reset --hard`, cleanup, remote fetch or
publication in this helper. Per-apply bounds include 60 seconds, 15 seconds per
Git subprocess, bounded live pipe output, 16 MiB index, 1 MiB imported object,
8 MiB object traversal and depth/count guards. The outer worker must retain its
own hard process deadline for trusted callback/kernel stalls.

## Checks and remaining gates

Run the focused local suites:

```sh
python3 -B -m unittest scripts/agents/test_managed_source_apply.py \
  scripts/agents/test_codex_project_lease.py scripts/agents/test_managed_projects.py
```

The opt-in scale test uses a task-owned real-home fixture with 1,977 files and
297 directories; it does not alter a real checkout:

```sh
HIVE_TEST_SOURCE_APPLY_SCALE=1 \
HIVE_SOURCE_APPLY_SCALE_EVIDENCE=/tmp/hive-source-scale-review.json \
python3 -B -m unittest \
  scripts.agents.test_managed_source_apply.ManagedSourceApplyTests.test_hive_scale_1977_files_297_directories
```

Results and exact source hashes are preserved in `source-apply-local`. Production
assembly, the independent accepted-source application reservation, terminal-root
barrier, controller/source-spool source-context update, artifact retention policy
and installed end-to-end acceptance remain separate gates. The new Python asset
must be explicitly included in a reviewed host bundle before any factory uses it.

The final focused run passed 56 cases with the scale case skipped by default.
The scale case passed separately twice on the real-home filesystem: 14.611 and
14.755 seconds for application (15.408/15.655 seconds including fixture setup).
The latter records matching before/after production source hashes. These are
bounded samples, not a worst-case storage-latency guarantee. Existing-blob/tree
lookups still use individual fixed Git subprocesses; a bounded batch optimization
can be considered separately if measured repositories exceed this budget. The
helper retains the hold on timeout rather than weakening durability or silently
restarting application.
