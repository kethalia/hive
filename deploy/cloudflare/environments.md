# Cloudflare application environments

The epic uses separately named Workers in account `225177f82b9234ede14e897fe15e0cb5`.
The development workspaces still run in Coder's Kubernetes cluster; web application preview runs directly on Cloudflare.

| Component | Preview | Production reservation |
| --- | --- | --- |
| Application | `hive-app-compatibility-preview` | `hive-app-production` |
| Authentication | `hive-auth-compatibility-preview` | `hive-auth-production` |
| Background jobs | `hive-jobs-compatibility-preview` | `hive-jobs-production` |
| Database | Separate Neon `hive_app_preview`, restricted runtime role | Not bound until approved migration/cutover |
| Evidence | Private bounded R2 pilot bucket | Not bound until retention and release policy enrollment |
| Public origin | `https://hive-app-compatibility-preview.b00ste.workers.dev`, private preview authorization required | No route, domain or public URL |

Preview deployment follows [the prepared artifact workflow](app/README.md), preserving existing
secret identities and checking exact source, build proof, database target and provider ownership.
Auth and jobs stay service-only. Preview jobs are unscheduled except for a separately bounded
pilot; expiry is followed by explicit schedule removal. Browser validation runs in Browser Testing.
Preview's application gate is independent of Coder login; an ordinary unauthenticated URL visit
will not grant access. Bearer credentials must not be placed in links, source or conversation logs.

The [production bootstrap](production/README.md) reserves Worker identities only. It responds
`503 deployment_pending`, has no data credentials or outbound services, and is not a working
production application. Production activation requires reviewed main artifacts, a separately
scoped auth/database/issuer configuration, observation and recovery checks, and the user's
cutover approval. Merge alone does not activate the placeholders. Existing production remains
on Kubernetes until that approved cutover; no DNS or production database changes occur here.

Current deployed versions and validation limits are tracked under
[`docs/checks/autonomous-delivery`](../../docs/checks/autonomous-delivery/cloudflare-app-deployment.json).
Do not use the legacy root reverse-proxy config as the new application deployment target.
