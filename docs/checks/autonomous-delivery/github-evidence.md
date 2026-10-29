# GitHub evidence source and supersession

2026-10-29. Bounded D07/D08 implementation. Release, deployment and source transport
activation remain disabled. No GitHub settings or production data were changed.

## Collection and authority

`github-evidence.py` uses the workspace agent's existing Coder GitHub external-auth
connection. It captures one private token, checks the numeric account, fetches the
repository by its server-selected full name and verifies the stable repository ID.
A rename/transfer redirect fails closed until discovery refreshes the name. The
request accepts numeric repository/account IDs, one PR number and a full expected
head SHA; it accepts no URL, provider, credential or producer override.

All network requests target `https://api.github.com`. Only fixed read endpoints and
one fixed GraphQL review-thread query are used; redirects and proxies are rejected.
The collector fetches the PR, all bounded workflow runs for its head, jobs from each
exact current run attempt, check runs, formal reviews, summary comments and review
thread resolution. It re-fetches workflow/check/review/thread revisions and the PR
before returning, rejecting changes during the read window. Raw comment/review
prose, clone tokens and credentials are removed; only a whitelisted review marker
and body digests survive.

Limits: five pages of 100 items per collection, twenty workflow runs, 64 HTTP
requests, 1 MiB per response, 8 MiB total response bytes and a 45-second collection
deadline after the separately bounded token lookup. Exceeding a limit or failing
any page returns no partial successful snapshot. This is a stable read window,
not a GitHub transaction or a guarantee the remote state cannot change afterward.

The server adapter has no `ingest(managerSnapshot)` API and no default connection
factory. Its source connection must be supplied by a distinct trusted server
composition. The future host source channel must bind a controller nonce, owner,
registered host lifetime, stable repository/account, PR and exact head, verify the
host's signed response and revalidate/consume that receipt inside the publishing
transaction. `AuthorizedGitHubSource.authorizeTransaction` is mandatory. An
arbitrary JSON snapshot or a manager's normal signing/report scope cannot satisfy
this contract. That signed source channel is **not implemented or activated here**.

## Check and review identity

The [Actions attempt-jobs endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
provides current-attempt jobs. The adapter joins each job's fixed check-run URL to
the fetched check run, suite, exact head, expected name and GitHub App ID/slug.
Workflow `run_number`, `run_attempt` and remote update/completion timestamps order
observations; fetch arrival time never orders reruns. A newer queued run with no
matching job still blocks an earlier success. Duplicate names, mismatched app or
suite, unexpected event, skipped/neutral checks and unknown statuses cannot pass.
This first implementation supports GitHub Actions producers; unrelated check apps
need their own authoritative run-order adapter.

The installed Codex reviewer uses a hidden `codex-review-state:v1` issue-comment
marker. Its numeric user and performed-via-App IDs are both pinned, its code review
must name the exact head, and every bounded review thread must be resolved.
Unresolved outdated threads and outstanding formal change requests also block.
Multiple current-head bot markers, missing/invalid state and wrong producer IDs
yield unknown. Reactions and matching prose provide no acceptance evidence. The
marker was rechecked against PR399 through the connected GitHub app; it remains an
observed private contract rather than a documented stable provider API.

[Formal reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request)
use configured numeric reviewer IDs and current-head approval; the PR author
cannot independently approve their own change. Every configured review identity
is required. Reviews have no invented workflow run number: their sequence is zero,
attempt is one and their authoritative submission/comment-update time orders
current observations. Equal-version contradictions remain unknown. A thread's
resolution can change without a newer summary timestamp, so automatic recovery
from that contradiction requires a fresh source revision or explicit reconciliation.

## Durable publication

Before PostgreSQL writes, `GitHubEvidencePublisher` requires immutable source-object
storage and verifies its returned digest and length. The production object-store
adapter is mandatory and absent here; PostgreSQL tests inject an explicitly
synthetic in-memory artifact fixture. No R2 preservation claim is made.

Inside one Serializable transaction, the publisher revalidates source authority,
locks the owner/task, rechecks project/account/head and loads the prior durable
source watermarks. It aggregates **all configured required jobs per criterion**,
then creates check/review records, source event and watermarks atomically. The
manager cannot select one passing job to cover another required failing job.

A changed source version invalidates superseded evidence irreversibly. Older run
or retry observations cannot restore a pass; equal-version differing states publish
unknown. PR draft/closed admission has its own remote update clock. An identical
fresh observation adds a new receipt while preserving unchanged older references.
If previously passed evidence becomes pending/failed/unknown, or an already accepted
step loses verification, the transaction pauses the task and creates a durable
notice. Reports and their original outbox rows remain immutable history; their
invalidated evidence cannot authorize release. Scheduling stays conservatively
paused pending runtime reconciliation.

The task lock row is also written as a snapshot fence. Actual PostgreSQL tests
showed an unchanged `FOR UPDATE` lock alone can retain an older Serializable view
of separately written evidence rows. Bounded retry accepts only known Prisma
P2034 or the observed P2010 with PostgreSQL code 40001, including separate runtime
constructors. It does not swallow generic uniqueness or raw SQL failures.

Any failed fetch/publication is a blocked observation. Callers must not reuse a
previous eligible result after an error. Production merge/deploy still needs a
fresh authenticated observation, current policy, non-invalidated evidence and
separate release authority; an accepted report alone never grants that authority.

## Exact configuration observed

Read-only primary-account compatibility collection succeeded for PR402 at
`b0e278c0ec40490c3a5a9a2cce258d27c9ef5bf1`. This was the primary workspace's own
GitHub connection, not the test account or proof of the signed host source channel.

| Setting | Observed value |
| --- | --- |
| Repository | `1183966024`, `kethalia/hive` |
| Primary access context | GitHub account `62855857` |
| Actions App | `15368`, slug `github-actions` |
| CI workflow | `262356269`, `.github/workflows/ci.yml` |
| Image workflow | `270099685`, `.github/workflows/build-images.yml` |
| Release preflight workflow | `270099683`, `.github/workflows/release-preflight.yml` |
| Observed Codex reviewer | user `199175422`, App `1144995` |

The exact CI names include `Build / Lint / Test / Build`, `Build / Lint / Test / Format`,
`Build / Lint / Test / Lint` and `Migration preflight / PostgreSQL`. Optional skipped
jobs should not be silently added as required checks. The sampled head had failing
build/format/web-image checks and no authenticated current Codex marker, so it is
blocked; passing migration preflight does not establish a production migration.

Canonical check producer: `github-actions:<repoId>:workflow:<workflowId>:app:<appId>`.
Canonical bot review producer:
`github-codex-review:<repoId>:user:<userId>:app:<appId>`.
Formal reviewer producer: `github-review:<repoId>:user:<userId>`.
The database producer is a separately administered adapter identity generated by
`githubEvidenceProducer(repoId, fullPolicy)`, with its complete canonical policy
digest bound to producer, event and watermarks. Reusing a policy version label
cannot preserve evidence for a changed or removed requirement; such configuration
changes invalidate older policy references and pause scheduling. Full original producer
and remote IDs preserved in the immutable source object. The controller must pin
that identity and policy version when accepting report evidence. No default policy
or producer allowlist is enabled. No migration, artifact-build or production
observation evidence is inferred from a manager report or CI prose.

Validation evidence is in `github-source-local/`. Remaining gates are signed
source transport/nonce provenance, real immutable R2 storage, account-isolated
preview acceptance, actual-workerd publication concurrency and release policy
activation. Existing release mode remains disabled.
