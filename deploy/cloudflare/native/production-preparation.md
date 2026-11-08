# Production enrollment through connected Builds

The production command remains `node deploy/cloudflare/native/deploy.mjs production`
in the existing repository-connected Cloudflare Workers Builds configuration.
Publication is disabled unless the owner enrolls a reviewed
`HIVE_NATIVE_PRODUCTION_ENROLLMENT_JSON` build setting. This source change does not
enroll that setting, approve cutover, move traffic or provision credentials.
Preview continues to use its existing command and configuration independently.

The command accepts only the fixed `kethalia/hive` repository, `main` branch,
account `225177f82b9234ede14e897fe15e0cb5`, Worker `hive`, zone
`b5a1ed758b9cd1c62fcacf9037dc0dea` and `https://hive.kethalia.com` origin. It checks
Workers Builds' branch/build/commit context against the actual clean Git checkout
and origin. Before the build/output check and again after the potentially slow
parent observation, a bounded fixed-repository `git ls-remote` must show that
remote `refs/heads/main` still equals this build's exact commit. A newer queued
main commit makes the older build hold. These context variables are consistency
checks, not cryptographic attestation; the existing trusted repository connection remains the authority.

## Reviewed public configuration

The bounded enrollment JSON has exactly these fields:

```json
{
  "schemaVersion": 1,
  "mode": "first-cutover",
  "repository": "kethalia/hive",
  "branch": "main",
  "accountId": "225177f82b9234ede14e897fe15e0cb5",
  "workerName": "hive",
  "configuration": {
    "origin": "https://hive.kethalia.com",
    "route": { "pattern": "hive.kethalia.com/*", "zone_id": "b5a1ed758b9cd1c62fcacf9037dc0dea" },
    "oauthEnrollment": {
      "coderOrigin": "https://coder.kethalia.com",
      "clientId": "0a4e5cd5-cf36-4c56-927c-effe349286c8",
      "callbackUri": "https://hive.kethalia.com/api/auth/coder/callback",
      "secretName": "HIVE_CODER_OAUTH_CLIENT_SECRET"
    },
    "secretNames": ["AUTH_SERVICE_SECRET", "COOKIE_SECRET", "DATABASE_URL", "ENCRYPTION_KEY", "HIVE_CODER_OAUTH_CLIENT_SECRET"],
    "databaseIdentity": { "projectId": "<production-project>", "branchId": "<production-branch>", "database": "<production-database>", "role": "<production-runtime-role>" },
    "r2Buckets": [],
    "vars": {},
    "crons": []
  },
  "configurationDigest": "<publicDigest(configuration)>",
  "approval": "<mode-specific object below>"
}
```

This is a schema illustration, not an enrollment or provider receipt. The approval
is an object, not the placeholder string. `publicDigest` from
`production-configuration.mjs` hashes recursively key-sorted JSON without whitespace.
It binds the entire public configuration, including resource identity assertions.
No database URL, private key, cookie key, service secret or provider token is an
input to this JSON. The command uses the existing Builds token and already enrolled
remote Worker secrets; it neither creates nor changes secrets. Missing or additional
remote secret names hold. Independently verify private secret/database identities
and original encryption/session continuity before approval; names cannot prove them.

The constructor fixes the repository entrypoint, built assets, compatibility flags,
CPU limit and production route. It never copies Preview variables, policies,
issuer or credentials. First cutover requires empty `vars` and `crons`, so native
execution/release/scheduling stays off. The production OAuth client and callback
are independently pinned; Preview OAuth enrollment is rejected.

## First cutover

Use `mode: first-cutover` with exactly this approval shape:

```json
{
  "action": "activate-first-production",
  "sourceRevision": "<exact merged main SHA>",
  "configurationDigest": "<same approved configuration digest>",
  "approvedBy": "<reference to owner's concrete approval>",
  "approvedAt": "<approval time>", "expiresAt": "<at most 30 minutes later>",
  "resourceAndSecretIdentitiesVerified": true,
  "schedulerHandoverVerified": true,
  "rollbackRehearsalVerified": true,
  "baseline": { "workerTag": "<exact parent tag>", "createdOn": "<parent creation time>", "settingsDigest": "<fresh reviewed parent snapshot digest>" }
}
```

Approve the exact **preprovisioned inert bootstrap parent** after its required
remote secrets have been enrolled and verified through the existing account.
The command performs the existing fixed-scope read-only collector immediately
before deployment. The fresh full snapshot digest, parent tag and creation time
must match approval; the snapshot must have only the bootstrap public binding,
approved secret names and optional assets, with no Hive routes/domains, schedules
or workers.dev serving. The historical `inactiveProductionBaseline` still means
zero secrets; it is not used to mislabel this staged secret-bearing parent.

Each real build verifies its own sources and generated outputs using
`assertBuildReady`. Retain independently reviewed native proof for the exact merged
source. A native proof from an earlier local build is source evidence, not
attestation that the current Builds artifact has identical bytes. The older
offline `prepare-production.mjs` still validates its stronger same-build
readiness/proof contract for preparation records; its recipe is historical argument
data and is not the current publication path. Do not run a separate manual deploy.

