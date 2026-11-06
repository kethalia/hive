# Controlled native Preview publisher

This source adds a protected byte-only publisher for the enrolled `hive` branch Preview. It is disabled until operator-owned workflow, controller, credential, and baseline enrollment is complete. It does not activate production, replace automatic Workers Builds, or establish a default-branch workflow listener.

## Workflow and credential enrollment

The two reusable workflows are separate runs:

1. A source build caller invokes `.github/workflows/controlled-native-preview-build.yml` at a literal reviewed commit SHA. The caller's source SHA is checked out and built without Cloudflare credentials, deployment environments, or OIDC permission. Its entire run must finish successfully. The immutable `hive-native-release` artifact contains only `release.tar`.
2. A separately trusted `workflow_dispatch` or `workflow_run` caller invokes `.github/workflows/controlled-native-preview-publish.yml` at a literal reviewed commit SHA. Its protected `hive-native-release` environment supplies publisher configuration and the explicitly mapped write credential. The job checks out that same reviewed publisher SHA, installs its pinned dependencies without lifecycle scripts, and processes candidate bytes without importing or executing them.

The controller independently pins the repository and owner IDs, builder caller workflow ID, builder reusable workflow path and SHA, publisher reusable workflow path and SHA, publisher context SHA/ref, and OIDC environment subject. Publisher identity and artifact source identity are different authorities. A running publisher run never substitutes for a completed builder run. The initial protocol accepts only an unretried first builder attempt, checking the latest run on both sides of artifact metadata verification: GitHub artifact metadata binds a run ID but does not prove a particular attempt. Start a fresh build run rather than relabeling an artifact from a rerun.

Builder enrollment also pins the exact caller workflow path and reviewed Git blob SHA. The verifier reads those caller bytes at the independently verified source SHA and recomputes the blob identity. Review must establish that this caller has only the approved reusable builder/artifact-producing path, with no alternate producer or skipped-builder success path. A successful run and a listed reusable workflow alone cannot attribute an artifact to a particular job; GitHub artifact metadata does not expose that job identity.

The publisher's environment and ref must prevent candidate-controlled workflows from accessing the Cloudflare write secret directly. Restrict and protect the publisher ref and environment, and admit only the reviewed publisher job. Merely placing a secret in an environment that arbitrary candidate jobs can request does not provide this isolation. The candidate Worker and builder receive no Cloudflare write credential. The installed controller uses provider read credentials; its code and database release-authority privileges are a separately trusted operator boundary.

These files are reusable workflows, not dispatch listeners. A new `workflow_run` listener on the unmerged epic branch is not reachable merely because its YAML exists. Enrollment requires a genuinely reachable trusted caller. Do not merge the epic or modify production just to manufacture that reachability. An operator can install a reviewed caller when the repository's workflow bootstrap boundary permits it; until then the source and local composed tests do not claim live GitHub publication acceptance.

An existing registered workflow with `workflow_dispatch` on the default branch can provide a caller at the same path on a dedicated trusted ref. That ref's reviewed caller can invoke the reusable publisher at a literal SHA, with its exact ref and caller context SHA enrolled alongside the reusable publisher SHA and environment subject. Repository inspection identified `ci.yml` as a possible route; an actual dispatch and environment enrollment remain unverified. The source builder remains a separate, completed run on the native target branch. The publisher does not accept `push` OIDC events.

A dispatch caller's job has this shape, replacing `REVIEWED_40_HEX_COMMIT` with a literal approved SHA before use:

```yaml
jobs:
  publish:
    permissions:
      contents: read
      actions: read
      id-token: write
    uses: kethalia/hive/.github/workflows/controlled-native-preview-publish.yml@REVIEWED_40_HEX_COMMIT
    with:
      scope-json: ${{ inputs.scope-json }}
    secrets:
      HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN: ${{ secrets.HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN }}
      HIVE_NATIVE_RELEASE_CONTROLLER_BEARER: ${{ secrets.HIVE_NATIVE_RELEASE_CONTROLLER_BEARER }}
```

Use the explicit named secret mappings above, never `secrets: inherit`. GitHub requires the caller to pass each name even when the secret exists only in the reusable job's environment; the environment value then takes precedence. The required write-token declaration checks that the name was passed, while the publisher separately rejects an empty credential. The controller bearer mapping is optional. See [GitHub's reusable workflow secret contract](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow). Set `HIVE_NATIVE_RELEASE_PUBLISHER_SHA` to that reviewed SHA and keep `HIVE_NATIVE_RELEASE_PUBLISH_ENABLED` unset until enrollment is accepted. The workflow-level enable flag is a repository variable; it is not read from a caller input. The protected environment owns `HIVE_NATIVE_RELEASE_PUBLISH_CONFIG_JSON`, `HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN`, and optional `HIVE_NATIVE_RELEASE_CONTROLLER_BEARER`. Configuration follows `nativePublisherConfigSchema`: fixed HTTPS controller origin, exact native target, public configuration, private-binding and compatibility revisions, builder/publisher authority policies, and a default-false `bootstrapEnabled` flag.

The caller supplies only selectors in `scope-json`:

```json
{
  "purpose": "publish",
  "ownerId": "<owner UUID>",
  "releaseId": "<current release UUID>",
  "artifactId": "<immutable native artifact UUID>",
  "artifactReleaseId": "<release owning that artifact UUID>",
  "sourceSha": "<exact source commit SHA>",
  "builderRunId": "<completed builder run ID>",
  "builderRunAttempt": 1,
  "builderArtifactId": "<immutable GitHub artifact ID>"
}
```

