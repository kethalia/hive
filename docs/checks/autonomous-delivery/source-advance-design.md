# Trusted source publication under one checkout writer

2026-10-29. Design only. No GitHub/cloud mutation, broker implementation, source
transition, server-contract change or execution activation was performed here.

## Existing guarantees and remaining gap

`managed-projects.py` materializes a normal primary repository at
`~/projects/.hive-managed/github/<repositoryId>/checkout`, with a real `.git`
directory inside it. It pins checkout inode/incarnation, canonical HTTPS origin
and a configuration digest. The digest excludes only validated branch upstream
pairs; include, credential, filter, transport and other changes remain pinned.
Its validator rejects shallow storage, alternates, grafts, commondir and displaced
Git paths. Cleanup additionally checks nested repositories, linked worktrees,
local-only commits and other preservation conditions. These are valuable
lifecycle checks, not a continuous metadata write barrier.

`GitDriver` uses a small environment, disables inherited system/global config,
hooks, fsmonitor, redirects, file/ext transport and LFS smudging, and bounds time
and output. The token stays in a temporary private askpass context. Repository
identity/account checks come from provider IDs. This is existing preparation and
lifecycle transport, not an authorized commit/push/PR service.

`codex-native-namespace.mjs` currently mounts the projects root read/write and
grants the thread workspace root write access. It has no explicit read-only `.git`
projection. Thus do not claim model writes to `.git/config`, objects, refs/index
or hooks are prevented. Later configuration validation detects some tampering;
it does not remove the validate-then-use race for a privileged broker.

`github-evidence.py` is already a bounded fixed-origin **read-only** collector. It
rechecks account/repository/PR head and remote check/review revisions, and the
signed challenge/publication path binds source, policy, nonce and producer. Keep
that authority separate from publishing source. A created commit/PR is not passed
CI, an independent review or release approval.

Current database contracts intentionally pin `ProjectTaskIntent.sourceSha` and
`DeliveryManagerBinding.sourceSha` to initial checkout identity. The host's six
checkout fields return that original revision. Manager and source-collector
authorization currently require task SHA to equal binding SHA. Completion also
requires task, attempt and evidence SHA to agree. `changeSource` invalidates steps
and evidence and requests a safety pause; it is not a normal same-writer publish
transition. Updating only `task.sourceSha` would break these contracts and strand
the immutable producing attempt.

## Recommended first broker boundary

Start with one newly prepared checkout, one existing physical writer, one bounded
publication operation and one new branch/PR. Preserve the normal host `.git`
layout, but project its **entire directory read-only** into the outer native
namespace before any model work starts. The trusted host broker stays outside
that namespace and can update metadata. A directory projection lets native
read-only Git operations see subsequent broker ref/index updates; individual
file mounts would pin replaced inodes. Deny removal/replacement/alternate writable
aliases to the directory and disable CLI attachment/other input producers for the
pilot. New projects without the metadata projection cannot enroll silently into
an already running native namespace.

This needs an actual native root/child/resume negative-write proof, including
rename/unlink, nested namespaces, symlinks and alternate paths. It is not secured
by mode 0600 against the same UID, nor by the existing profile alone. An existing
possibly modified checkout is not adopted as trusted metadata. If read-only Git
inspection needs a refresh lock/index write, return a bounded broker inspection
instead of granting metadata writes. A separate private Git directory is a later
layout option; it would require changing today's explicit primary-`.git` validator
and lifecycle contract, so it is not the smallest initial change.

The broker accepts an installed-controller capability pinned to owner, provider
account/repository IDs, task, current attempt/cursor, registration/native lifetime,
checkout incarnation, managed lease ID/generation and cleanup renewal fence,
expected parent/source version, operation ID, fixed target base and branch prefix.
Revalidate before snapshot, each remote mutation and final database acceptance.
The model may propose bounded paths, commit message/title/body as untrusted text;
it cannot supply arbitrary Git argv, filesystem roots, URLs, tokens, hook/config
settings, producer, accepted SHA, base branch or pass/approval state.

