# Native Preview release identity foundation

This slice supplies a read-only native Preview identity reader through the existing
release observer/controller modules. The existing production-version provider and
health observer still reject native Preview mutation/integration with
`release_native_preview_unsupported`. No live flag, scheduled job, publication or
production setting is enabled by these changes.

`createReleaseIdentityObservationController` in `release-controller.server.ts`
accepts only deployment-owned construction arguments:

```ts
const controller = createReleaseIdentityObservationController({
  nativePreviewIdentityEnabled: "true", // omitted/false returns null
  nativePreviewIdentityTargetJson: JSON.stringify({
    provider: "cloudflare-native-preview",
    accountId: "225177f82b9234ede14e897fe15e0cb5",
    workerName: "hive",
    previewId: "9b772c5c22f84deeb1af85e68f819798",
    previewName: "codex/delivery-system-design",
    previewSlug: "codex-delivery-system-design",
    origin: "https://codex-delivery-system-design-hive.b00ste.workers.dev"
  }),
  cloudflareToken: privatelyProvisionedReadToken
});
const fact = await controller?.observeIdentity(signal);
```

These are constructor keys, not new ambient environment variables automatically
consumed by a deployment. No route accepts this JSON from a browser/model/task.
The target JSON is limited to 4 KiB and rejects extra fields. Account/Worker/branch/
slug/origin are fixed to the currently enrolled native Preview. The provider Preview
ID must be separately enrolled by the operator and match every actual read. The
primary observed the public ID shown above; the reader revalidates it rather than
trusting the name or deriving a slug. Deleting/recreating the Preview holds until
its new ID is explicitly enrolled. Another branch requires reviewed source/config
changes and callback enrollment before this implementation can target it.

The only outbound operations are four GETs under the pinned account's
`/workers/workers/hive/previews/` API: branch-name lookup followed by pinned-ID
`/deployments/latest`, repeated. These are the native Preview APIs used by the
installed official Wrangler 4.155.0 (`getPreview` and `getPreviewDeployment`). They
are not `/workers/scripts/hive/versions` or parent production deployment calls.
Redirects use `manual` and every non-200 or redirected response holds; this avoids
the repository's known Workers `redirect: error` portability issue. A 10-second
overall deadline and 64 KiB per response bound fetch, body and cancellation. Late
bodies after an ignored abort are cancelled. There are no retries or writes.

Both samples must match Preview ID/name/slug, deployment ID and the projected
annotations. Returned facts are discriminated as `kind: native-preview-identity`,
`state: observed | hold`, and always `eligibility: unverified`. The identity contains
no production version ID, artifact/config digest, healthy fact or effect receipt.
No provider env, assets JWT, secret value, credential hash, author identity, arbitrary
annotation or provider error text is exported. The target digest covers only the
public deployment-owned enrollment. A correctly formatted `workers/commit_sha` or
exact `hive-release:<action UUID>` message is explicitly labelled an *annotation*,
not verified source/build/authorization evidence. Missing or unrelated annotations
remain null, with no source inference from tags/messages, current Git HEAD or CI.

The primary's safe actual read shape has Preview ID as 32 hex characters and latest
deployment ID as a UUID. Its latest result includes top-level configuration, env,
assets, author and annotation fields; the reader projects identity without hashing
or exporting those private fields. The actual annotation keys observed were
`workers/message`, `workers/repository_url`, `workers/tag`, `workers/triggered_by`;
none supplies an exact source SHA. A regression uses that observed shape and keeps
source/action annotations null. This supplied shape grounds the regression. The primary also ran the new
controller against the actual API: four GET200 responses agreed on Preview and
deployment identity, with source/action annotations absent and eligibility still
unverified. [Live receipt](native-preview-release-identity-live.json).

Still required before native release mutation integration:

- Bind immutable source/build/artifact and separately reviewed public config and
  private binding identities to the exact native Preview deployment. Existing
  production version attestations cannot be relabelled as branch deployments.
- Prove the native deployment publication/recovery semantics and available
  provider preconditions. No atomic CAS or rollback/repoint primitive is claimed
  by this reader. Matching two observations does not prevent external-writer races.
- Reuse the existing before-effect journal, environment lock, unknown-outcome hold
  and read-only reconciliation. Reconciliation must attribute an exact action and
  independently verified artifact; desired state or a matching annotation alone
  is insufficient. Never replay an uncertain upload automatically.
- Prove native health/metrics and observation/recovery behavior before replacing
  guards or feeding any healthy/source/build fact to the existing release lifecycle.
  No production activation or healthy rollback baseline follows from identity.

Focused tests cover fixed paths, supplied provider shapes, recreation/drift,
annotation sanitization, unknown/error/redirect/oversized responses, ignored aborts
and stalled bodies, plus the discriminated controller seam and unchanged mutation
guard. Actual execution through the new reader remains a separate primary-operated
read-only acceptance gate.

Official workflow semantics:
[Workers Previews](https://developers.cloudflare.com/workers/previews/),
[workflow comparison](https://developers.cloudflare.com/workers/previews/compare-workflows/),
[test/debug](https://developers.cloudflare.com/workers/previews/test-and-debug/).
