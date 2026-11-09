# D09 controlled delivery: local implementation checkpoint

The custom Worker upload workflow and publisher CLI described in the historical local foundation below have been retired. Application publication uses the existing connected Cloudflare Builds pipeline. Do not provision the former upload token, publisher environment or publisher configuration. The artifact parser remains because the D10 Workerd compatibility harness consumes it; it grants no upload or deployment capability. Installed legacy adapter retirement is tracked separately from this source-only setup removal.

This checkpoint is disabled by default and does not authorize the bootstrap main
merge or production cutover. Preview mode rejects GitHub `main`/`master` merge
bases. The future production mode additionally requires an explicit operator
enable flag and an enrolled production policy; no such configuration was made.
It creates no route, credential, scheduled job or deployed resource. D09 and the
epic remain open.

A deployment-owned release policy can preauthorize future work within one owner,
repository, account, target, action set, application-only risk class and
validity interval. It pins the observation configuration and window. The policy
catalog and the required source/risk, review/check, artifact and compatibility
verifiers are separate deployment authority; a manager cannot choose them. The
current code deliberately has no permissive verifier fallback. Database risk needs
an explicitly enrolled policy and catalog, an immutable accepted plan, and a
separately trusted deployment compatibility verifier; unknown risk is rejected.
The installed controller requires a separate, default-off database-observation
flag and a fresh independently produced provider observation for such effects.

The additive journal binds a release to the accepted source and repository policy,
pinned pre-release Worker baselines and the configured shared target. The target
lock survives process lease expiry and is shared across owners/repositories. An
immutable account/script membership prevents two differently named target groups
from simultaneously owning the same Worker; reassignment requires a separate
administrative design. An
action retains the exact bounded request before the effect and records its start
before network I/O. A lost acknowledgement is held without dispatching again.
GitHub's asynchronous 202 request UUID is persisted for read-only reconciliation;
a lost 202, preexisting request, missing UUID, already-merged response, and queue
entry without a verified merge remain unresolved. Cloudflare deployment responses
and readback must match the fixed account/script, exact 100% Worker version and
action marker. A second Worker is not prepared until a fresh scoped readiness
checkpoint verifies the first Worker and untouched baseline.

A release holds its target through observation and recovery. Observed successful
promotion is not itself health. The read-only producer verifies both current
Worker deployments before and after a private, separately authenticated readiness
probe and Cloudflare's `workersInvocationsAdaptive` requests/errors query. The
readiness route is opt-in after the preview gate, checks both app and service-bound
auth Workers and performs a bounded database `SELECT 1`; self-reported source and
artifact identities are not build attestation. Missing data, insufficient request
count, authentication failure, uncertain response, stale configuration or drift
hold. A fixed 503 or observed error-rate regression produces a durable regression
notice; high error sampling is not silently called healthy. Successful observation
requires the policy's elapsed window and fresh producer output. Adaptive sampling
and delayed ingestion limit inference: the configured settle delay is not a proof
that every invocation has arrived.

Recovery rechecks the currently deployed version, restores each promoted Worker's
pinned baseline version/source/artifact/config, and verifies both components again
before unlocking. An untouched Worker must still match its pinned baseline. A lost
response, unknown writer, changed baseline, missing compatible artifact, failed or
missing telemetry does not authorize another effect or unlock. Unknown-effect,
regression and recovery transitions create transactional Delivery events and push
outbox notices; exact observation replay is historical, not a new capability.

Cloudflare documents no expected-current-deployment compare-and-swap in its create
API. The policy designates a Hive release writer; provider read-before/read-after
and the target journal detect observed drift but cannot prevent an out-of-band
operator racing between those reads and the provider write. This accepted external
writer race must be visible at enrollment and validated for each target. Neither a
database lock nor an action annotation is a provider-level CAS. See [Create Worker
Deployment](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/),
[Workers deployment listing](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/),
[GitHub asynchronous merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously),
and [Workers analytics query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).

## Validation and remaining gates

Local provider doubles and isolated PostgreSQL exercise merge 202/restart, lost
Cloudflare acknowledgement, staged readiness, both-component and partial rollout,
failed smoke/metrics, baseline recovery, target fences, owner isolation, pause,
observation replay and outbox. The source seed and risk/evidence verifiers in the
local composition are synthetic. Test-only elapsed-window aging uses a temporary
isolated database with triggers disabled solely for fixture preparation. No live
provider action, preview health request, production mutation or provider approval
is implied by these tests.

The full Cloudflare build was attempted but stopped during packaging on a stale
`codex-acceptance-runtime.mjs` while the concurrent repair slice was in progress.
Both edited Worker entrypoints passed a narrower esbuild bundle check with the
generated OpenNext bundle and Prisma WASM left external. This is not a complete
packaged build or workerd acceptance; repeat after the repair package is frozen.
The attempted build removed the previous ignored `.open-next/hive-build-ready.json`
before failing. Regenerate it through a successful full build; do not reuse the
previous readiness claim against changed sources.

