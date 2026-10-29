# Worker authentication compatibility slice

`worker.ts` hosts Hive's existing authentication domain on a Fetch transport. It imports no
Node HTTP listener, Redis connection, BullMQ consumer or Kubernetes authentication service.
The application uses an `AUTH_SERVICE` binding and an explicit internal service secret in
Workers; missing authority fails closed. The existing Node URL client/singleton is preserved.
Both Workers use request-local full-schema Prisma 6.19.3 clients and the Neon WebSocket adapter.

The Fetch transport preserves login/session/logout/credentials/token contracts, authenticates
before routing or reading bodies, limits JSON bodies to 1 MiB and hides backend error details.
Worker login derives client IP from Cloudflare's ingress-supplied `CF-Connecting-IP`, ignores
browser forwarding headers, then propagates that IP through an authenticated internal header.
Existing rate limits remain in memory per isolate; this is not durable distributed throttling.

Runtime bindings are `DATABASE_URL` (only `hive_app_runtime` on `hive_app_preview`),
`AUTH_SERVICE_SECRET`, and `ENCRYPTION_KEY`. The app additionally requires `COOKIE_SECRET`.
Never bind the isolated database owner URL, production data, or an owner Coder token. Coder
origin remains server configured. No Worker is publicly enabled or cloud deployed by this slice.

## Bounded local proofs

```sh
pnpm --filter @hive/db db:generate:cloudflare
node deploy/cloudflare/auth/run-local-integration.mjs
```

The helper reads the private isolated runtime URL, validates database and role, creates fresh
local-only secrets, starts workerd on loopback, runs fixed synthetic fixture operations, deletes
only those run-owned rows, stops its process group and removes its private config directory.
It never prints connection strings, credentials or raw runtime logs. The fixed test harness is
not imported by the production auth Worker. It proves real sessions, encrypted credentials,
credential version CAS, full-schema Serializable interactive commit/rollback, parameterized
task row locking/server time, task reads and owner boundaries. Synthetic credential CAS is not
the scheduled rotation controller. A sanitized source-digest record is saved under
`docs/checks/autonomous-delivery/cloudflare-auth-local.json`.

After a fresh committed application build, `--app` additionally starts the actual app and auth
Workers with a real local service binding, seeds a signed synthetic session and task, exercises
the real authenticated list/detail routes, CSP/private caching, cross-site rejection and logout,
then removes the fixtures. It writes `cloudflare-auth-app.json`. The app's build readiness is
checked first. Run only after all tracked migrations for that source revision are applied to
the isolated database; the helper does not migrate or create resources.

```sh
pnpm build:cloudflare
node deploy/cloudflare/auth/run-local-integration.mjs --app
```

These proofs do not perform a real Coder login. A coordinated test-account login, actual key
rotation/revocation, authenticated browser evidence, host bridge and durable job transport remain
separate acceptance gates. No production cutover or complete F02/F07 claim follows from this slice.
