# D09 release adapter prerequisites

Observed from the integration checkout on 2026-10-30 after the D08 review. This is
design only: no release code, schema, repository rule, credential, deployment or
production flag changes. The user still performs the bootstrap main merge and
cutover. D09 implementation/preview acceptance and production activation remain
separate milestones under `autonomous-delivery-epic.md`.

## Existing guarantees to reuse

- Accepted source revisions form an immutable owner/task/attempt chain; the
  physical checkout base and writer ownership remain separate. Source publication
  proves a commit/PR outcome, not release eligibility.
- GitHub collection authenticates fixed repository/account/PR/head and complete
  configured producer groups. Newer/ambiguous observations invalidate old proof;
  artifact bytes are digest-bound. `eligibility.ts` is explicitly observation-only.
- D08 freezes repository policy and intent/task projections. Mandatory repository
  checks cannot be removed by manager criteria. Semantic acceptance deliberately
  remains pending until an independent evaluator exists. No release path should
  convert that pending state into success.
- Reports/events/outbox are retained; pause and notifications have existing
  controller/read/UI paths. Reuse them for release notices instead of introducing
  a second notification system.
- `DeliveryRepository.claimStep` rejects release and production-phase steps.
  Production evidence validation requires production-mode evidence; no existing
  release executor can manufacture it.

## Concrete gaps against D09

| Requirement | Present state / missing boundary |
| --- | --- |
| Merge authority | AGENTS reserves merges for the user. The create-only source broker has no merge authority. No separately configured release credential/factory exists. |
| Current acceptance | D08 semantic evaluation is intentionally pending; real integrated manager/source/check/review pilot remains required. A successful generic CI run is insufficient. |
| Exact merge | No durable merge request/result record, provider reconciliation, expected-head request or resulting merge-SHA verification exists. |
| Base changes | PR-head equality alone does not establish that the current base was tested. Need effective strict branch rules/merge-queue policy and current tested-base identity. Historical branch-rule observations in `release-capability.md` are not a current verification. |
| Artifact identity | Existing image workflows use mutable reusable `@v4` definitions and short SHA tags; they do not supply this controller an immutable full-SHA→artifact-digest provenance record. |
| Existing release defects | `release-preflight.yml` still selects a title beginning `Version Packages` and claims PR `GITHUB_SHA` is head. `release.yml` follows image-build success without waiting for the separate CI workflow. These are current source observations, not a diagnosis of a live run. |
| Promotion target | Legacy release/GitOps promotes four images. The epic's app/auth/jobs Workers plus Neon require a deliberate target topology and ordered compatible versions/bindings. No adapter currently maps a delivery release to either target. |
| Remote effects | No release/action ledger, environment-scoped serialization, unknown-outcome recovery or operator decision record exists. Step-attempt and guardian writer leases are not deployment locks. |
| Health/recovery | No authoritative deployed-artifact reader, fixed smoke/metric producer, observation interval or baseline-CAS compatible rollback is connected. Successful deployment is not health. |
| Prerequisites | F06 preservation/cleanup acceptance, F07 live service/job parity and drain, and F08 data/secret/write-safe recovery rehearsal remain independent requirements. D09's first pilot excludes schema/backfill changes; D10 remains required for them. |

## Smallest useful next slice

Implement an inert release-candidate observer first, using the existing persisted
policy/evidence authorization rather than a parallel eligibility definition. Given
an authenticated owner/task and its current accepted revision, it derives the
exact repository, accepted PR, full head SHA, policy/binding digests, required
evidence IDs and their validity. A pending semantic evaluator, changed head,
paused task, stale/unknown evidence or absent approved release policy is a visible
blocker. The manager cannot supply evidence status, target, policy or credentials.
This slice can be tested locally without a provider mutation or schema change;
it must not return an execution capability.

Then add only the durable records needed for a bounded preview merge/promotion:

1. A release row binds owner/task, current source revision/version, approved policy
   digest, PR provider IDs/head, tested base/merge identity, exact environment key,
   and later immutable merged/artifact/deployed identities. Keep stage and health
   separate from the implementation step outcome.
2. A release-action row binds release/kind/target/request digest and unique
   idempotency identity; state records prepared, effect-started, observed or held,
   remote operation ID, and immutable receipt references. Persist effect-started
   before sending. Timeout or lease expiry is uncertainty, never permission to
   repeat an effect. Reuse append-only delivery events/outbox transactionally.
3. One environment lock serializes promotion through observation/recovery across
   releases sharing that target. A newer lock holder cannot reinterpret an old
   ambiguous promotion as safe to replace. No generic workflow engine is needed.

Use separate deployment-owned adapters for GitHub and the chosen deployment
target. Fixed provider paths and allowlisted repository/environment identities,
bounded requests, redirect rejection and private credentials are required. Do not
give release credentials to native/model processes or repurpose the host signing
key, notification token, publication grant or guardian metadata permission.

## Merge and artifact boundary

GitHub documents an expected-head `sha` for both merge APIs; the asynchronous API
provides a remote request UUID and distinguishes queued from merged results. A
202/queued response is not a merge. Select and probe the supported API before
implementation; never set a rules-bypass option. Head equality is not an atomic
base-branch precondition, so effective GitHub rules/queue semantics must enforce
the tested-base requirement. [GitHub merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)

Before the effect, reauthorize current policy, source/evidence, pause, provider
repository/base/head and permitted action inside the controller transaction;
persist the action identity. Recheck at the provider boundary. Remote changes
between these checks require provider-enforced conditions, not a claim that a DB
transaction freezes GitHub. Reconcile an unknown response through its remote
request/PR/merge facts; never blindly merge again or infer action ownership merely
because somebody merged the PR. Preserve a hold if attribution is ambiguous.

After merge, resolve the actual merge revision. Require a separately verified
build from that full revision and retain its workflow definition revision,
run/attempt, artifact digest and provenance. PR test-merge, PR head and eventual
merged source are distinct identities; GitHub documents that PR `GITHUB_SHA`
normally names the test merge. [GitHub PR workflow semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)

Promotion consumes immutable artifact identity, never whichever tag is current.
For Workers, that means approved exact app/auth/jobs versions and binding/config
digests with compatible DB baseline. For the legacy path it means exact image
digests and GitOps commit/target. The target choice must be settled before adding
the provider effect; no automatic dual promotion or implicit cutover.

## Preview acceptance before activation

- Local PostgreSQL concurrency/restart tests: one action winner, exact replay,
  changed replay rejected, expiry retains unknown effect, stale environment
  holder cannot ACK/promote/rollback, and source/policy/review invalidation wins.
- Provider doubles: moved head/base, rule rejection, queued versus merged, lost
  request ACK, somebody else's merge, mismatched build SHA/digest, partial
  promotion, pause during effect and unknown result all hold/reconcile safely.
- Controlled preview: exact real provider evidence and immutable deployment,
  fixed smoke checks, observation window, failure drill and compatible recovery;
  preserve the old baseline if a newer release has superseded the failed one.
- Migration-changing candidates remain blocked until D10/F08 evidence exists.
  No backup restore or schema rollback is inferred from application rollback.
- Recheck authenticated browser controls, completion notices and scheduling
  pause before any release permission is enabled. The controller cannot approve
  changes to its own release policy or amend AGENTS on its own authority.

This analysis adds no remote deployment requirement to the current code checkpoint.
It identifies the bounded next implementation and the outstanding real acceptance
work; it does not mark D09, F06–F08, D10 or the epic complete.
