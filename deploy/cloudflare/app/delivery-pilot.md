# Delivery pilot preparation

`--delivery-pilot-candidate` is an explicit update-only option in addition to
`--inherit-preview-secrets --native-gateway-candidate --workspace-projects-candidate`.
It enables the software workspace's project tasks, terminal, paste, voice, agent bridge,
guarded manager and one deployment-owned repository policy. The existing read-only
workspace candidate remains unchanged. Release and database automation and epics remain off.

The private, mode-600 `HIVE_PREVIEW_DELIVERY_CATALOG_FILE` contains `schemaVersion`,
`model`, `effort`, a `guardian` object, and a one-entry `repositoryPolicies` array.
The guardian object has `packageManifestSha256`, `guardianElfSha256`, `nodeSha256`,
`protocol`, `policyDigest`, and `metadataPolicyDigest`; the operator obtains pins from
the reviewed installed image. The repository entry is validated against
`repositoryPolicyCatalogSchema`: exact Hive owner UUID, GitHub repository and account
IDs, canonical name, source policy, evidence gates and acceptance contracts. Its active
version is enrolled through the normal authenticated task-start flow, not by this file.

For the reviewed source-enabled pilot the catalog also contains an explicit
`acceptanceProducer` descriptor and `evidenceBucket` identity. Acceptance uses the
reviewed installed producer code digest, current protocol prompt/schema/permissions
digests, runtime 0.165.0 and gpt-6.1-sol/high with operator-supplied bounds. The evidence
bucket is the task-created `hive-delivery-pilot-20261105`, whose account, bucket ID,
creation time, private access and 1,800-second all-prefix retention lock must match a
fresh provider readback in the private `HIVE_PREVIEW_DELIVERY_BUCKET_EVIDENCE_FILE`.
The lock is retention, not automatic object deletion. The initial approved source policy
pins repository 1183966024, account 62855857, the dedicated Hive owner, branch
`codex/delivery-system-design`, and top-level prefix `docs`. The task intent targets
`docs/checks/autonomous-delivery/live-pilot/`; that subtree is an intent and review
constraint, not a path boundary enforced by this policy. No automatic merge is enabled.
The reviewed pilot budget is at most 10 MiB, 100 writes and 100 reads, under the user's
1 GB/$5 ceiling; a binding alone does not enforce a global storage or cost quota.

Preparation verifies the existing issuer public key and scope against fresh provider
evidence. Explicit `shared-host` mode lets voice and agent tools use the existing host
issuer secret only after exact origin, key ID, public key and single software-template
checks. Dedicated keys remain the default outside this candidate. The issuer is not
created, copied or rotated; Cloudflare's rename inheritance cannot duplicate it.
Workspace-read, voice and agent pins come from the committed software template.
Reconciliation gets a new dedicated secret in the private app secrets file.

`prepare-delivery-pilot-jobs.mjs <private-prepared-deployment.json>` packages a local
Wrangler dry run. `deploy-delivery-pilot-jobs.mjs <private-prepared-deployment.json>
<create|enable|disable>` checks the private prepared manifest, source and artifact,
fresh provider identity, and source-bound local Workerd proof. It defaults to check-only;
`--deploy` performs the explicitly selected transition. Create requires an absent fixed
jobs name and installs no cron. After each upload, independently read back provider state
and run `finalize-delivery-pilot-jobs.mjs <private-action-directory>` to retain the exact
script tag, creation time, deployment and version receipt. Subsequent actions require
that receipt and fresh matching provider evidence. Enable additionally reads the preview
DB as `hive_app_runtime` and requires the exact active, nonrevoked repository policy and
catalog digests, and requires `HIVE_PREVIEW_JOBS_STOP_BY_MS` no more than 30 minutes ahead.
The jobs Worker rejects pilot wakes outside that interval or from another cron expression.
This expiration stops dispatch; it does **not** remove the provider cron or its potential
invocation costs. Explicitly disable the schedule and verify provider readback afterward.

`disable-delivery-pilot-schedule.mjs <private-enable-receipt>` is a standalone recovery
path requiring a Workers Scripts Write `CLOUDFLARE_API_TOKEN`. It does not depend on the
checkout, app credentials, database or build artifacts. It reads current script identity,
active deployment and cron directly from Cloudflare. With `--disable`, it durably records
an attempt before removing only the exact pilot cron and verifies an empty readback. An
ambiguous attempt is retained; a later invocation reads fresh state and safely reports an
already-empty schedule or retries the same idempotent removal. Provider updates have no CAS,
so another authorized actor changing the Worker between readback and mutation remains a
race. No production merge, provider schedule, or user-facing deployment follows from a
local proof alone.

The terminal uses the Worker-only `HIVE_TERMINAL_WS_URL=/` runtime setting; other values
fail closed and Node deployments retain their existing public-variable behavior. After
building the exact committed source, run `node deploy/cloudflare/auth/run-local-integration.mjs
--app --terminal-pilot`. Real Coder terminal and manager lifecycle acceptance remain separate.
