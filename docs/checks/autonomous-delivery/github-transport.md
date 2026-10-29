# GitHub source transport and R2 checkpoint

2026-10-29. D07/D08 bounded code checkpoint. Source ingestion, manager execution,
release and jobs remain disabled. No Cloudflare resource was created or changed.

## Authority and publication

The controller-owned installed callback requests a challenge for an existing
task/step and supplies its registered native thread and verified checkout context.
The host signs a separate source domain. The model cannot request a producer,
pass/fail status, policy, PR number, GitHub URL or object key through this route.
The server derives owner, repository/account and current head from persisted
project/task/intent bindings. Its initial bounded configuration is
`HIVE_DELIVERY_GITHUB_TARGETS_JSON`, a server-owned map of exact task UUID to
`{pullNumber, policy}`. Missing configuration fails closed. Automatic trusted PR
discovery and shared manager policy resolution remain later integration work.

An append-only challenge binds action, nonce, exact target, full canonical policy
digest, registration, checkout binding and expiry (at most sixty seconds). Issuing
a challenge creates no acceptance evidence. The private collector invokes the
fixed sibling `github-evidence.py` using workspace-agent external auth. That helper
reads fixed GitHub endpoints with bounded pagination, response size and timeouts;
tokens never enter the snapshot or controller. Canonical snapshot signatures bind
provider IDs, run/attempt sequence, remote update times and head with the challenge.

Before an object write the controller rechecks active registration, current
source/policy, latest challenge and any consumed nonce in a Serializable
transaction. It repeats those checks inside evidence publication's transaction.
Nonce consumption and evidence/event publication therefore commit together. Exact
snapshot replay is idempotent. Another snapshot under a consumed nonce is rejected.
Revocation, replacement, changed policy under a reused version label, superseded
challenge, expiry and changed source fail closed. Refreshes have a ten-second
minimum interval per step. A signature proves origin only; production still needs
the native/signer isolation boundary.

The publisher retains its existing source-watermark rules: later required runs
supersede old evidence; same-version conflicts are unknown; policy/group changes
invalidate prior references. Accepted reports remain historical and cannot grant
release after invalidation. No source or manager request grants deployment authority.

## Durable bytes and restart

The R2 adapter accepts only server-derived owner/repository/head/digest keys. It
checks input digest/size, conditionally creates with `If-None-Match: *` and SHA-256,
then streams the entire stored object back through a bounded length/digest check.
It does not trust an ETag or metadata alone. It never repairs a conflict by
overwriting/deleting an object. A lost write acknowledgement can succeed only if
existing bytes verify. Corrupt or absent bytes cannot publish evidence. The
operation deadline is ten seconds and content is limited to two MiB.

The deadline does **not** cancel an underlying R2 write. A revocation or timeout
racing an upload can leave an object after the request fails. Its bytes are
preserved, budgeted as a possible write, and cannot become evidence without the
second transactional authorization. Application create-only writes are not a
bucket retention policy; live immutability requires verified bucket locks/IAM.
R2 documents conditional writes, supplied checksums and strongly consistent
read-after-write behavior in its [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

The collector's private HMAC journal persists challenge and canonical source bytes
before publication using atomic replacement plus file/directory fsync. Restart
reuses exact bytes and signs a fresh envelope; it reauthorizes at the server and
never returns a cached success. Lifetime/task/lease/source context changes and
tampering reject replay. Fetch and stream reads have an independent deadline even
for injected transports; stalled cancellation does not hold the caller forever.

The journal currently holds at most 32 request files of at most 1152 KiB each.
It deliberately does not evict records. Reaching the bound blocks collection.
Safe expired-record retirement under the unique installed-host lock is an explicit
remaining integration gate; continuous polling must stay disabled. The journal
must live in the installed controller's protected private state directory, not in
the model-writable checkout. No same-UID security claim follows from file mode.

## Validation and rollout

The [local evidence](github-transport-local/result.json) records 57 focused
domain/API/R2/PostgreSQL tests, ten collector tests, eight fixed-helper tests and
one composed PostgreSQL/workerd test. The composed test imports **canonical source
modules**, not an installed bundle. It commits a signed source publication through
real PostgreSQL and actual local workerd R2, drops the reply, recreates the
collector, and verifies one nonce/evidence publication with the same durable blob.
GitHub and Coder authority there are explicitly synthetic. Root's separate package
proof must verify module imports and the Python helper in the immutable package.

The local workerd harness also checks conditional creation, eight concurrent exact
replays retaining one object, restart persistence and corrupted-object rejection
without repair. Its temporary R2 binding has no `remote:true`; its private fixture
and credential directory are removed after the test. These checks do not establish
live R2 retention, billing, real account inference or production readiness.

Required activation work includes reviewed native/signer isolation, actual bundled
host composition, trusted shared manager policy resolution, bounded journal
retirement, live account/source and immutable storage proof, and acceptance of
production behavior by the owner. Background/external quiescence stays unknown and
writer holds remain. The [preview storage plan](r2-preview-plan.md) is review-only;
the current account cannot establish zero incremental cost.
