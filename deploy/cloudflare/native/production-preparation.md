# First production preparation

The normal `deploy.mjs production` command still refuses publication. The separate
`prepare-production.mjs` command performs **offline preparation only** and does not
create an authorization, contact Cloudflare, read a secret value or activate a route.
It reuses the existing application build-integrity record, native proof format and
Wrangler deployment command. It is not another release controller.

After the owner merges the accepted candidate, build and prove that exact clean
`main` checkout. The build/proof must be regenerated after any source change:

```sh
node deploy/cloudflare/native/prepare-production.mjs /private/cutover-manifest.json /private/native-proof.json /private/new-cutover-directory
```

Use a new output directory outside the source checkout. The helper verifies the
current source/output hashes with `assertBuildReady`; it also requires the proof's
exact main revision, successful native/in-process-auth checks and the same build
record digest. It creates private `wrangler.production.json` and `preparation.json`
files. No source/PR build is promoted implicitly to a merged artifact.

The manifest is JSON with exactly these fields (replace placeholders from actual
observations; this is a schema illustration, not a provider receipt):

```json
{
  "schemaVersion": 1,
  "sourceRevision": "<40-character merged main SHA>",
  "origin": "https://hive.kethalia.com",
  "route": { "pattern": "hive.kethalia.com/*", "zone_id": "<32-character zone ID>" },
  "secretNames": ["AUTH_SERVICE_SECRET", "COOKIE_SECRET", "DATABASE_URL", "ENCRYPTION_KEY", "HIVE_CODER_OAUTH_CLIENT_SECRET"],
  "oauthEnrollment": {
    "coderOrigin": "https://coder.kethalia.com",
    "clientId": "0a4e5cd5-cf36-4c56-927c-effe349286c8",
    "callbackUri": "https://hive.kethalia.com/api/auth/coder/callback",
    "secretName": "HIVE_CODER_OAUTH_CLIENT_SECRET"
  },
  "databaseIdentity": {
    "projectId": "<production-project>", "branchId": "<production-branch>",
    "database": "<production-database>", "role": "<restricted-runtime-role>"
  },
  "r2Buckets": [],
  "baseline": {
    "accountId": "225177f82b9234ede14e897fe15e0cb5", "workerName": "hive",
    "workerTag": "<retained-parent-tag>", "createdOn": "<parent-creation-time>",
    "deploymentId": "<inactive-deployment-ID>", "versionId": "<inactive-version-ID>",
    "settingsDigest": "<SHA256-of-canonical-settings-capture>", "inactive": true
  },
  "evidenceDigests": { "buildReady": "<SHA256-of-build-ready-file>", "nativeProof": "<SHA256-of-native-proof-file>" }
}
```

`r2Buckets` may contain the single explicitly approved production evidence bucket
with `binding: HIVE_DELIVERY_EVIDENCE` and `bucket_name`. Preview/synthetic resource
names, extra manifest fields and secret values are rejected. The metadata does
not prove that `DATABASE_URL` resolves to that database or that a secret preserves
the required identity: verify these privately before activation.

The generated config strips every `HIVE_CODER_OAUTH_*` Preview variable. To prepare
OAuth, supply the independent `oauthEnrollment` object shown above and include its
literal secret name in `secretNames`. The helper accepts only the fixed Coder
issuer, `https://hive.kethalia.com` origin, exact callback, valid public client ID,
and `HIVE_CODER_OAUTH_CLIENT_SECRET` name. It rejects the configured Preview client
ID, extra fields (including secret values), missing enrollment fields and an absent
fifth secret name. It emits the production client ID and enable flag; the secret
value must be supplied privately at the separately approved publication step.

The production client metadata above is recorded in the
[production enrollment receipt](../../../docs/checks/autonomous-delivery/coder-oauth-production-client.json).
That receipt records independent registration, not production activation or a
successful production OAuth login. The helper validates metadata syntax and exact
scope; it does not contact Coder, attest registration or prove the private secret
matches the client. Verify those identities and production callback enrollment
against fresh provider observations before approval.