First-cutover approval never becomes ongoing authority. A successful activation
changes the parent snapshot and cannot be repeated under the old baseline.
Unknown acknowledgements require inspection of the existing build/deployment;
the command does not retry a deployment.

## Ongoing main builds and configuration changes

Only after inspecting first cutover may the owner separately enroll
`mode: ongoing-main`, with this distinct approval shape:

```json
{
  "action": "deploy-reviewed-main",
  "configurationDigest": "<approved new target configuration digest>",
  "approvedBy": "<reference to separate owner approval>",
  "approvedAt": "<approval time>", "expiresAt": "<at most 30 days later>",
  "resourceAndSecretIdentitiesVerified": true,
  "schedulerHandoverVerified": true,
  "rollbackRehearsalVerified": true,
  "firstCutoverDeploymentId": "<reviewed first deployment UUID>",
  "allowedParents": [
    { "workerTag": "<exact parent tag>", "createdOn": "<parent creation time>", "publicConfigurationDigest": "<approved currently serving public configuration digest>" }
  ]
}
```

There is no automatic transition or renewal. The first deployment UUID is an
owner-reviewed reference, not a newly fabricated provider attestation. Ongoing
scope permits later reviewed `main` commits while it remains valid, subject to the
existing repository rules and release/acceptance gates. It does not grant merge,
semantic acceptance, migration, writer release or archive authority.

At most four exact prior parent/configuration identities may be approved. The
collector's `publicConfigurationDigest` covers runtime, public bindings, secret
names/types, script settings, schedules and routing; it excludes code artifact,
version and deployment IDs so code-only main builds keep the same configuration
scope. Secret values never enter it. Configuration/policy changes require explicit
approval of the actual prior digest and new target configuration. Enrolling both
old and new digests permits the reviewed transition and subsequent builds; neither
is a wildcard. Unexpected parent, route, secret names or configuration drift holds.

Ongoing `vars` accepts only the fixed public feature/policy/host settings listed
in `production-configuration.mjs`; the existing runtime validators still own policy
content. Every absent execution feature defaults off. Codex/Claude account connection, host/agent tools, workspace reads, voice, generic
and project terminals, delivery/notice dispatch, rotation and native health all
require explicit enrolled boolean values. Their public pins, transports, origins
and policy names are individually allowlisted. Existing runtime validators still
check their contents. Enabling the host gateway requires its already enrolled
issuer secret name. Read/voice/agent-tools can use the existing shared-host issuer
or their separately named, already enrolled dedicated issuers. Only these known
issuer secret names may be retained in ongoing configuration; no values are accepted.
Project preparation also conditionally requires the existing private
`HIVE_PROJECT_TASK_RECONCILE_SECRET` name when `HIVE_PROJECT_TASKS_ENABLED=true`
for the same-Worker jobs-to-app wake. Its value stays separate from the auth-service
secret and is never an enrollment input. `HIVE_TEMPLATE_LOG_VIEW_ENABLED` explicitly
enables the existing authenticated detailed-log route; absence keeps it off. R2 is limited to one
explicitly approved production evidence bucket. The only allowed schedules are
`* * * * *` and `*/5 * * * *`, and each must be explicitly listed after scheduler
handover. Absent capability flags remain off, including dispatch and rotation;
ongoing owner enrollment can explicitly enable them. No extra service, database binding, arbitrary route, executable path or credential input is
accepted.

## Free-tier scheduling boundary

Neon Free includes 100 CU-hours per project per month and suspends after five
inactive minutes. Continuous minute-level SQL polling can prevent suspension;
at the minimum 0.25 CU, 24 hours × 30 days consumes about 180 CU-hours before
other work. Thus standing production cron is a real cutover/capacity decision,
not a free-tier guarantee. Keep runtime flags and schedules off until the owner
approves the concrete cadence and budget; never upgrade or add costs automatically.
Source: [official Neon plans](https://neon.com/docs/introduction/plans).

## Publication and acceptance

After a fresh matching readback, a second current-remote-main check and a final
approval-expiry check, the same connected Builds command invokes the pinned installed Wrangler once with the generated public
config and `--strict`. It uses no secrets file, alternate publisher or second Worker.
The readback and remote-main reads detect observed drift; neither they nor
`--strict` provide atomic compare-and-swap against concurrent GitHub/Cloudflare
changes. Keep owner/provider mutation
serialized during cutover and inspect uncertain results before another build.

`--check` and `--dry-run` perform no provider operation. With enrollment absent,
production checks remain available against the inert bootstrap; a live production
invocation fails. An enrolled check validates local context/configuration only,
not remote resources or serving behavior.

The first deployment binds its approved production route and activates application
serving. Its preflight checks are not proof of production OAuth or app/DB readiness:
those account-backed checks happen after that production write. After publication,
preserve provider build/deployment readback and verify the
exact source/build, DB/auth readiness, original sessions, browser OAuth callback,
Conversation/Terminal and rollback/write recovery under the approved plan. Platform
health alone cannot satisfy arbitrary business behavior or complete semantic
acceptance. Kubernetes fallback remains available until the owner accepts cutover.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
