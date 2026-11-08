# Production semantic acceptance

Production health and task acceptance are separate decisions. The existing automatic
Builds release retains its target generation after platform health passes. An
activation step can use the existing native continuation and independent acceptance
engine only when the deployment's acceptance, production release and native production
gates are enabled and its current policy records owner cutover approval. These gates
remain off for production activation in Preview. Release and migration steps remain controller-owned.

The supported manager step is `review` or `validate`, in `activation_production`,
requiring independent `review` evidence. It uses the unchanged accepted source:
the candidate head and attributed deployed main merge SHA remain distinct, linked
by the immutable merge receipt. It creates no publication or output revision.

The evaluator receives the exact source manifest and a server-selected immutable
production artifact binding owner, task, release generation, source revision,
repository and release policies, original preview completion, tested merge,
fixed origin, main build UUID and provider check. Original observation bytes remain
pinned throughout the evaluator job. Later read-only observations corroborate the
same build without changing the model's input digest.

The observation window is a minimum between current samples. A later cron sample
is not itself a regression; sampled DB/auth smoke does not establish continuous
availability between probes.

Authenticated initial production claims and signed acceptance requests refresh
production observations outside SQL transactions.
The subsequent transaction rechecks the same fenced release, generation, policy,
source and build and a current observation. A changed serving build or failed probe
retains the deployment hold; it cannot be bypassed with an earlier healthy receipt.
The finalizer clears the deployment target only after full task evidence passes.
This is no Cloudflare write lock or CAS guarantee: external deployment drift remains
possible, and current reads provide bounded observations rather than exclusivity.

Production passes must cite supplied production material. Database/authentication
smoke does not establish arbitrary business behavior, a real account login, historical
session-key continuity or unobserved configuration correctness. Missing observations
remain `insufficient`; a production failure never grants an implementation repair
against the already deployed build. Database-changing releases need their separate
D10 integration and authority; this application-only checkpoint does not waive them.

Completion preserves the original physical writer hold and existing source-application,
native cohort, uncertain-acknowledgement and archive requirements. An independently
sealed successful step can later use the immutable finalization record for exact
completion replay and preservation. Historical verification grants no new execution,
publication, deployment or cleanup authority.

Local validation uses real PostgreSQL and signed manager/native/source/acceptance
protocols, with explicit local provider, health and independent model-output doubles.
Six composed cases cover claim through completion/replay, fresh serving drift,
insufficient/source-only production claims, disabled/foreign/paused/revoked authority,
and a real 30.1-second started-review delay past the initial health receipt's expiry.
The longer review preserves its input digest and refreshes actual serving evidence
before completion. A final boundary regression projects the real PostgreSQL clock
31 seconds forward only for the finalizer freshness query, after real completion
writes. Rejected authority rolls back the step, attempt, report and success event
and retains the target fence. This is source/runtime validation, not a live production cutover
or an account-backed semantic acceptance result.

Installed publication now accepts only `automatic-main-builds` (or remains disabled).
Legacy token configuration fails closed, and legacy upload challenge/attestation
endpoints return 404 without reading credentials. The pure historical engines and
artifact compatibility formats remain available to tests and retained history.