Ordinary publication and baseline bootstrap require `artifactReleaseId === releaseId`. Artifact submission prepares an action with `actionId === artifactId`. Recovery uses `purpose: "recover"`, additionally supplies the already prepared recovery `actionId`, and retains the original baseline artifact's owning release ID and builder selectors. Recovery skips artifact insertion and must receive a grant containing the exact retained manifest. Inputs never select credentials, provider endpoints, environment values, or policy.

## Publication protocol

The controller must run in an independently reachable existing operator-trusted Hive runtime. Its origin cannot equal the candidate Preview origin: activation replaces that application, whose strict environment does not include controller authority/configuration bindings, so a same-origin controller would disappear before receipt submission. The publisher rejects that configuration before any network request. Enrollment must identify an existing suitable controller host; this source does not create a host or copy privileged controller bindings into candidate code. The controller and database remain explicitly trusted boundaries, without a claim of isolation from arbitrary candidate code.

The publisher downloads the exact GitHub artifact, verifies the downloaded ZIP's SHA-256 against authenticated artifact metadata, and accepts only one bounded regular `release.tar` entry. It verifies the completed builder run and artifact independently before submission. Archive, module membership/bytes, assets manifest, source, and public configuration identities are bound into the native artifact attestation.

The fixed controller routes are `/api/internal/native-release/artifact`, `/grant`, `/reauthorize`, and `/receipt`. Each POST carries `X-Hive-Release-OIDC` with audience `<enrolled audiencePrefix><operation>:<canonical body digest>`. Controller authorization is separate from this authentication.

The controller commits its single publication grant and existing action's `effect_started` transition in one transaction. The publisher validates the grant's exact scope before any provider write. It reauthorizes and samples the pinned Preview's current deployment before asset transfer and again immediately before deployment POST. Asset upload uses the parent Worker's content store; native activation uses the pinned Preview ID. The publisher never creates or PATCHes Previews, changes routes, or calls production version/deployment APIs.

Native multipart deployment metadata uses an `env` map and repeated `files` parts, matching installed Wrangler 4.155.0. Public variables have a strict allowlist. Secret bindings use explicit enrolled names with `type: inherit`; secret values are never included in receipts. Public configuration attestation does not prove private secret values. Binding and compatibility revisions are separately operator-enrolled facts. `_headers` and `_redirects`, when present, are uploaded as text modules rather than ordinary assets.

Asset identifiers use Wrangler's BLAKE3 hash of the base64 content followed by the case-preserved filename extension, truncated to 32 hexadecimal characters. The publisher pins the same `blake3-wasm@2.1.5` and `mime@4.0.7` implementations used by the installed uploader. Text MIME types include UTF-8, and unknown types use the provider's `application/null` sentinel. Ordinary asset sessions use base64 multipart buckets; sessions advertising `wrangler_single_asset_uploads` use raw bytes at the exact per-hash upload endpoint. Both use the scoped session JWT and retain the publisher's no-retry rule. Artifact attestations continue to use SHA-256 independently of provider asset hashes.

On a successful provider response, the publisher submits an authenticated receipt binding the returned deployment ID and provider creation time before any provider readback. The controller then independently reconciles exact deployment/configuration/current identity and applies the existing journal's authorization before marking an effect observed. Health acceptance is a later independent operation.

Automatic Workers Builds stays enabled. A native grant's expected current deployment is a concurrency witness; it need not be the retained recovery baseline. The explicit `observed-drift-hold-no-atomic-cas` policy accepts the remaining external-writer race. Checks can detect drift but cannot atomically prevent another writer from deploying between checks. A currentness or readback mismatch holds the action.

## Baseline bootstrap and recovery

The initial baseline requires a separately enrolled Preview-only `bootstrap-baseline` permission and `bootstrapEnabled: true` in protected publisher configuration. The controller must independently permit that purpose while no accepted baseline exists. It follows the same completed builder, authenticated artifact, single journal grant, byte-only upload, receipt, and readback procedure. No healthy or recoverable baseline is invented. Recovery remains unavailable until independent health acceptance records the baseline.

Ordinary publication and recovery require an independently attested compatible retained baseline. Recovery is another journaled archive upload while the failed deployment is still current; it is not production-version rollback. A different current deployment, expired/missing archive, or changed compatibility epoch holds recovery. Artifact retention is requested for 90 days, subject to repository limits; the actual authenticated expiration governs eligibility. Operators must retain a usable baseline before its archive expires.

Recovery restores the exact retained public configuration from the authenticated controller grant, which may differ from the current candidate's configuration. Archive/module/asset bytes, builder/source/selectors, and the currently approved private-binding and compatibility revisions are still checked independently before any write. Ordinary publication continues to require the protected current configuration.

## Interrupted execution

There are no upload retry loops. A missing grant acknowledgement, aborted upload, lost deployment acknowledgement, malformed provider response, or missing receipt acknowledgement holds the existing action. A rerun cannot reclaim the one-use grant. Controller reconciliation may use an already persisted authenticated receipt; it cannot infer a returned deployment ID from annotations, timestamps, a current URL, or automatic build success. A lost Cloudflare acknowledgement without an authenticated returned ID remains unresolved.

Run the source boundary checks with:

```sh
node --test scripts/release/native-preview.test.mjs
```

The existing runtime test wildcard includes this entry. It uses the repository's installed `tsx` only for the native TypeScript checks. These tests mock GitHub and Cloudflare; live publication, workflow reachability, independently sampled health, and recovery rehearsal remain separate acceptance gates.

The adjacent legacy version uploader, `scripts/release/cloudflare-upload.mjs`, now uses the same pinned BLAKE3 asset identifiers, MIME behavior, and scoped bulk/single-asset wire formats. Its tests assert independent provider hash vectors and exact routes/payloads, reject invalid later buckets before upload, and verify lost upload acknowledgements never retry. This source correction does not enable that uploader or constitute production deployment acceptance; its existing version-only behavior and separate production authorization remain in place.
