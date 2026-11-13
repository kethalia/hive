# Cloudflare application runtime

Hive uses one `hive` Worker with production settings and isolated branch Previews.
Repository-connected Workers Builds runs the pinned OpenNext build and Wrangler.
The P01 foundation was merged through PR449. P01b adds existing application
features needed for the production move. Coder OAuth remains the next increment.

## Build and validate

Use the pinned pnpm version and lockfile.

```sh
pnpm install --frozen-lockfile
pnpm build:cloudflare
pnpm typecheck
pnpm typecheck:cloudflare
pnpm test:cloudflare
pnpm exec vitest run
```

The Node application retains `pnpm build` and standalone verification. Cloudflare
build output lives separately. Build readiness pins executable sources, generated
Prisma clients, runtime scripts and template archives. The build removes
OpenNext's embedded local environment module before marking output deployable.

## Deployment settings

The connected repository uses root `/`, build `pnpm build:cloudflare`, production
command `node deploy/cloudflare/native/deploy.mjs production` and preview command
`node deploy/cloudflare/native/deploy.mjs preview`.

`wrangler.jsonc` defines production. `preview-profiles.json` enrolls each branch,
canonical origin, database and restricted runtime role. Production requires `main`,
`hive_production`, `hive_production_runtime` and `https://hive.kethalia.com`.
Preview requires `hive_foundation_preview` and `hive_foundation_runtime`.
HTTP, scheduled work and background alarms validate this scope before database use.

P01b's Preview is
`https://codex-hive-production-cutover.hive-preview.kethalia.com`.
Its original `workers.dev` URL redirects browser navigation to this canonical host.
New deployment-specific URLs on `hive-preview.kethalia.com` and `workers.dev`
also redirect GET and HEAD navigation to the stable branch Preview, preserving
the path and query. This keeps authentication and workspace-app cookies on the
same-site origin. Historical immutable deployments run their original routing
code. Use the stable branch URL when sharing the Preview.
The same-site Preview exercises Coder workspace-app cookies under the production site.
Configure its existing Workers Builds Preview settings for automatic branch builds.
The P01 acceptance deployment remains documented in `docs/checks/cloudflare-foundation`.

Provision `DATABASE_URL`, `ENCRYPTION_KEY`, `COOKIE_SECRET` and
`AUTH_SERVICE_SECRET` through Cloudflare runtime settings. During cutover, retain
the serving application's encryption/session keys and existing database VAPID keys.
Transfer production data and apply the compatibility migrations before activating
the production build. Its source configuration binds the Custom Domain directly.
The Kubernetes retirement PR follows production verification.

## Workspace capabilities

Existing commands execute through Coder's reconnecting PTY API with the requesting
user's credentials and current workspace/build/agent ownership checks. Fixed
server-built commands implement inventory, repository sessions and file tools.
Build-pinned scripts provide agent configuration and notification hook installation.
Clipboard uploads retain their existing size/type contract through a bounded PTY
writer. `/ws/audio` carries the existing native audio protocol.

Terminal diagnostics persist connection leases and bounded events in Neon. Their
callbacks own independent database lifetimes, including after an upgraded request
ends. Clone terminals retain their signed repository proofs and current-session
binding. Next actions retain build-export admission, authentication, input checks
and bounded request bodies.

## Background processing

`HiveBackground` is a SQLite-backed Durable Object in the same Worker. Each Hive
user has a separate actor. Its small storage contains the owner and next wake time.
Notification events, template jobs, claims and credential-rotation state live in
Neon. Queue producers commit their records before requesting a durable alarm.

An alarm runs bounded owner-scoped batches, drains provider operations, then
schedules the next durable due time. Concurrent wakes preserve the earliest time.
Failures retain a fallback alarm. The hourly Cron Trigger repairs interrupted
commit-to-wake handoffs and expires abandoned diagnostic records. Idle queues
wake Neon when pending work becomes due.

Cloudflare creates separate Durable Object namespaces for each Preview. Classes
and SQLite migrations stay at the top level, while each Preview declares its
binding. The existing paid account's included capacity is the deployment budget.

## Acceptance before production activation

- Sign in, open workspaces and Settings, then reload.
- Create, resize, reconnect, rename and close an ordinary terminal.
- Discover repositories and open a signed repository terminal.
- Exercise file/path tools, clipboard upload and agent configuration.
- Test native audio and existing Codex voice controls.
- Enable notifications and verify a callback opens the correct workspace.
- Publish a template, close the browser and return to its durable job/log view.
- Exercise retries, owner isolation, credential rotation and terminal diagnostics.
- Rehearse data transfer, compare original rows and verify runtime permissions.
- Verify the deployed source revision and each result through the hosted Preview.

Record pending checks explicitly in the PR evidence. The migration sequence is in
`docs/autonomous-delivery-pr-migration.md`.
