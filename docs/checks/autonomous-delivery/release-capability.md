# Delivery release capability audit

Observed 2026-10-29, approximately 15:40–15:48 UTC. This is D01 evidence and a
D02/D03 recommendation, not release authorization or proof of production health.
Inspection was read-only against GitHub and local source. No GitHub policy,
production resource, database, workspace, or credential was changed.

## Source identity and scope

- Current profile: `HIVE_WORKSPACE_PROFILE=software`, `HIVE_IMAGE_VARIANT=cli`.
- Integration checkout: `codex/delivery-system-design` at
  `d02e55438caa10041b1fbdccec9033cf21c62fab` at audit start.
- Current main: `794d6e4c7488f4a4f8203100968e1f0b2e4b5f03`.
  `git rev-list --left-right --count HEAD...origin/main` returned `2 9`.
  The main-only commits include grid/mobile UI fixes and the merged Neon/official
  updater changes. Similar commit subjects do not establish identical history.
- No PR currently existed for the integration branch. Main remains the human
  merge/cutover target. This audit does not authorize a local merge or rebase.
- Workflow, Prisma schema, migration runner, and deployment-runbook paths inspected
  below had no content difference between the integration checkout and main.
- GitHub connector was used for repository metadata, PR reviews, and comments;
  `gh` filled the effective-rules and Actions inspection gaps.

## GitHub controls and observed signals

| Capability | Observed fact | Consequence |
| --- | --- | --- |
| Main rules | Effective rules from `GET /repos/kethalia/hive/rules/branches/main` require PRs and signatures, block non-fast-forward updates and deletion | Classic branch protection returns 404; that does not mean main has no rules |
| Review requirements | Both applicable PR rules require zero approving reviews; stale-review dismissal, last-push approval, code-owner review, and thread resolution are false | Existing GitHub rules do not enforce the delivery review contract |
| Checks | Effective rules contain no `required_status_checks` rule | A successful check run is evidence, but checks are not currently enforced by main rules |
| Bypass | Queried organization PR rule 14295606 and repository PR rule 14102640 report empty bypass actors and `current_user_can_bypass: never` | Do not infer permission to bypass either rule |
| Auto-merge | Repository metadata reports `allow_auto_merge: false` | Native auto-merge cannot be assumed available |
| Regular CI trigger | `.github/workflows/ci.yml` runs on PRs targeting main, pushes to main, and manual dispatch | An integration-branch push or child PR into integration does not automatically run it |
| Image trigger | `build-images.yml` runs on PRs targeting main and pushes to main | Integration previews need explicit workflow coverage and artifact identity |
| Codex code review | PR 399 has an authenticated bot summary tied to its full head SHA, but the formal review list is empty | Requiring a formal `APPROVED` review would miss the actual installed review signal |

