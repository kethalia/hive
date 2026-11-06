# Native Preview controlled releases

The installed release controller now has a distinct `cloudflare-native-preview` branch. It uses native Preview deployment IDs throughout; parent production versions, two-Worker aliases, automatic Workers Builds annotations, and timestamps provide no native artifact authority. The old production adapter's `release_native_preview_unsupported` guard remains.

This source is disabled unless an operator enrolls the existing release flag, controller configuration, policies, read credentials, completed builder and protected publisher. It creates no provider resources or live permission. [Protected publisher enrollment and wire protocol](controlled-native-preview-publisher.md) describe the separate workflow runs and remaining workflow reachability prerequisite.

## Controller enrollment

`createInstalledReleaseController` selects the native branch only when `HIVE_DELIVERY_RELEASE_ENABLED=true` and `HIVE_DELIVERY_RELEASE_CONFIG_JSON.provider` is `cloudflare-native-preview`. Configuration must pass `nativeReleaseControllerConfigSchema`; unknown properties fail closed. The JSON contains public metadata and secret **names**, never secret values or credential digests.

| Configuration | Required authority |
| --- | --- |
| `target` | Exact account `225177f82b9234ede14e897fe15e0cb5`, Worker `hive`, enrolled Preview ID, branch `codex/delivery-system-design`, slug `codex-delivery-system-design`, origin `https://codex-delivery-system-design-hive.b00ste.workers.dev` |
| `externalWriterPolicy` | Literal `observed-drift-hold-no-atomic-cas`; automatic Workers Builds remains enabled |
| `github` | Exact repository ID, `kethalia/hive`, base ref `codex/delivery-system-design` |
| `builder` | Exact repository/owner IDs, caller workflow ID, `callerWorkflowPath` and reviewed `callerWorkflowBlobSha`, reviewed reusable build workflow path and SHA; only an unretried completed first attempt is supported |
| `publisher` | Exact repository/owner IDs, reusable workflow ref and SHA, independent publisher context SHA/ref, distinct native OIDC audience prefix |
| `publicConfig` | Approved main module, compatibility date/flags, CPU limit and placement, strict app-variable allowlist, asset configuration, inherited app-secret names including `HIVE_RELEASE_PROBE_SECRET` |
| `privateBindingRevision`, `compatibilityRevision` | Independent operator UUID revisions for private bindings and compatible database/runtime state; values cannot be certified through public readback |
| `riskCatalog` | Exact repository and reviewed application-only path prefixes; existing control-path exclusions remain |
| `authority` | Target/risk catalog digests, merge method, retained native baseline or `null` only for initial enrollment, existing tested-tree workflow/run authority |
| `observation` | `windowMs` (1 second–1 day) and at least two independently sampled observations |
| `bootstrap` | Optional separately approved first-baseline enrollment described below |

`HIVE_DELIVERY_RELEASE_POLICIES_JSON` uses the existing policy schema and owner/repository/source/evidence authorization. Native enrollment requires environment `preview`, exactly one target-resource digest, application-only risk, the exact target, authority, builder/publisher, and observation digests. It grants no production or model-selected target. Ordinary release opening still requires genuine accepted source, independent semantic/repository evidence, effective GitHub rules/checks, exact tested-tree attestation, and a compatible retained baseline. Merge dispatch freshly rechecks those tested-tree/provider facts.

Controller runtime credentials are `HIVE_DELIVERY_RELEASE_GITHUB_TOKEN` (read plus separately authorized merge capability), `HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN` (provider read only), and a 64-hex `HIVE_RELEASE_PROBE_SECRET`. The controller code issues only fixed Cloudflare GETs; the protected publisher alone receives the Cloudflare write credential. The controller and database roles remain operator-trusted and are not isolated from application code with the same database authority. No model/task payload chooses these credentials, controller origin, or native public origin.

The fixed publisher `controllerOrigin` must remain reachable while the candidate Preview is replaced. Candidate multipart configuration contains the enrolled application bindings, not privileged release-controller flags or credentials. Enroll an existing independently reachable trusted controller runtime; do not assume a self-replacing candidate can preserve receipt ingress. No such live enrollment is claimed by this source change.

## Durable protocol

Migration `20261106110000_native_preview_release_publication` adds four append-only tables: `delivery_native_release_artifacts`, `delivery_native_publication_grants`, `delivery_native_publication_receipts`, and `delivery_native_release_baselines`. Existing release/action identity, remote-reference and target-fence triggers remain. Both fixed runtime roles receive only SELECT/INSERT on the additions; canonical regrant provisioning includes all four. The migration never grants database CONNECT or changes the previous native-role connection barrier.

The artifact endpoint verifies publisher OIDC and independently reads the completed builder and immutable GitHub artifact. It prepares an action in the existing journal. Grant consumption locks the existing target/release/action and atomically commits `effect_started` plus a single immutable expiring grant before asset transfer or native POST. Reauthorization verifies the same publisher, exact grant/action/request, active target generation, release phase, pause/source/policy and deadline. It grants no redispatch.