Omitting `oauthEnrollment` and retaining exactly the four application secret names
preserves legacy bootstrap compatibility: OAuth stays disabled and no Preview
client ID survives. This compatibility mode does not satisfy the requested OAuth
production cutover. The final reviewed cutover manifest must explicitly include
production OAuth enrollment; do not substitute a password-only bootstrap.

The generated first-cutover config serves the application with production origin
and the explicit four or five required secret names. It disables public version URLs and workers.dev,
retains the existing CPU/compatibility settings and keeps discovery, task execution,
delivery and token rotation off. It installs **no schedules**. Full native manager,
release, rotation and notification activation needs separately reviewed configuration,
account-backed evidence and scheduler ownership transfer. This deliberately bounded
bootstrap recipe does not enable the entire epic.

Before the user's final cutover approval, prepare the complete manifest and review
migration compatibility, original encryption/session identities, Kubernetes fallback,
post-cutover write recovery, route ownership and in-flight effects using
[the environment checklist](../environments.md#first-production-cutover). Capture
fresh account/Worker identity, active deployment/version, bindings, routes, schedules
and subdomain settings from the provider, retaining their canonical settings digest.
`inactive: true` is an operator assertion to verify against those observations, not
an attestation manufactured by this helper. An inactive parent is never a healthy
controlled-release rollback baseline.

Only after the owner approves that concrete package may an operator create a private
authorization JSON with exactly these fields:

```json
{
  "schemaVersion": 1, "action": "activate-first-production",
  "preparationDigest": "<SHA256-of-preparation.json>",
  "approvedBy": "<record-of-owner-approval>",
  "approvedAt": "<approval-time>", "expiresAt": "<at-most-30-minutes-later>",
  "resourceAndSecretIdentitiesVerified": true,
  "schedulerHandoverVerified": true,
  "rollbackRehearsalVerified": true
}
```

The recipe CLI reads the explicit approval file and rechecks the clean merged
source and existing build integrity; it prints arguments without running them.
The fresh-baseline file has exactly `{ "observedAt": "<provider-read-time>",
"baseline": { ... } }`, where `baseline` uses the identity fields above and must
match the approved inactive parent. Its observation must be within five minutes.
The timestamp is an operator assertion, not proof that a provider read occurred:

```sh
node deploy/cloudflare/native/prepare-production.mjs --recipe /private/new-cutover-directory /private/authorization.json /private/fresh-baseline.json /private/production-secrets.json
```

`publicationRecipe` validates this authorization, its exact package/config digest,
expiry and an independently obtained fresh normalized baseline before returning
an argument array for the installed Wrangler:

```js
const argv = publicationRecipe({
  record, configBytes, authorization, freshBaseline,
  configPath: "/private/new-cutover-directory/wrangler.production.json",
  secretsPath: "/private/production-secrets.json"
});
// argv is data. No command executes inside publicationRecipe.
```

The resulting command uses `pnpm exec wrangler deploy --config <absolute-config>
--strict --secrets-file <private-json-file>`. The private JSON must contain
the exact approved application secrets plus the production OAuth secret when
enabled, and preserve existing identities; never put its values
in the manifest, arguments, Git or reports. Inspect inherited remote secret names
as well: omitted secrets are retained by Wrangler. Immediately before running it,
recheck the actual files, build integrity and provider baseline. Do not use shell
string interpolation; execute the returned argument array. `--strict` adds Wrangler's
remote conflict check, but is not an atomic comparison against the recorded deployment.
The separate [read-only metadata collector](production-readback.md) can capture
fixed-scope provider metadata and compare fresh observations to an independently
reviewed expectation. It does not certify an offline baseline, private secret
identity, bootstrap code or application health. Secret-identity verification,
activation execution and account-backed post-deployment acceptance remain explicit
operator steps; the recipe does not run them.

After publication, preserve provider readback of the exact Worker/version/config,
route owner, secret names and empty schedules; validate app/auth, original sessions,
terminal/streaming and recovery under the approved observation plan. Hold ambiguous
results and keep Kubernetes recovery available. Only then record a healthy baseline
for the existing D09 controller. The source tests for this helper do not establish
account-backed publication, production traffic, migration or rollback acceptance.

Wrangler command/secret behavior was checked against the installed help and
[Cloudflare secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).
