# Read-only production metadata capture

`production-readback.mjs` is an operator utility for the retained `hive` parent
Worker. It cannot publish, activate a route, change a secret, recover a deployment
or remove the native Preview release-adapter guard. It never marks an offline
preparation or provider baseline verified.

The fixed scope is account `225177f82b9234ede14e897fe15e0cb5`, Worker `hive`,
zone `b5a1ed758b9cd1c62fcacf9037dc0dea` (`kethalia.com`) and production hostname
`hive.kethalia.com`. The zone ID was independently read by the primary operator;
every capture first rechecks its account, name and active status through Cloudflare.
No argument can select another target or provider origin.

Use an existing privately provisioned read token in `CLOUDFLARE_API_TOKEN` only
when an actual read is authorized. Never put its value in command arguments or
Git. A capture creates a new private file exclusively (mode 0600):

```sh
node deploy/cloudflare/native/production-readback.mjs --capture /private/cutover/readback.json
```

The collector makes 19 GET requests: zone identity, then two full samples of script
identity, latest deployment, exact version resources, secret names, script-level
settings, schedules, subdomain settings, zone routes and zone-filtered Worker domains.
It rejects redirects, unsuccessful envelopes, non-singleton/split current deployment,
incomplete pagination metadata, inconsistent secret bindings, unsupported binding
types and missing required metadata. There is no retry. The entire operation has a
30-second deadline; every response body is limited to 1 MiB. Cancellation bounds
fetch and streaming reads even when the underlying transport ignores AbortSignal;
late response bodies are cancelled.

The documented single-page script/route/secret arrays may omit `result_info`.
If any list supplies it, only numeric `page`, `per_page`, `count`, `total_count`
and `total_pages` are supported: page must be one, and either a matching total
count or at most one total page must explicitly establish completion. Every
supplied count must agree with the returned list; page size and total-page math
must agree when supplied. Empty/partial metadata, unknown cursor/has-more fields,
wrong types, negative/fractional counts and multi-page results hold. The collector
never follows a continuation or infers completeness from page size alone.

Only selected names/IDs, route/domain/schedule metadata and SHA256 digests of a
reviewed public projection leave the collector. The sanitized `publicBindings` contain only explicitly allowed public values and secret names/types. `publicConfigurationDigest` covers the runtime/public configuration without code artifact or deployment IDs, for separately approved ongoing Builds transitions. Secret payloads, credential hashes,
unknown provider payloads, author identities, headers and provider error text are
never serialized or used as public digest inputs. The artifact declares coverage
`reviewed-public-config-v1`. Secret values returned unexpectedly under secret binding
fields are ignored before hashing; changing them cannot change a public digest.

The projected version config covers script etag, runtime compatibility date/flags,
usage model and CPU limit; binding names/types; fixed approved public flags/origins/
OAuth client ID; and the approved assets/R2 resource identifiers. Arbitrary plaintext
variables and unsupported binding/runtime config shapes hold. Script-level coverage
includes Logpush and reviewed observability booleans/sampling settings. Nonempty
observability destinations, tails, tags, runtime exports and migrations are unsupported
and hold until separately reviewed. Unexpected secret/env payloads in configuration
objects hold; extra script identity metadata is discarded. No raw provider object
is hashed. This is projected configuration identity, not complete private config or
secret identity. Retain the sanitized metadata privately until reviewed.

Both samples must agree. This detects observed drift, not changes between samples,
an atomic provider snapshot, or a race after collection. Any error produces only
`production_readback_hold`. There is no partial-success artifact.

For the existing first-production recipe, `inactiveProductionBaseline(readback)`
returns the exact `{observedAt, baseline}` shape. It requires a capture no older
than five minutes and strictly bootstrap-only bindings, no secrets/schedules,
workers.dev disabled, and no `hive` route or domain in the fixed zone. Version
Preview URLs may stay enabled for the inert parent. Assets or other bindings are
conservatively ineligible for this conversion. This is a configuration predicate:
it does not inspect executable code or prove that the version's code is inert.
Independently verify the exact bootstrap artifact before calling it inactive.
Routes in other zones, DNS origin routing, external schedulers, data/secret identity,
application health and rollback compatibility remain separate checks. Both
`activationAuthorized` and `providerBaselineVerified` remain false.

Compare a fresh capture to a separately reviewed expected metadata artifact:

```sh
node deploy/cloudflare/native/production-readback.mjs --compare /private/cutover/readback.json /private/cutover/expected-readback.json
```

The command prints only `matched` or `hold` with `activationAuthorized: false`;
`hold` exits unsuccessfully. Comparison verifies fixed scope, freshness, complete projected
snapshot equality and its digest, not the authenticity of a JSON file. Editing a
JSON timestamp does not create a provider observation. An expected post-publication
snapshot must independently bind the intended uploaded version/artifact and
provider-normalized settings. It cannot be derived by assuming Wrangler input is
the provider's exact output. Comparing a capture against itself is only a parser
check, never acceptance of a deployment.

The production preparation's clean merged source, build/proof integrity, exact
manifest approval, resource/secret verification, unchanged inactive baseline,
scheduler handover and recovery rehearsal gates remain mandatory. The collector
does not execute the recipe, certify private secret identity, validate production
OAuth login, produce a healthy D09 rollback baseline or prove F07/F08 acceptance.

Source tests use provider doubles only. They cover sanitization (including
unexpected returned secret/env values), fixed GET scope, identity/pagination/schema
holds, deployment/config/routing drift, inactive conversion, stale captures,
redirects, oversized/stalled bodies and ignored cancellation. The primary also completed a real 19-GET capture after official OAuth refresh and
explicit handling of observed nullable settings, 40-character custom-domain IDs
and successful Domains envelopes with `errors: null`. The parent still has its
retained bootstrap deployment but `workers.dev` is enabled: `inactive` is false,
so conversion to an inactive first-cutover baseline remains held. No setting was
changed. See the [scoped receipt](../../../docs/checks/autonomous-delivery/production-readback-live.json);
the full capture is retained privately and is not a fresh approval baseline.

The endpoint shapes were checked against official Cloudflare API documentation:
[script metadata](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/),
[deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/),
[versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/),
[script settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/),
[secrets](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/list/),
[schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/),
[subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/),
[routes](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/),
[domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/).