The schema-31 to schema-32 local upgrade was exercised against a database populated
by the existing release-candidate integration tests. With the stage-ready
constraint and target-membership addition included, 45 preexisting tables (22
populated) retained exact sorted-row hashes. A fresh local database applied all 32
migrations successfully. The upgrade was repeated with a copied migration set
that excluded the concurrent repair slice's later migration.

The draft reusable upload workflow isolates candidate build code in a job without
OIDC or Cloudflare credentials. A second job checks out the reviewed workflow
revision, installs its dependencies without lifecycle scripts, validates a bounded
artifact without executing it, and uses fixed deployment-owned targets. It asks the
controller for an OIDC-authenticated challenge, uploads versions and assets without
promoting them, verifies provider configuration readback, and submits an
OIDC-bound manifest. Its two identity variables come from the merged SHA and exact
component artifact digest; remaining provider configuration is matched against an
enrolled template. The controller also requires the exact GitHub run to complete
successfully. Local workflow inspection and HTTP doubles cover these contracts;
the workflow is not invoked or exercised on GitHub. The publisher authenticates
the bytes produced by the run, not a hermetic proof that arbitrary
candidate-controlled build scripts faithfully compiled the source.

A bounded GitHub file-list producer classifies paths against operator-owned
prefixes after verifying the PR repository, head and base on both sides of the
listing. A conservative rules producer reads strict classic protection, active
rulesets and their bypass actors, and rechecks the base and rules. Its preflight
compares the enrolled rules digest around the file inspection. Missing bypass
details, which GitHub may hide without ruleset write access, hold. These reads are
not yet verified against the installed account. Path classification represents the
operator's enrolled application-only scope; it does not prove arbitrary code is
correct or safe.

The default-off controller now mounts its OIDC-authenticated build routes and a
fixed-configuration cron handler. Its scheduler uses a durable cursor to find
eligible tasks, rechecks persisted exact-source semantic and repository evidence,
captures immutable short-lived source/rules/baseline facts, and opens a locked
release. A planner derives merge, staged promotion and recovery intents from those
facts and receipts; the lifecycle still reauthorizes every effect. Subsequent
baselines come from the last journaled healthy release, with operator-provided
bootstrap identities used only before the first one. The scheduled handler requires
two enable flags and the exact five-minute cron, neither of which has been
configured or deployed here.

Local PostgreSQL tests combine real signed semantic and repository evidence with
explicit GitHub, Cloudflare and health doubles through release opening, intent
creation and asynchronous merge reconciliation. Other isolated journal tests
exercise staged promotion, unknown acknowledgements, observation and recovery.
These tests are not a real hosted CI run, account permission proof, live provider
release, complete packaged Worker build or workerd cron proof. Account-backed
preview health/analytics, F06–F08, recovery rehearsals and independent review
remain required before activation. Production credentials and the user's
bootstrap merge/cutover remain outside this checkpoint.

Version and asset uploads are provider writes outside the release action journal.
A lost upload acknowledgement or failed attestation can leave unused versions or
assets. Retries can create additional unused resources; no exactly-once claim or
automatic orphan cleanup is made. Operators must monitor and clean up these
resources under their own provider policy before enabling the workflow.

The controller additionally requires a short-lived, single-use challenge and OIDC
attestation from an operator-enrolled reusable workflow revision. Its fixed test
job checks out the exact GitHub test merge and verifies both parents; it has no
OIDC permission or preview bearer. A separate fresh attestor job checks the same
merge/tree as inert data and verifies its own reviewed workflow revision before
obtaining OIDC tokens. The controller verifies the named test job and enclosing
run, protected check selectors, current base and immutable policy at opening and
again before merge. Candidate changes to the enrolled workflow, attestor, policy
and runner/dependency controls hold until a separately reviewed version is enrolled;
ordinary application test changes remain eligible. The approved workflow provides
the normal CI boundary: candidate code executes in the test process, so this is
not proof of arbitrary semantic correctness or adversarially tamper-proof tests.
Independent semantic and repository review gates remain required.

On 2026-11-05, the release suite passed 73 tests against fresh isolated local
PostgreSQL databases after all 37 local migrations were applied. This includes
20 PostgreSQL integration tests; provider interactions remained doubles. Review
also tightened the control-path classifier so test-like filenames cannot exempt
trusted authority or configuration, and all GitHub workflows and local actions
are excluded from candidate changes under this enrollment.

Database-risk plumbing now classifies enrolled database paths, pins the accepted
catalog and plan at opening, and verifies the exact risk class again before an
effect. A separate consumer checks the latest lease-bound D10 observation and
requires its old and new application digests to match the pinned baseline and
verified build. The deployment-owned observer checks both provider deployments
and configuration outside the database transaction, then persists the result only
if the release lease and receipts remain unchanged. A local fixture checks this
binding and drift handling, including authorization of the same in-flight action;
it is not a live provider or mixed-version application run. The new flag has not
been enabled or deployed.

This path is disabled until the deployment enables the separate tested-tree
producer, enrolls its exact workflow and run configuration in the release policy,
and configures the reviewed workflow's protected attestor environment. No live
account, workflow invocation or production cutover was exercised here.
