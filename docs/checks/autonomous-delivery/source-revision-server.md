# Immutable source input and accepted output

2026-10-29. Internal server foundation; no live provider transport, installed-host
changes, cloud migration, production service factory or new public endpoint.
Manager/native execution and production release remain disabled. The existing
schema-22 baseline fixture was retained; this slice uses a separate local fixture.

Migration `20261029120000_delivery_source_revisions` adds an append-only
`DeliverySourceRevision` chain. A task has a current revision pointer/version and
keeps `sourceSha` as its current acceptance head. Each producing attempt keeps its
immutable input `sourceSha` and can acquire one immutable `outputRevisionId` while
running. Owner/task/binding/step/producing-attempt composite foreign keys constrain
those relationships. SQL rejects revision update/deletion, input/output rewrites,
invalid predecessors and nonmonotonic current pointers. Existing rows remain
version zero with no output/revision reference.

The preparation intent, manager binding, checkout incarnation, physical lease
ID/generation and six-field checkout context keep their original base identity.
Source publication does not retire the physical `activeAttemptId`, clear the
logical cursor, mark execution quiescent or transfer the checkout to another
lifetime. The progression SQL guard compares a prior attempt's accepted output
with the next attempt's input; it does not rewrite the old input to make them fit.

## Separate publication authority

`DeliverySourcePublicationService` is internal-only and has no configured default
authority. It rejects fixture-broker receipts. Its injected verifier must
authenticate the whole publication receipt and provider readbacks; its separate
transaction callback must revalidate persisted producer authority/revocation and
scope. A manager boolean, evidence claim or supplied producer name grants nothing.
The service fixes the producer identity itself. No manager command can call it.

The strict verified publication includes owner/project checkout, active
registration/native lifetime, task/step/attempt, expected source revision/version,
logical cursor/native sequence, attempt lease generation, parent/head/tree,
manifest/operation identity and provider account/repository/ref/PR identities.
The permitted branch is derived from task/operation IDs. This schema is a verifier
output contract, not a publicly trusted JSON request or a live signature adapter.

Before accepting, the service reauthorizes the stored Coder binding, locks and
revalidates current registration/checkout/task, calls the producer's transaction
authority, and repeats registration validation. A fresh protocol-one running
implementation attempt, unexpired lease and exact expected source/cursor/native
sequence are required. Trusted child completion and matching requested/effective
settings must already be persisted; another running logical attempt rejects.
Reporting or publishing cannot manufacture successful child execution.

One Serializable transaction appends the revision, binds the producing output,
invalidates prior-head evidence, reopens only pure succeeded review/validation and
records immutable events/outbox notices. Informational `reported` history remains
informational; the producing attempt remains running. Final registration/lease
checks precede advancing the task pointer. A failed check rolls the whole change
back. No network mutation happens in the database transaction.

Historical implementation/understanding action completion is preserved for
dependency bookkeeping; invalidating its old check evidence does not schedule
implementation again. Its report cannot establish current-head eligibility.
Prior completed migrate/backfill/release/observe actions, migration-bearing
contracts or verification requiring change effects instead require reconciliation.
In that case the transaction accepts no source/output: it commits a task scheduling
pause and one notice, preserves completed actions, and rejects **after commit**.
Exact held-operation replay does not duplicate the notice; changed content
conflicts. There is no automatic external-action rerun or reconciliation bypass.

Exact operation replay repeats producer and registration authorization and returns
the same immutable revision. Changed semantic content under that operation
conflicts. Transport timestamps can refresh without changing the semantic digest.
An old accepted operation can return a historical receipt after later advancement;
`current:false,executionAuthorized:false` does not authorize execution or release.

## One persisted source resolver

`resolveTaskSource` and `resolveAttemptSource` distinguish physical base, current
task head, immutable attempt input and accepted output. Manager policy/commands,
native observations, repository completion/evidence, GitHub source publication
and logical continuation use them. Direct source drift that does not extend the
ledger fails closed; generic `changeSource` retains its invalidation/safety hold
role and does not silently join this chain.

Signed manager/native/GitHub envelopes accept outer
`sourceContext:{revisionId,version,headSha}`. It must be absent for legacy source
and is required and exact once a task advances. It is outside model command
payloads. Positive advanced-task claim receipts expose that persisted context and
the attempt's input SHA. The physical checkout fields remain unchanged. Historical
native journal bytes are never rewritten to acquire a newer source context;
stale/missing contexts reject. New native execution input after publication holds
the writer, while trusted root-boundary continuation remains possible. A new
older-attempt fact carrying an authorized current context also durably holds the
writer after multiple advances; it is not merely rejected as an old head.

Completion requires evidence and report source to match the accepted output when
one exists. Native provenance continues to describe the original input. The
controller-required GitHub policy uses the broker-recorded PR number and exact
output head, while its checks/review configuration remains controller-owned.
Publication itself creates no passed-check/review/migration evidence. A separate
trusted change/artifact evidence adapter remains necessary for criteria requiring
those kinds.

Historical report and notification projections use the attempt's immutable output
head, falling back to its input for legacy/nonproducing attempts. A later task
revision does not relabel old reports. Outbox joins bind output to owner, step and
producing attempt. Input history remains in the attempt/native records.

## Local evidence and activation gates

[Evidence](source-revision-local/result.json) records real PostgreSQL tests using a
separate signed fixture producer, synthetic native facts and the existing GitHub
source/policy adapters with synthetic snapshots. They exercise two implementation
source links followed by final validation: all three steps finish once under one
physical writer, preserving action completion and historical reports. Further
tests cover quality-only reopening, persisted external-action reconciliation,
duplicate/competing acceptance, lost-ACK replay,
changed replay, owner/scope/cursor/native-sequence/revocation/expiry rejection,
old evidence/step invalidation, stale source contexts, SQL history/FK constraints
and correctly labeled output reports/notifications. A configured check/review
publication for the accepted PR/output is required before its implementation
completion succeeds. This is not account-backed GitHub or composed native proof.

Fresh 23-migration and copied 22→23 upgrade checks preserve every prior table
digest, user/session/ciphertext/report/outbox history and 150 held writer anchors.
The baseline schema-22 database was read only for its dump; no applied migration
history row or remote database was rewritten.

Activation still requires an isolated protected broker and actual read-only `.git`
projection, trusted parent import, real credential/readback/signature authority and
durable retrievable receipt artifacts referenced by the stored proof digest.
The database stores the authenticated receipt projection/digests, not arbitrary
opaque caller proof bytes. No live verifier/archive adapter is supplied here.

In particular, host inspection, renewal and the read-only Git projection must
represent the **current accepted head** separately from immutable physical base
fields, without rewriting either meaning, overwriting dirty work or failing old
base/HEAD assumptions. A trusted current-source callback must feed outer contexts
and immutable host journals. That composition is unimplemented in this slice.
Single-output-per-attempt, create-only broker publication, same-PR updates,
reconciliation/retirement and actual whole-cohort cleanup remain separately gated;
no writer drain or production-release approval is inferred.
