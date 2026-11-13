# Cloudflare foundation preview

P01 moves the baseline Hive application to an isolated branch Preview under the
existing `hive` Worker, using repository-connected Workers Builds. It includes the
current credential sign-in, authenticated workspace/settings reads, template
identity reads and ordinary terminal sessions. P02 introduces Coder OAuth.

## Build and validate

Use the pinned pnpm version and install from the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm build:cloudflare
pnpm typecheck
pnpm typecheck:cloudflare
pnpm test:cloudflare
```

The Node application retains `pnpm build` and its standalone verification. The
Cloudflare build preserves that output in a separate directory. Build readiness
checks pin executable sources, the shared terminal protocol, generated Prisma
client and output assets. The build removes OpenNext's embedded local environment
module before the artifact becomes deployable.

## Preview configuration

The source configuration is `wrangler.jsonc`. `preview-profiles.json` binds the
reviewed branch, canonical origin, database name, runtime role and schema count.
The deployment command admits that profile through the existing Workers Builds
credential and runs the official Wrangler preview command.

Configure the connected repository with root `/`, build `pnpm build:cloudflare`,
production command `node deploy/cloudflare/native/deploy.mjs production` and
preview command `node deploy/cloudflare/native/deploy.mjs preview`. The production
command holds activation for the separately approved P11 cutover package.

The P01 preview URL is
`https://codex-cloudflare-foundation-hive.b00ste.workers.dev`. It uses the enrolled
origin for application and terminal authorization. Branch settings and secrets are
scoped to this Preview. The Worker holds requests until the database URL identifies
`hive_foundation_preview` and `hive_foundation_runtime`, protecting against inherited
Preview Base credentials from a different test database.

Required secret names are `DATABASE_URL`, `ENCRYPTION_KEY`, `COOKIE_SECRET` and
`AUTH_SERVICE_SECRET`. Provision their values through the existing Cloudflare
Preview settings. Keep plaintext values in private local storage during setup.

## Database schema and permissions

P01 retains main's seven migrations and Prisma schema. Apply them to the isolated
preview database with the owner connection through `pnpm --filter @hive/db
migrate:deploy`. Configure the application with its restricted runtime connection.
The runtime role needs CRUD on the seven application tables, while the migration
ledger and schema administration belong to the migration owner. Verify the actual
role's privileges after setup.

The database lives in the existing Neon Free preview project and uses its current
compute. No production data is required for these acceptance scenarios.

## Terminal inventory and unsupported operations

Ordinary terminal connections use Coder's reconnecting PTY API. Session inventory
uses a fixed, bounded `tmux -L web list-sessions` query through that same authorized
transport. The inline Python wrapper frames its response and waits briefly for
acknowledgment, allowing short-lived commands to work with Coder's screen backend.
Owner, build and connected-agent identities are checked around the read. Errors
remain visible through the existing retry UI.

The preview admits reviewed Next server-action exports from the actual build
manifest. Routes and actions requiring later signed workspace helpers or durable
jobs return an unavailable response. The dependency inventory for subsequent PRs
includes terminal rename/kill, file/path helpers, agent configuration, voice,
clipboard assets and template publication. Their capability implementations travel
with the corresponding later increments in the PR migration plan.

## Owner acceptance checklist

- Open the Preview and sign in using the current Coder credential flow.
- Open the workspace list and Settings window, then reload the app.
- Inspect existing terminal sessions in a running workspace.
- Create a uniquely named terminal and observe shell output.
- Resize it, reconnect and confirm the same shell session remains attached.
- Exit the shell and verify the terminal reports a normal close.
- Check that the test session disappears from the refreshed terminal inventory.
- Push a branch commit and verify that Workers Builds updates this Preview.

Record the tested commit, preview deployment, app build, schema count, workspace
and outcomes in the PR evidence. Source and mocked transport tests complement the
actual Coder, Neon and Browser Testing checks.

## References

- [Cloudflare Worker Previews](https://developers.cloudflare.com/workers/previews/)
- [Cloudflare Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/)
- [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