Resolve agent-local GitHub authentication privately, as the existing helpers do;
never copy primary owner credentials. Recheck `/user`, repository ID and current
permission context. Read access does not imply publication permission. Require
appropriate repository Contents and Pull requests write access, without enabling
workflow mutation for the first pilot. Credentials never enter native arguments,
environment, source files, returned JSON or error logs. The GitHub documentation
defines the Git object/reference APIs and their permission requirements.
[Git database API](https://docs.github.com/en/rest/git),
[reference creation](https://docs.github.com/en/rest/git/refs#create-a-reference).

## Snapshot, commit, publish and PR journal

Use a host-private operation journal plus a small durable publication row keyed
by owner/binding/operation ID and canonical request digest. Persist exact phase
inputs before effects. Initial limits: at most 100 changed files, 1 MiB per file,
5 MiB total changed bytes, bounded base-tree enumeration, API requests, pagination,
responses and total deadline. Reject unsupported Git object formats; today's
contracts accept 40-character commit IDs. Limits are pilot scope, not repository
completeness claims. Controller-owned allowed paths and protected-file exclusions
must constrain the selected manifest; changing `.gitignore` cannot authorize
publishing environment/credential files. This is not a universal secret detector.

| Phase | Deterministic action and replay rule |
| --- | --- |
| Seal bytes | Resolve validated relative paths through directory FDs without following symlinks; reject special files, hardlinked files, path traversal, nested Git metadata and unexpected inode changes. Capture raw bytes, modes, explicit deletions and SHA-256 manifest in private storage. First pilot rejects symlink/gitlink/submodule/LFS changes and workflow/policy-definition edits. Unknown files are not automatically staged. Exact operation replay uses the sealed bytes, not a fresh live-tree scan. |
| Prepare commit | Transform the verified parent tree using that manifest. Use fixed local plumbing/raw object bytes; no `git add`, porcelain commit, worktree filters or repository scripts. Pin author/committer identity and timestamp once, canonical message, tree and exactly one expected parent. Persist the resulting commit identity before publishing. |
| Publish objects | Prefer a fixed GitHub Git-data adapter: upload required blobs/trees and commit under the verified repository, then verify returned object identities, complete tree and parent. This is the first pilot's push equivalent, avoiding a new generic credential-bearing Git push surface. Repeating the same immutable objects cannot authorize a different tree. Unexpected hashes or incomplete reads hold. |
| Create branch | Create only `refs/heads/codex/delivery/<task>/<operation>` from controller IDs. On a lost ACK or conflict, read that exact ref: reuse only if its object equals the journaled commit; otherwise hold. Do not update an existing different branch, force-push, alter main/tags, delete refs or auto-rebase. |
| Create draft PR | Persist the exact head/base/title/body before POST. Read back repository IDs, head SHA/ref, base and PR ID/number. A lost ACK triggers bounded lookup for that unique branch/base across states. Reuse exactly one matching PR; closed/merged, multiple, missing/ambiguous results hold rather than blindly creating another PR. No assumption of generic PR idempotency keys or exactly-once network delivery. |
| Accept source | Publish a signed broker receipt containing operation/manifest/tree/parent/head/ref/PR identities. Inside one transaction revalidate registration, writer, current attempt/source version and remote receipt provenance; append the source transition, invalidate stale evidence and bind the producing attempt's output. A receipt replay returns the same transition; changed digest conflicts. |

Git's raw hashing can bypass attribute transformations, and commit-tree takes a
specified tree/parents. GitHub supports raw blobs/trees/commits followed by ref
creation. Verify actual object identity rather than assuming local/API commit
serialization is identical; a mismatch is a hold, not an accepted source.
[hash-object](https://git-scm.com/docs/git-hash-object),
[commit-tree](https://git-scm.com/docs/git-commit-tree),
[GitHub tree objects](https://docs.github.com/en/rest/git/trees),
[GitHub commit objects](https://docs.github.com/en/rest/git/commits),
[PR endpoints](https://docs.github.com/en/rest/pulls/pulls).

This create-only publication deliberately avoids claiming a compare-and-swap API
for updating an existing remote branch. Subsequent commits to the same PR need a
separately proved non-force ref-update/recovery contract. Failed/expired/revoked
operations can leave unreferenced objects, a branch or draft PR already created.
Record and reconcile those effects; do not delete user-visible remote state as
implicit rollback. Remote writes never occur inside a database transaction.

Live model/background writes do not make a snapshot a globally frozen worktree.
The broker commits exactly its sealed manifest and verifies that immutable tree;
independent checks/review must run against that published head. Later dirty bytes
remain preserved for later work and cannot change the sealed operation. Advancing
HEAD/index through the broker must not checkout/reset or overwrite those bytes.
No PID/background/external quiescence is inferred from capturing a commit.

## Minimal source model change

Keep initial intent/binding SHA and physical writer lease/incarnation unchanged.
Add one append-only `DeliverySourceRevision` record per accepted publication with
owner/task/binding composite FKs, previous revision/version, input and output SHA,
tree/manifest digest, producing attempt, broker operation and provider/ref/PR IDs.
A task points to its current revision and retains `sourceSha` as the current
acceptance head. Existing attempts retain their immutable **input** `sourceSha`;
the producing attempt gains an optional owner-scoped `outputRevisionId`. This is
a trusted publication association, not a claim in the completion report.

Introduce one shared persisted-source resolver used by manager, native observer,
completion, GitHub transport/policy and progression gates. It checks the unchanged
physical checkout tuple separately from the task revision chain. For a producing
attempt, its accepted target is the verified output revision; otherwise it is its
input revision. The completion's source and all verification evidence must match
that target. Do not edit old attempt/native bindings to claim execution at a SHA
that did not exist when they started. Native command exit remains execution
metadata; independent checks must attest the output head.

The host managed receipt must likewise distinguish its immutable lease/base
revision from the broker-accepted current HEAD/publication version. Preserve lease
ID/generation, incarnation and initial controller request; persist the new head in
the broker/managed journal with its source-transition receipt. Renewal must validate
both references rather than silently treating the old `revision` field as the
new HEAD. Update only protected Git metadata through an expected-old ref/index
operation; preserve dirty worktree bytes. Cleanup later needs the verified latest
head plus actual cohort drain, not the old base SHA or this publication receipt.

An implementation attempt can therefore publish while logically running, then
complete only after applicable GitHub checks/review attest its output commit.
This avoids a pre-PR deadlock: publication is not itself step success, and today's
controller policy still requires checks/review for `implement`. Subsequent claims
use the newly accepted head. The signed host source context must carry the
persisted revision ID/version separately from the original six checkout fields;
no manager-provided head is authoritative. Parent/child native provenance and
same-writer progression checks must learn this explicit input/output distinction.

The acceptance transaction advances only from the exact expected source version,
atomically invalidates prior-head CI/review and eligibility, and emits immutable
event/notification records. Preserve previous reports/outbox as historical receipts;
they cannot authorize release at the new head. Do not reuse `changeSource`'s broad
supersede/block semantics for this normal producing-attempt transition, and do
not exempt external/foreign source changes from those safety holds.

Populate the collector target from the verified broker PR receipt plus existing
controller-owned full policy, rather than asking the model to edit
`HIVE_DELIVERY_GITHUB_TARGETS_JSON`. Existing collector expected-head/repository/
account/rerun/review checks remain useful unchanged in substance. Prior challenges
and in-flight old-head uploads cannot publish current eligibility after transition.

## Callback and storage hazards to test

The broker must own configuration continuously, not merely compare it once. Run
absolute trusted Git/executable paths from a private cwd with a fresh explicit
environment and fixed git-dir/index/object paths. Keep includes, hooks, fsmonitor,
credential helpers, URL rewrites/pushurl, SSH/proxy commands, filters/LFS,
external diff/textconv, editors/pagers, signing commands, replacement objects,
alternates, grafts, linked worktrees, sparse paths and recursive submodules outside
the executable surface. Disable automatic maintenance/GC in bounded operations.
Do not use `--path` hashing or read model `.gitattributes` to transform bytes.
Fixed HTTPS GitHub API routes reject redirects; API response URLs are not followed.
Git's hook/configuration mechanisms explain why sanitizing only the commit
message or `core.hooksPath` is insufficient.
[Git configuration](https://git-scm.com/docs/git-config),
[Git hooks](https://git-scm.com/docs/githooks).

Required acceptance tests before activation:

- Actual native root/resume/child attempts cannot mutate or replace `.git`, refs,
  objects, hooks, config/index, mount aliases or protected broker journals, while
  ordinary source editing and read-only status/diff still work.
- Malicious config/include/filter/fsmonitor/helper/diff/signing/alternate paths
  never execute or receive credentials; filename tricks, symlink/hardlink races,
  ignored secrets, unsupported storage and oversized snapshots fail closed.
- Mocked remote object/ref/PR APIs exercise deterministic identity, lost ACK at
  every phase, duplicate calls, changed request digest, account/repository switch,
  revoked write permission, unexpected branch/PR movement and partial effects.
- Real PostgreSQL fresh/upgrade and concurrent acceptance prove one source-version
  winner, owner/attempt/output FKs, no evidence reuse across heads, stale-challenge
  rejection, immutable input/native/report/outbox history and original writer hold.
- A composed local pilot edits files, seals/publishes to a fake provider, accepts
  the new head, independently checks that exact output, completes the producing
  step and continues on the same native writer. Deliberate later workspace edits
  cannot change the accepted tree or acquire release authority.

Only after these checks and a separately reviewed live mutation plan should a
bounded real commit/ref/draft-PR proof run. Real CI may incur account usage; this
design does not authorize that test, deployment, merging main or paid resources.
