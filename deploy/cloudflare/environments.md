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
Host operations, delivery, schedules and R2 are initially disabled until that branch's
runtime and host enrollment pass their own acceptance gates.

Cloudflare Workers Builds connects `kethalia/hive` at repository root. It builds with
`pnpm build:cloudflare` and publishes branch previews with
`node deploy/cloudflare/native/deploy.mjs preview`. The main command is
`node deploy/cloudflare/native/deploy.mjs production`, which currently refuses activation.
The repo connection and dedicated build token are configured. A branch push has
already triggered a successful build; provider-managed preview URL association and
live application validation remain required. A merge alone cannot enable the
production runtime, secrets or data cutover.

The old app/auth/jobs compatibility Workers remain private and unscheduled while the
native replacement is validated. Their historical [prepared-artifact workflow](app/README.md)
and [deployment evidence](../../docs/checks/autonomous-delivery/cloudflare-app-deployment.json)
are retained, not the canonical new deployment layout. Their existing data and secret
identities must not be overwritten during migration.

Browser validation still runs in Browser Testing; Coder development workspaces remain
on Kubernetes. Existing production remains on Kubernetes until the user approves the
validated cutover. No production DNS or database change follows from this setup.
