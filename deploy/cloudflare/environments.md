# Cloudflare application environments

The canonical target is **one Worker, `hive`**, in account
`225177f82b9234ede14e897fe15e0cb5`. Production uses top-level configuration;
branch environments use Cloudflare's native `previews` block under that same Worker,
as in Creative Studio and Top Decor Ledger. Do not use `wrangler deploy --env preview`,
which creates another Worker.

[Configuration and commands](native/README.md) live in `native/`. App, auth and job
handlers are composed in process; no Preview service binding can reach a production
Worker. Production is an inactive bootstrap with no data credentials, routes or cron.
The temporary separately named production reservations have been retired; their
[creation](../../docs/checks/autonomous-delivery/cloudflare-production-reservations.json)
and [retirement](../../docs/checks/autonomous-delivery/cloudflare-production-retirement.json)
remain recorded.

Native previews use the dedicated synthetic Neon database `hive_native_preview`
and restricted `hive_native_runtime` role on the existing Free project. Preview Base
secrets are separate from production and the older compatibility pilot. Trusted
same-repository branch previews share this synthetic database; they do not isolate
data from each other. Each branch has an exact origin and origin-bound preview cookies.
Host operations, delivery, schedules and R2 are initially disabled. A separately
reviewed one-branch pilot overlay enables scoped host and delivery features with a
private evidence bucket; it does not change the default Preview configuration.

Cloudflare Workers Builds connects `kethalia/hive` at repository root. It builds with
`pnpm build:cloudflare` and publishes branch previews with
`node deploy/cloudflare/native/deploy.mjs preview`. The main command is
`node deploy/cloudflare/native/deploy.mjs production`, which currently refuses activation.
The repo connection and dedicated build token are configured. A branch push has
triggered a successful provider-managed Preview build, and bounded live app and
task-start checks are recorded in [pilot progress](../../docs/checks/autonomous-delivery/progress.md).
Full native host and browser acceptance remains pending. A merge alone cannot enable
the production runtime, secrets or data cutover.

The old app/auth/jobs compatibility Workers and the earlier capability-probe Worker
were retired at the user's direction. The [retirement receipt](../../docs/checks/autonomous-delivery/cloudflare-single-worker-retirement.json)
records exact identities, deletion and the remaining native Preview. Three completed
test databases were subsequently backed up privately and removed; the current native
Preview, local regression database and active R2 bucket remain. The
[database cleanup receipt](../../docs/checks/autonomous-delivery/retired-test-database-cleanup.json)
records that separate action. Provider code and settings were privately archived,
but Cloudflare's write-only retired secret values were not exported. They may not be
recoverable, so retained compatibility data is not guaranteed to be decryptable.
The historical [prepared-artifact workflow](app/README.md) and
[deployment evidence](../../docs/checks/autonomous-delivery/cloudflare-app-deployment.json)
remain for reference; the compatibility deployment helpers now refuse live uploads.

Browser validation still runs in Browser Testing; Coder development workspaces remain
on Kubernetes. Existing production remains on Kubernetes until the user approves the
validated cutover. No production DNS or database change follows from this setup.

## First production cutover

The native Worker has production-aware request and scheduled-handler code, but its
production configuration, real bindings, route and cutover are not activated. The
first transition from Kubernetes is a bootstrap cutover, not a normal D09 release:
the current `hive` Worker is an inert bootstrap, not a healthy production baseline
or a usable rollback target. Keep the current Kubernetes deployment and its routing
and data recovery path available until the new service is independently verified.
The [Kubernetes deployment and rollback runbook](../../docs/deployment.md) remains
the source of truth for that side of the transition.

Prepare an operator-reviewed cutover manifest after the user merges the relevant
source to `main` and before asking for final activation. It must pin actual values
from fresh provider and repository observations, without including secret values:

| Item | Evidence to pin |
| --- | --- |
| Source and artifact | Merged `main` commit, successful required checks, build provenance, native Worker artifact and configuration digests. |
| Cloudflare target | Account, existing `hive` Worker identity, current deployment/version and bindings, intended route and exact production origin, and pre-cutover route owner. |
| Kubernetes fallback | Current GitOps revision and image identities, route/DNS configuration, running scheduler ownership, and a tested route restoration procedure. |
| Database and storage | Production Neon project/branch/database and restricted runtime role, migration history and compatibility evidence, backup/recovery point, and any explicitly required production R2 bucket. Do not substitute shared synthetic Preview resources. |
| Runtime identity | Secret names, existing key/issuer identity and controlled secret source, without exporting values; include database, encryption, cookie and internal service keys and any enabled host or release-probe credentials. Preserve identities needed to decrypt data or validate existing sessions. |
| Features and schedules | Exact enabled flags, canonical public/host origins, issuer/template enrollment and the single authorized scheduler owner and cadence; document which capabilities remain off. |
| Verification and rollback | Authenticated app/auth health identities, account-backed browser and host checks, route and application rollback triggers, database compatibility and the operator responsible for holding ambiguous effects. |

Before any production action, confirm the intended production database's migration
and grant preflight, recovery point and backward compatibility with the retained
Kubernetes release; follow the [migration procedure](../../docs/deployment.md#existing-database-baseline-adoption).
Rehearse the route and application rollback with the current Kubernetes release.
An application or route rollback does not undo database migrations, external
provider effects, or R2 writes. If the schema is no longer compatible with the
retained release, hold traffic or use a reviewed forward recovery rather than
blindly restoring it. Coordinate scheduler ownership and resolve in-flight work
before enabling native scheduled dispatch. The planned exact cron expressions are
`* * * * *` for jobs and `*/5 * * * *` for release and credential rotation;
each expression invokes only its assigned handlers, including when the times
coincide. Both remain unconfigured until activation. A one-minute wake improves
the chance of reconciling an enrolled guardian before its three-minute authority
expires, but provider delays, retry backoff or a backlog can still require a hold
and recovery; it is not a deadline guarantee. The existing
[rotation cutover notes](../../docs/checks/autonomous-delivery/token-rotation-scheduling.md)
describe why stopping an old process alone does not undo an in-flight provider call.

The current `native/deploy.mjs production` deliberately rejects real deployment;
its check and dry run are not an activation recipe. A production configuration,
guarded promotion and provider readback still need implementation and review.
The user must approve the concrete manifest and final activation after `main` is
merged; no merge or Preview build performs that approval or moves production.

## Subsequent controlled releases

Once the initial cutover is independently healthy, record the **actual healthy**
single-Worker deployment, source, artifact and configuration identities as the
first controlled-release baseline. Both logical app and auth roles refer to that
same physical Worker; app and auth health must still be checked independently
through the combined protected health response. A normal release promotes or
recovers that one physical Worker once, and uses one Worker metrics stream. It
must not treat the inert bootstrap as a successful previous release or count one
physical observation as two independent ones.

The controlled release path still needs the official repository environment,
reviewed policy and publisher configuration, provider credentials and exact
workflow/check bindings installed and verified. Its native Preview adapter is
not a production versions API substitute. Review the
[controlled delivery checkpoint](../../docs/checks/autonomous-delivery/d09-controlled-delivery.md)
for the authority journal, source/check binding, database compatibility and
held-effect recovery requirements. Test an actual account-backed release and
recovery against the approved target before relying on automation; local doubles
and a successful branch Preview do not establish those effects.

Account-backed end-to-end verification remains pending, including native host
and browser continuity and the applicable F06–F08 acceptance and recovery
evidence. F09 Coder OAuth and F10 in-app Codex/Claude connections remain
separate, deferred roadmap work; see the
[account connection audit](../../docs/checks/autonomous-delivery/account-connections-roadmap.md).
