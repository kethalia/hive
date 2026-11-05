# Inactive production Worker reservations

These three configurations reserve `hive-app-production`, `hive-auth-production`,
and `hive-jobs-production` in the specified account. They all use the same inert
bootstrap Worker: every HTTP request receives `503 deployment_pending` with private,
no-store caching. It does not connect to a database, proxy to Kubernetes, load assets,
use secrets, or run scheduled jobs. Worker public and preview URLs are disabled; there
are no routes, custom domains, or cron schedules. These files do not themselves create
or deploy a Worker. Observability is disabled for this inactive, cost-constrained stage.

These reservations are placeholders, not validated production application runtimes.
After the reviewed source reaches main, the final app/auth/jobs artifacts, environment
bindings, data migration, deployment policy and live activation each require their own
validation and controlled rollout. Do not attach routes or schedules as part of this
reservation. Verify the provider's effective URLs, routes and schedules after any upload;
configuration files alone cannot establish provider state.

Run `node --test deploy/cloudflare/production/production.test.mjs` to check the
reservation configuration and bootstrap response.