The latest main revision has successful
[CI](https://github.com/kethalia/hive/actions/runs/40899932011),
[image build](https://github.com/kethalia/hive/actions/runs/40899932245), and
[release](https://github.com/kethalia/hive/actions/runs/40900611152) runs.
These establish real automation execution, not the deployed revision or user-facing
health. PR 400 was merged at `2026-10-29T15:16:44Z` even though its sampled PR
[CI](https://github.com/kethalia/hive/actions/runs/40899824062),
[image build](https://github.com/kethalia/hive/actions/runs/40899824123), and
[release preflight](https://github.com/kethalia/hive/actions/runs/40899822738)
conclusions were failures. The audit did not diagnose those failures. This is
direct evidence that those checks did not prevent this merge.

CI's successful `Build / Lint / Test / Build` job runs the configured build,
typecheck, and coverage commands together. Separate reusable Typecheck/Test jobs
are skipped because their inputs are empty. A policy must evaluate the actual
configured producer and job; treating every skipped check as either success or
failure would misclassify this baseline. Quality has additional optional skipped
jobs. The migration PostgreSQL integration job passed on the sampled main and
PR 399 runs.

### Review adapter input

[PR 399's summary](https://github.com/kethalia/hive/pull/399#issuecomment-6500367196)
was comment ID `6500367196`, authored by bot user ID `199175422`, with
`performed_via_github_app.id=1144995`, slug `chatgpt-codex-connector`.
The hidden `codex-review-state:v1` payload contained:

```json
{
  "code_review": {
    "commit_sha": "1e07a2128a43092404b15cde37ffc974301f12bf",
    "status": "completed",
    "has_any_findings": false,
    "has_unresolved_findings": false
  }
}
```

Implement this as a versioned, authenticated observation adapter. Pin the trusted
producer identity in separately administered policy; never trust matching prose,
reactions, or marker text posted by another author. Re-fetch the current PR head,
summary, formal reviews, and all paginated review threads before eligibility.
Persist comment ID/update time, producer IDs, full SHA, and a content digest.
Missing/malformed markers, changed producers, unknown statuses, unresolved
findings, stale SHAs, and inaccessible pages yield `unknown` or `blocked`, never
passed. Acknowledgements and reactions are not completion evidence. One sample
does not establish a supported long-term API contract for this hidden marker;
D07 must verify its ongoing behavior and exercise stale/review-unavailable cases.
The adapter can be implemented in observation mode before that gate passes.

### Existing release identity defects

Two discrepancies were confirmed by reading the real reusable workflows at `v4`:

1. `release-preflight.yml` only selects titles beginning `Version Packages`, while
   `kethalia/workflows/.github/workflows/retag-stack.yml@v4` creates
   `chore(release): version packages`. The current conventional title does not
   satisfy that predicate. Renaming a title is also not an authoritative release
   classification signal.
2. Preflight looks for `sha-<PR-head-first-7>`, but the reusable
   `build-stack.yml@v4` computes `sha_short=${GITHUB_SHA::7}`. On PR runs that is
   the synthetic merge revision; its separate `pr-<number>-<head-first-8>` alias
   names the head but still identifies that run's built manifest. Local preflight
   comments incorrectly describe `GITHUB_SHA` as the PR head.

Future preflight must use explicit release classification and the exact source
identity emitted by the build, including digest/provenance. A head tag alone is
insufficient. Keep PR head, tested merge revision, merged main revision, and
artifact digest separate. Reusable `v4` references are mutable inputs; record their
resolved revision with evidence and pin release-sensitive definitions as part of
the release work. No workflow was edited in this audit.

## Production, migrations, and lifecycle dependencies

The current release path is four GHCR images (`hive-web`, `hive-auth`,
`hive-terminal`, `hive-migrate`), Changesets, manifest retagging, and an external
GitOps/Argo CD rollout. `release.yml` waits for a successful main **push** image
build and passes that run's full `head_sha` to the reusable release. This avoids
selecting whatever main becomes later. It does not wait for the CI workflow.
Only packages reported published are retagged; the latest sampled release retagged
`hive-web` 2.31.0. The existence of a successful release run does not prove all four
images changed or rolled out together.

`docs/deployment.md` defines forward-only migration handling and compatible image
rollback. `charts/hive/templates/migrate-job.yaml` only renders the CNPG migration
Job when `cnpg.enabled`, ordered after database creation and before application
resources. Its delete policy removes successful and failed hook Jobs; preserve
the operation result/log evidence independently. Absence of a Job is not success.

`services/migrate/src/migrate.mjs` checks baseline/history before Prisma deploy.
Existing `services/migrate/test/migrate.integration.test.mjs` exercises fresh
migration, repeat deployment, preserved legacy data after explicit baseline
adoption, missing/failed history, custom schemas, and check-only behavior against
a disposable local PostgreSQL database. It is not a Neon migration or production
restore rehearsal. Never rewrite historical migrations. The existing
`20260814000000_remove_legacy_tasks` migration intentionally removes retired task
tables; create new delivery tables rather than resurrecting that model.

Existing durable schema contains User, CoderToken, Session, PushSubscription,
NavigationFavorite, VapidKeys, and NotificationSource. There are no durable
delivery, report, event, lease, or notification-history tables. NotificationSource
tokens authorize lifecycle callbacks and must not gain delivery/release authority.
`src/lib/push/event-queue.ts` deduplicates Redis jobs by source/event hash but
removes them after bounded retention. It does not provide durable step history or
an atomic PostgreSQL completion/outbox transaction.

Current server startup creates BullMQ notification, template-push, and token
rotation workers in `src/instrumentation.ts`. Current agent operations spawn SSH
and Coder processes from `src/lib/agents/workspace.ts`. These are explicit F02/F07
compatibility dependencies, not Cloudflare-ready capabilities. Cloudflare preview
must replace or bound these operations and demonstrate auth, transactions,
reconciliation, and streaming; an isolated build is insufficient.

Existing worktree and specialist cleanup implementations have focused test suites
(`scripts/worktree-lifecycle.test.py`, `scripts/workspace-lifecycle.test.py`).
They preserve unmanaged/user-owned source and authenticate task-created workspace
receipts. F06 must add durable artifact verification and active-consumer checks
for explicitly managed checkouts. Repository instructions, reports, and returned
artifacts must not replace private receipts or make a reused workspace disposable.
No lifecycle cleanup was performed by this audit.

Live cluster inspection, rollout, migration, or cutover belongs in Infrastructure;
real browser validation belongs in Browser Testing. Deployment ownership,
production GitOps repository/path, live telemetry access, observation interval,
recovery authority, database baseline, backups, and post-cutover write handling
remain unverified here. The final bootstrap merge and production cutover stay
with the user. A preview pass must not turn those pending milestones green.

## Minimal D02/D03 implementation contract

Keep domain state independent of Workflows retries. Start with one owner-scoped
task and a bounded sequence of steps; retain optional epic and stable repository
ID fields so F03/F04 associations can be added without changing event identity.

| Record | Minimum contract |
| --- | --- |
| Task | UUID, owner, repository provider/stable ID, branch, source SHA, manager thread/workspace binding, schema version, aggregate version, pause requested/effective, acceptance criteria |
| Step | Task/owner, kind, state, version, criterion IDs, dependencies, required evidence types, attempt count/budget, reopen generation |
| Attempt | Step/owner, unique ID, monotonic lease generation, holder, lease expiry, requested/effective model and effort, outcome/time; unknown usage remains null |
| Evidence | Owner, criterion IDs, producer identity, type/result, full source revision, artifact digest/environment where relevant, immutable object key and digest, observed time, invalidation reason |
| StepReport | Immutable completion-event/attempt binding, summary, difficulty/reason, issues/resolutions, evidence IDs, remaining uncertainty, next action |
| Event | Stable UUID, owner, aggregate ID/version, event/schema version, attempt/lease generation, accepted time; unique aggregate/version and owner/event ID |
| ExternalAction | Owner, action kind, exact target, idempotency key, request digest, expected prior revision, state, remote operation ID, reconciliation result |
| Outbox | Owner, completion event, recipient/channel, stable dedupe ID, attempts, next retry, status; unique event/recipient/channel |
| AcceptanceCriterion | Stable ID, requirement/task/step, phase, evidence contract, result, linked evidence IDs, observed revision/environment, blocker/next action |

Use composite owner bindings in foreign keys and server-side authorization for
every query/mutation; a caller-supplied owner ID never establishes ownership.
Freeze policy version/hash on each evaluation/action. Policy administration and
release credentials remain separate from manager/result submission credentials.
New installations default to disabled or observation-only release mode.

Permitted normal transitions:

```text
pending -> ready -> running -> succeeded
                     |  |
                     |  +-> waiting_external -> running
                     +----> blocked -> ready
                     +----> failed -> ready (budgeted new attempt)
nonterminal -> canceled (after in-flight effect reconciliation)
succeeded -> pending (explicit reopen, new generation, dependent invalidation)
```

Only ready steps with all dependencies satisfied can lease. `blocked -> ready`
requires evidence that the blocker cleared. Lease expiry fences old attempts;
it does not prove an external operation failed. Recovery reconciles any remote
operation before a new effect or attempt. Pause is orthogonal: stop scheduling,
show pause pending while an effect reconciles, and reach a safe checkpoint before
effective pause. Skipped criteria/steps require explicit policy reason and must
not be represented as success.

Accept a result only when owner, active attempt, unexpired lease generation,
expected aggregate version, source identity, and required evidence agree. In one
transaction, append the event, increment the projection version, finalize the
report, and insert outbox rows. Duplicate event with the same request digest
returns its prior accepted result; reusing its ID with a different digest is a
conflict. Stale-attempt submissions can be retained as rejected history without
changing progress. Reopening creates a new completion identity so a second valid
completion yields a new report/notice. New commits invalidate affected evidence.

Do not overload step success with release health. Track release progression
separately: `ineligible -> eligible -> merge_pending -> merged -> artifact_ready
-> promotion_pending -> deployed -> observing -> healthy`; failures/unknown remote
outcomes block further promotion pending reconciliation. Retain source, merge,
artifact, migration and environment identities at each boundary. A failed older
release may recover only if the current environment still matches its expected
deployment baseline. Deployment health and checkout cleanup have separate states.

### Acceptance phase schema

Use separate requirement rows for `implementation_preview` and
`activation_production`, with `pending | running | passed | failed | blocked |
skipped` results. Store what actually ran (`unit`, `simulated`, `integration`,
`browser`, `production`) and immutable evidence references. A passed preview row
cannot satisfy a production row. D09, D10, D13 and the epic remain open after a
ready bootstrap PR until their postmerge criteria pass. The evidence matrix must
also cover existing shipped features, not just new delivery UI fixtures.

Focused acceptance cases for the first persistence slice: owner-crossing reads
and references rejected; concurrent lease winners unique; cyclic dependencies
rejected; expired results fenced; same-event replay idempotent; conflicting replay
rejected; completion/report/outbox atomic under failure; queue outage followed by
replay; explicit reopen emits a distinct notice; source changes invalidate
review/check eligibility; interrupted ambiguous effects reconcile without repeat.
Run fresh and existing-schema upgrades before preview data is used. Live Neon,
external adapters, browser, and production observations remain separately labeled.

## Work that can proceed and gates

Proceed independently with domain contracts/tests, additive migration design,
disabled API/UI fixtures, the review/check observation adapter, the evidence
matrix, and versioned workspace reporting assets. Keep source ownership disjoint;
schema/transport integration follows the F02/F03/F04/F05 dependency gates. Running
the existing migration integration tests requires their disposable local fixture;
do not redirect their URL to live Neon.

Still blocking activation: supported shared live thread transport (F04), real
Cloudflare/Neon authenticated transaction/stream preview (F02), durable outbox/job
replacement (F07), managed evidence preservation (F06), data/secret migration and
write-safe recovery rehearsal (F08), authoritative current-head review/check
evaluation (D07), independently authorized policy enforcement (D08), and real
preview release/recovery pilots. The two existing preflight identity defects
must be corrected before using that check as eligibility evidence. None of these
gaps prevents implementing disabled, reviewable slices now.


## F01 implementation evidence (2026-10-29)

After this audit snapshot, main was incorporated through GitHub PR 401; the
integration branch advanced to `4d8b8219ebc3dd2ddef7aa21c6e665c29215a322`.
PR 402 is the draft bootstrap PR. The audit-start observations above are preserved
as historical evidence; they are not a claim that the branch remains behind main.

F01 now has a local implementation slice: one shared server-origin validator,
email/password-only web and service login contracts, removed URL input, rejected
browser overrides, response-origin checks, wrong-host existing-session rejection,
and pre-decryption checks for workspace token use and rotation. Login API requests
reject redirects. Existing user/session records are retained. Compose and the env
example require the same `CODER_URL`; this deployment's example is
`https://coder.kethalia.com`, with no hardcoded library fallback. The runbook
records coordinated deployment and existing-session behavior.

Validation performed against the local source, with synthetic credentials and
mocked external services:

- Shared auth package: 6 files, 50 tests passed.
- Auth service: 12 files, 144 tests passed.
- Web auth, login form, user client, rotation and push integration: 14 files,
  139 tests passed.
- `pnpm --filter @hive/auth typecheck`, `pnpm --filter hive-auth typecheck`, and
  `pnpm typecheck` passed.
- Scoped Biome checks and `git diff --check` passed.

These are local implementation checks. Real Coder login, existing production
session behavior, expired/revoked credentials against Coder, and browser preview
remain integration/activation criteria. No live configuration, session, credential,
workspace rollout, or production deployment was changed. F01 is not marked fully
accepted from mocked tests alone.


F01 review follow-up also hardened generic web Coder API and terminal Coder API
fetches against redirects, retaining explicit manual handling for the workspace
app auth redirect. A real loopback HTTP test verified the synthetic Coder token
header never reached a redirect destination. The terminal authentication boundary
now rejects origins returned by auth that differ from the configured deployment,
then returns the configured canonical origin; HTTP, PTY, audio and keepalive
consumers use that authenticated result. The installed `ws` implementation was
inspected: redirect following defaults to false and these WebSocket call sites do
not enable it.

Additional validation: three web Coder client/redirect test files passed 44 tests
(including overlap with the auth selection above); the entire terminal-proxy suite
passed 239 tests in 11 files. Terminal-proxy and root typechecks passed; six added
source/test files passed scoped Biome checks. The revised observation eligibility
contract was independently reviewed and its 23 tests passed after adding producer,
remote update, run sequence, and attempt identity ordering. No release authority
is attached to that pure evaluator.