Builder enrollment also pins the reviewed caller's exact Git blob. The run must be a `push` or `workflow_dispatch` on `codex/delivery-system-design` at the claimed source SHA with the exact caller path; the controller reads that file at the authenticated source commit, bounds and decodes its content, and recomputes the Git blob SHA. The run-path parser supports the [documented GitHub `@ref` locator shape](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run) only for that fixed branch or exact source SHA. Enrollment review must establish that those caller bytes contain only the approved pinned reusable builder/artifact-producing path and no alternate producer or skipped-success path. A successful mutable caller plus `referenced_workflows` alone is insufficient artifact provenance. GitHub artifact metadata also omits attempt identity, so latest-run first-attempt checks surround artifact verification; reruns require a fresh build run.

The authenticated returned deployment ID and provider creation time are retained before independent readback. Reconciliation verifies that exact deployment's approved public configuration, source/artifact markers, inherited binding names/types, and current ID around the read. Secret payloads are neither returned nor hashed. Marking the existing journal action observed performs fresh database authorization after readback. A persisted receipt permits later reconciliation without a second upload; a lost native POST ACK without a receipt stays held. Expired unacknowledged grants also become held. No current deployment, annotation, timing correlation, or successful automatic build substitutes for a receipt.

Health is explicitly `sampled-health-no-atomic-exclusion`, with `metrics: sampled-only`. Each authenticated app/auth readiness sample reads current native deployment before and afterward; acceptance retains the earliest and latest bounded observations across the configured window. Final evidence includes first/last sample digests, validated sample count, and an ordered sample-set digest, keeping the existing 32 KiB observation bound even after more than 1000 early samples. The immutable sample rows remain available for audit. It does not invent branch-level analytics or continuous exclusive ownership. A final current-ID mismatch holds acceptance. Automatic deployments may occur between checks because the provider exposes no atomic expected-current deployment condition.

## Initial baseline and recovery

Normal publication requires a retained accepted native artifact baseline. Its original deployment need not still be current. The separately recorded `expectedCurrentDeploymentId` is only the immediate concurrency witness, including an otherwise unverified automatic build.

The optional default-absent `bootstrap` object must explicitly pin `enabled: true`, owner/release/task/source-revision/artifact UUIDs, source SHA, artifact/archive/public-config digests, and a finite future expiry. `lifecycle.openNativeBootstrap()` accepts no caller-supplied scope. Under the target lock it requires that exact current owner/source and no accepted native baseline. The publisher independently requires protected `bootstrapEnabled: true`. This is a Preview-only operator prerequisite, not ordinary model/task publication permission.

Bootstrap follows the full completed-builder, artifact, atomic grant, upload, receipt, readback and health protocol. Recovery remains unavailable until health acceptance records its independently retained baseline. A failed or unknown bootstrap health sample durably holds the release; a later scheduler tick cannot silently accept it. An unknown initial upload remains unresolved and never supplies a known-good baseline.

Ordinary sampled regression can prepare a new recovery action only while the failed authenticated deployment is still current. Recovery reconstructs the retained baseline's exact archive from its original immutable GitHub artifact, checks private-binding and compatibility revisions, obtains a new one-use grant, and uploads those bytes as a new native deployment. Changed current ID, incompatible revisions, unavailable/expired baseline artifact, lost acknowledgement, or revoked authority holds recovery. It never repoints a production version or adopts an automatic deployment as a baseline.

## Local proof and remaining acceptance

The installed PostgreSQL composition runs with an explicitly local, dedicated database:

```sh
HIVE_NATIVE_RELEASE_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:55439/hive_native_release_test \
  pnpm exec vitest run src/__tests__/lib/delivery/release-native-preview.integration.test.ts
node --test scripts/release/native-preview.test.mjs services/migrate/test/preflight.test.mjs
pnpm typecheck
```

GitHub, OIDC issuer, Cloudflare and health transports are synthetic; actual controller, signatures, independent acceptance/repository/tested-tree verification, SQL triggers, journal locks, publisher archive parsing and native multipart uploader run. The suite includes baseline enrollment, normal source→merge→publication→sampled regression→retained-byte recovery, all grant/native-POST/receipt acknowledgement losses, fence/pause changes, SQL deadline rollback, external-writer drift, immutable history, secret-payload exclusion, and both runtime regrant matrices without changing CONNECT ACL.

Live workflow reachability, protected environment/ref enrollment, credential scopes, actual native multipart/readback behavior, initial operator baseline acceptance, concurrent automatic-writer sampling and recovery rehearsal remain unaccepted until an explicitly authorized real Preview pilot. This implementation does not activate production or satisfy final production cutover approval.
