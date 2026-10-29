# Proposed bounded R2 preview proof — not authorized or executed

2026-10-29. No cloud writes have been made. This plan needs explicit owner approval
for possible incremental cost before creation, binding, configuration or upload.
It does not enable manager execution, jobs, source ingestion or production release.

## Exact resource and scope

Use Cloudflare account `225177f82b9234ede14e897fe15e0cb5`. Create one new private
Standard-class bucket named `hive-delivery-proof-20261029-a4b19072`, only if fresh
metadata confirms that name is absent. Existing unrelated buckets are untouched.
No custom domain, `r2.dev`, CORS, public URL, preview URL, new paid plan, queue,
notification or scheduled job is enabled. The initial live proof uses authenticated
Cloudflare object APIs; it creates no public Worker. Local workerd already tests
the production R2 adapter. A later app binding requires separate reviewed config.

Before creation, the primary records its own task UUID, account ID, chosen bucket
name, planned lock expiry and operation/byte budgets. After creation it records
the returned creation date/location and fresh metadata, then preserves a sanitized
identity record in this repository. No specialist/handoff can create that record
or classify an existing bucket as disposable. If the candidate exists or any
identity field differs, retain it and stop; do not adopt it by name.

Use at most ten MiB total stored content and at most 100 Class A plus 100 Class B
operations, conservatively counting failed/ambiguous attempts and configuration
requests. The primary reserves each attempt in a durable private ledger *before*
sending it; a timeout never refunds an operation or presumed bytes. Stop before a
budget would be exceeded. No multipart uploads, automatic polling or extension.
Upload only task-owned synthetic/sanitized source metadata whose key, length and
SHA-256 were recorded in the primary before upload. Do not upload credentials,
private prompts or repository source. Use a small fixed set of object keys.

## Retention, proof and cleanup

The official API supports `condition: {type: "Date", date: <UTC timestamp>}`.
Set a single `delivery/` lock until **thirty minutes after actual proof start**,
recording that exact timestamp before the first upload. Read the lock back and
verify it, along with disabled public/custom domains, before writing objects.
If short absolute expiry is rejected, stop; do not silently substitute a longer
lock. [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
protect against overwrites/deletes, and their retention takes precedence over
lifecycle expiry. No existing lock is shortened or removed.

Configure a seven-day deletion lifecycle as backup on this newly created bucket.
It does not authorize leaving the experiment running. Lifecycle removal is
normally delayed after expiry and may take longer; it is not a hard deletion or
cost deadline. [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
also specify that deleted objects cease being billable.

The proof uploads a bounded object, verifies complete byte/digest readback, retries
identical creation, attempts a deliberately different overwrite and deletion while
locked, and verifies the original digest remains. Expected lock rejection is
recorded. It then stops all writes. Preserve sanitized API outcomes, object hashes,
lock/domain configuration and pre/post usage in the repository, without API tokens.

At the recorded absolute expiry, the primary obtains fresh account/bucket metadata
and checks it against its independent creation record. It inventories only this
bucket within the reserved budget; every object must match the task's recorded
key/digest list, with no unexpected objects or rules. After verifying the lock has
expired, remove only this task's expired rule if required, delete only its recorded
objects, verify empty, then delete the exact newly created task bucket. Preserve
cleanup responses and post-cleanup absence. Any unexpected object, changed
creation metadata, new/extended lock, failed verification or exhausted budget
retains the resource for owner review. No force-delete or unrelated cleanup.

This cleanup is part of the proposed creation authorization. Do not start the
proof without an active primary coordinator available through expiry. No new
unattended retention period or automatic cost extension is authorized.

## Cost and approval boundary

Read-only inspection found five unrelated buckets with a latest aggregate payload
of 27,623,050,782 bytes. This is a point-in-time metric, not monthly billable
GB-months. October operations were well below the published free allowances, but
shared-account future usage and billing entitlement are unknown. Subscription
inspection returned OAuth HTTP 403; no credential or plan was changed.

Current Standard rates are $0.015/GB-month, $4.50/million Class A and
$0.36/million Class B. Ignoring allowances/rounding, ten MiB held seven days plus
100 operations of each class is approximately $0.000523. R2 rounds aggregate
storage and operations upward to billing units: this small proof can cross one
GB-month and one million-operation boundary of each class, adding up to **$4.875**
within one billing period. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
defines these rates, free allowances and rounding.

Proposed owner approval is **up to $5 estimated incremental cost for this bounded
proof**, with pre/post usage checks. It is not a hard cap on the total shared
account invoice. Avoid a billing-period boundary; delayed cleanup, another period
or changed pricing needs a renewed estimate and owner review before extending
the experiment. A $0.01 guarantee is unsupported by the available billing data.
Until approval, retain the completed local proof and make no cloud writes.
