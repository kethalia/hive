# Current-claim delivery status

The installed delivery factory now offers `hive_delivery` operation `read_status`
with **exactly `{}` as payload**. It derives the current task, step, attempt, lease,
input source, registration and manager thread from the protected native claim.
Before a claim, after a different root takes over, or after local authority is lost,
the read is unavailable. No model-selected task, repository, PR, policy or producer
is accepted. Existing native uncertainty holds remain holds.

The fixed `POST /api/delivery/host/status` route requires both existing manager and
delivery-execution deployment flags. It rejects browser Origin, query, compressed,
malformed and oversized input. The request is Ed25519 host-signed in the distinct
`hive-delivery-status-v1` domain; the response uses the fixed authenticated HTTPS
origin, not a newly invented response-signature protocol. Server authorization
rechecks Coder registration and current guardian metadata, then locks the current
manager/task/attempt. Read-only facts may describe an accepted source awaiting
local application. The endpoint never releases an application/input fence.

The bounded response includes current versions, pause/hold prerequisites, attempt
expiry, immutable physical base, accepted source and application phase, and evidence
IDs/observations for the exact current source and deployment policy. Coverage uses
the existing GitHub resolver's persisted challenge, publication watermarks, source
receipt and target checks, followed by current freshness/criteria checks. A cached
collector result or informational report cannot become verification evidence.
`executionAuthorized`, `publicationAuthorized` and `cleanupAuthorized` are always
false. Completion commands still independently authorize their writes.

The host validates the complete current scope, producer generations, metadata
digests and actual checkout/.git inode pins before and after the read. It caps the
request at 16 KiB, response at 32 KiB, outstanding reads at four, and total client
wait at eight seconds. Expiry is at most 30 seconds, with server authority and request
expiry caps; covered evidence further caps its freshness. Changed deployment policy
during the read rejects the result. Same-registration heartbeat extensions are
allowed without changing immutable scope. Revocation/close aborts the read and late
replies cannot produce a successful native tool result.

A successful factual read can schedule the existing read-only GitHub collector
only when the server confirms the same running claim, unpaused task, current accepted
source, canonical publication PR and configured policy. The tool returns immediately;
it never awaits the provider helper. Refreshes coalesce and start at most once per
60 seconds in this runtime. Every periodic refresh repeats the fresh status check
before obtaining the existing signed collector challenge. Missing policy/PR, pause,
changed scope, revocation and failed prerequisites stop polling. The challenge still
owns repository/PR selection. This adds no publication, merge or deployment effect.

## Validation

`delivery-status-local/result.json` binds 13 exact source files and the logs. The
final run passed 8 status PostgreSQL tests, 5 route tests, one actual factory/source
application composition, and 49 Node tests (one existing native opt-in skipped).
Typecheck passed. The composed proof uses the actual installed factory, scoped status
client, signed PostgreSQL services, protected Python publisher/application workers,
Git/managed receipts and outer journal readers. Native inventory/enrollment, GitHub
HTTP and independent CI producer remain explicit local doubles. It performs no
account inference or external provider writes and retains the physical writer hold.

The first status composition failed because the adapter compared a changing
registration expiry as immutable scope. `first-composed-failure.txt` preserves that
failure. The fix rechecks current validity while comparing immutable identity; a
same-lifetime heartbeat regression and the full composition pass. The failed private
fixture was removed only after its recorded test parent was absent and its tracked
helper groups were confirmed gone. Successful fixtures retain no live processes.

Reproduce with the repository's pinned dependencies and isolated local database:

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:35235/hive_delivery_test \
HIVE_INSTALLED_DELIVERY_EVIDENCE_PATH=/tmp/hive-status-parent-composed.json \
pnpm exec vitest run src/__tests__/lib/delivery/status.integration.test.ts \
  src/__tests__/lib/delivery/status-route.test.ts \
  src/__tests__/lib/codex-session/installed-delivery-factory.integration.test.ts \
  --no-file-parallelism --reporter=verbose
node --test --test-timeout=20000 scripts/verify-delivery-status-client.test.mjs \
  scripts/verify-codex-delivery-runtime.test.mjs scripts/verify-delivery-manager-adapter.test.mjs
```

## Installation and pilot gates

Parent integration must add `delivery-status-client.mjs` to the reviewed host bundle,
add the exact callback path to the deployment allowlist, and register the tests in
normal/compiled CI. Existing flags remain off; this checkpoint activates nothing.

An actual account pilot still needs a reviewed installed package/config and matching
guardian policy, current issuer/registration, isolated native authentication/model
catalog, and a fixed repository/task policy. Current source/evidence policy maps are
keyed by task ID and require manual pilot binding. General autonomy remains blocked
on repository-scoped trusted policy enrollment (D08), not a model-selected policy.
The publisher can create its canonical draft PR against a reviewed epic base branch;
independent CI and Codex-review identities must be configured. No main/prod promotion,
automatic merge, new repository or provider write is authorized by this status slice.
