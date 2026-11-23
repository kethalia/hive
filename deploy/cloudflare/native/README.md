# Cloudflare application runtime

Hive uses one `hive` Worker with production settings and isolated branch Previews.
Repository-connected Workers Builds runs the pinned OpenNext build and Wrangler.
The P01 foundation was merged through PR449. P01b adds existing application
features needed for the production move. P02 supplies Better Auth and Coder OAuth,
and P03 adds workspace account connections.

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

Workers Builds uses the repository root and runs `pnpm build:cloudflare`.
Production runs `pnpm exec wrangler deploy --config deploy/cloudflare/native/wrangler.jsonc`.
Preview Builds uses the same Worker and runs
`pnpm exec wrangler preview --config deploy/cloudflare/native/wrangler.jsonc --name "$WORKERS_CI_BRANCH"`.
Cloudflare creates a Preview for each branch it builds. The Preview Build
command is copied when Cloudflare creates a branch Preview. When migrating an
existing Worker from the previous Hive deploy script, update previews that still
have the old command once. The `previews` block
inherited from `main` supplies the non-production database, runtime role and other
default bindings. Native runtime admission validates the database and role before
serving requests or running background work.

Use the branch's stable `*.hive-preview.kethalia.com` URL. The Worker derives the
request origin from that hostname and redirects `workers.dev` page loads to the
matching custom domain. Coder sign-in adds the exact callback to a single Preview
OAuth application through Coder Dynamic Client Registration, with its own
client secret and registration token. The app keeps up to 32 registered callbacks. When the list fills up, adding a
callback replaces the oldest entry, and starting sign-in on an existing callback
moves it to the front. A later sign-in registers a callback again if it was removed.

Provision the Preview Base secrets
`DATABASE_URL`, `ENCRYPTION_KEY`, `COOKIE_SECRET`, `AUTH_SERVICE_SECRET`,
`HIVE_AGENT_TOOLS_ISSUER_PRIVATE_KEY`, `HIVE_PREVIEW_CODER_OAUTH_CLIENT_SECRET`
and `HIVE_PREVIEW_CODER_REGISTRATION_TOKEN` once through Cloudflare runtime
settings. Use the scoped registration token for the Preview OAuth client, whose
public ID is in the `previews` block. Existing named Previews receive updated
secrets through `wrangler preview secret bulk`.
Production uses its own `CODER_OAUTH_CLIENT_SECRET` and registered callback.
The owner authorized a
fresh production start on 13 November 2026. Initialize the empty production schema,
apply scoped runtime grants and configure independent production secrets before
activating the production build. Its source configuration binds the Custom Domain.
At the approved maintenance window, stop Kubernetes background writers through
GitOps before fresh Cloudflare sign-in, deploy the reviewed main source and verify
production features, then finish residual application storage retirement.

## Preview versions in the installed app

In production Hive, open **Settings → App updates → Versions**. Hive
reads the public pull requests against `main`. The browser checks the deployed
identity at each preview URL, since native preview routes can reject subrequests
from the production Worker. A preview appears when it reports the branch
and current commit of a pull request from Hive’s own repository and supports
switching back to production. It fills the installed app on its own origin.
Sign in with Coder if prompted. Select **Production** from the preview’s
version picker to switch back.

Updating a branch from `main` after this feature ships adds its preview to the
list on its next native build. If a preview fails to load, the launcher offers
**Retry** and **Production**. To set up push notifications, open the preview’s URL
directly in your browser.

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
- Test native microphone and speaker controls.
- Enable notifications and verify a callback opens the correct workspace.
- Publish a template, close the browser and return to its durable job/log view.
- Exercise retries, owner isolation, credential rotation and terminal diagnostics.
- Verify fresh production schema initialization, runtime permissions and secret isolation.
- Verify the deployed source revision and each result through the hosted Preview.

Record pending checks explicitly in the PR evidence. The migration sequence is in
`docs/autonomous-delivery-pr-migration.md`.
