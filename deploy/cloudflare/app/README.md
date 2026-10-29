# Actual Hive application compatibility build

This builds the existing Hive Next.js application with the vendor OpenNext adapter. It is
separate from the small `epic-preview` fixture and the production edge proxy. No cloud deployment
or resource mutation has been performed for this slice. Public Workers URLs are disabled in the
committed configuration; no R2, Hyperdrive, Queues or Durable Object resource is configured.

## Build and local runtime

```sh
pnpm build:cloudflare
pnpm preview:cloudflare --port 8792
```

This preview is private by default. A missing/invalid runtime `PREVIEW_BEARER` returns 503;
requests require its separate `Authorization: Bearer …` header or the signed private-preview
cookie and otherwise receive 401 before OpenNext or database access. The only cookie bootstrap is
an empty bearer-authenticated POST to `/__hive-preview/access` with the exact configured Origin.
It issues a Secure/HttpOnly/SameSite=Strict `__Host-` cookie, HMAC-bound to that origin for at most
15 minutes, with no Domain. A cookie cannot renew itself. Query parameters never authorize preview
access. Both preview credentials are stripped before framework/upstream handling. `assets.run_worker_first` covers static assets, and
authorized responses use private/no-store caching. An unconfigured manual local server therefore
remains closed. The bounded `auth/run-local-integration.mjs --app` helper privately generates and
supplies the header for synthetic app tests; it never places credentials in URLs or logs.

Versions are pinned: OpenNext 1.20.14, Wrangler 4.155.0 and Prisma/adapter 6.19.3; the existing
Next 16.4.1 application is preserved. `build`, `start`, and `postbuild` retain their Node behavior.
The adapter invokes `next build --webpack`; no dependency or compatibility-version bypass is used.

OpenNext currently hardcodes `.next`. The build wrapper takes a local lock, preserves the existing
Node `.next`, builds using `.next`, then stages the Cloudflare result at `.next-cloudflare` and
restores the Node directory. Do not run a Node build/dev server concurrently. A terminated build
can leave `.artifacts/cloudflare/build.lock` and a preserved `node-next-*` directory: inspect its
process/task ownership and recover the saved directory before retrying; never delete it blindly.

The vendor copies local `.env*` values into `.open-next/cloudflare/next-env.mjs`. This wrapper
replaces those generated exports with empty objects on normal completion and catchable failure.
It invalidates the build-ready record before each build and writes a new record only after a
successful build, scrubbing and unchanged-source checks. The supported preview command verifies
that record, the empty environment module, current source/generated-client digests and key output
digests before starting workerd. SIGKILL can leave partial output, but without a readiness record
the supported preview command refuses it. Raw Wrangler bypasses this guard and is not a supported
interrupted-build recovery path. Runtime secrets must be explicit Worker bindings. Source `.env*` files are not moved or
printed. Cloudflare-only tracing excludes templates, Git state, task artifacts and local env files;
host-side helper/template operations remain outside this preview.

The actual application built and ran in local workerd at committed `fbafe43`: `/login` returned
real SSR HTML and its sign-in form; `/runtime-config.js` returned JavaScript. The clean frozen-lock
install generated both clients, and the dry-run upload was 21,159.33 KiB uncompressed / 4,947.91 KiB
gzip with 138 assets. See [committed build evidence](../../../docs/checks/autonomous-delivery/cloudflare-app-build.json).
Root and recursive package typechecks passed. That evidence predates the auth binding/conditional
DB export followup; each subsequent source change requires a new committed build before preview.
The earlier [working-tree evidence](local-evidence.json) is retained with its original limitations.

OpenNext warns that the application's Node `proxy.ts` middleware support is experimental and
not officially maintained. Anonymous SSR and boundary checks ran successfully; authenticated
cookie/CSP behavior still requires full integration and browser validation before activation.

## Database seam

`packages/db/scripts/generate-cloudflare.mjs` derives a `workerd` JavaScript-engine generator from
the canonical schema without modifying schema/migration ownership. It generates the full Hive
client at ignored `packages/db/src/generated/prisma-workerd`. Node's client and singleton remain.
The `workerd` package export chooses a request-only entry whose runtime Prisma exports come from
that generator, avoiding eager native-engine path setup. Cloudflare-only `serverExternalPackages`
keeps this package out of Next's Node bundling so Wrangler resolves its runtime and WASM imports.

The custom Worker creates a lazy request-local `PrismaNeon` WebSocket client. `getDb()` first
consults AsyncLocalStorage, shared by a global symbol across separately bundled modules. Clients
never live in a global Worker singleton. Missing request context fails closed in Workers. The
pool remains alive through response streaming and tracked `waitUntil`/Next `after` work, then
disconnects; canceled and failed rendering also clean up. Interleaved requests, duplicate module
copies, cleanup and streaming lifetime have focused tests.

The [auth local proof](../auth/README.md) exercises actual full-schema Serializable transactions,
row locks, sessions and task-read functions against the isolated `hive_app_preview` database.
The app route/service-binding proof is a separate supported mode; see its actual evidence before
claiming it passed. Owner credentials never become Worker bindings. Serialization retry behavior
and generated Node/Worker error metadata still require their own repository-level checks.

## Remaining host and authentication boundaries

The app still uses the `AuthServiceClient` contract. Its portable requests use `redirect: manual`
and explicitly reject every 3xx before consuming a body or forwarding credentials. Without a
preview auth binding, `/api/auth/login` returns 503. The separate auth Worker reuses the existing
domain; Workers clients require its binding and secret and never fall back to a Node/Kubernetes URL.
The Node service URL behavior is unchanged. Real account login and rotation remain pending.

The wrapper returns explicit 503 for all upgrade requests, the retired workspace-proxy path,
native server actions, template operations, discovery,
GitHub-project discovery, terminal tickets, voice/paste operations, notification event ingestion
and notification installer mutations. Those paths still need scoped workspace transport or
durable jobs. It does not invoke SSH, tmux, Git, Python, Coder CLI or BullMQ consumers in Workers.
Background startup consumers are disabled for the Cloudflare build. These temporary boundaries
are explicit capability gaps, not feature parity or production defaults.

Next: real Hive login/session/credential behavior on a Worker auth implementation, full-schema
transaction/task reads against the isolated app DB, authenticated middleware tests, host bridge,
terminal transport, durable jobs, cache/ISR choices and browser evidence. No production cutover
or complete F02 acceptance follows from this build alone.

## Prepared deployment, with no cloud write

After committing source, building in the retained clean validation checkout, and running the
guarded `--app` proof at that revision:

```sh
HIVE_PREVIEW_IDENTITY_FILE=/tmp/hive-epic-coder-auth/app-preview-identity.json \
  node deploy/cloudflare/app/prepare-deployment.mjs
```

Preparation requires the exact ready artifact and successful committed app proof, including its
private HTML/static-asset checks. It also requires a read-only account/name/quota audit no older
than 30 minutes in `cloudflare-app-preflight.json`. The sampled usage check is evidence of apparent
included-allowance headroom, not an invoice or future billing guarantee. Refresh it before a
deployment decision if stale. No additional charges or paid products are authorized.

The script creates a fresh private directory containing separate app/auth secret files and
configs; it reads only the isolated runtime database URL and an explicitly selected private
preview identity. For the first preparation only, add `--create-preview-identity` to create that
file if absent. Its parent must be owned by this user with mode700; the regular, single-link
file must have mode600 and cannot use a symlink. The identity is pinned to this account, Worker
names and exact isolated database endpoint/name/role. Preserve it outside the checkout for later
preparations: encryption, Hive-cookie, preview-cookie, internal-service and bearer keys are reused
across artifacts. Missing or mismatched identity fails closed; this command does not rotate keys.
App and auth share the encryption key required by their existing encrypted Coder-token
architecture and the internal service secret. The manifest records identity ID/scope digest only.
Owner database URLs and Coder passwords/tokens are never
bound. A private manifest ties source, tested artifact, account, configs and a maximum of 30
scripted requests together. It rejects routes, cron, public URLs and additional product bindings;
both Workers cap request CPU at 100 ms, with stored observability logs disabled.

Wrangler 4.155.0 is already authenticated to the reviewed account with Worker write scopes.
The connected API handles read-only account/version checks, but exposes no local artifact upload
handle: module APIs require multipart bytes or inline base64, and the upload-session API concerns
static assets. The concrete full-bundle path is the existing authenticated Wrangler CLI, first
uploading the private auth service and then the app with its separate private secrets file.
Wrangler handles module/WASM/static-asset uploads. The app's measured 21.16 MiB and auth's 3.58 MiB
fit the current 64 MiB uncompressed Worker limit; startup/runtime validation still follows upload.

Do not run uploads or enable URLs until the primary confirms the exact prepared revision, config,
fresh headroom and bounded test plan. No route/DNS change, cron activation, add-on, new login or
production cutover is part of preparation. Any eventual temporary public app URL must retain the
bearer gate for every asset/request; auth remains service-only. Preserve deployment/version IDs,
sanitized results and disable public URLs after the authorized bounded probes. Browser automation
requires origin-scoped authorization handling in Browser Testing and remains a separate gate.

## Scoped project WebSocket compatibility relay

The Worker accepts only GET upgrades at `/api/projects/<uuid>/session` and the separately enabled
`/api/projects/<uuid>/terminal`; no query, caller-selected origin/path or subprotocol credential is
accepted. Both require the private preview gate and the Hive signed session. The relay independently
checks owner/project/active registration/current Coder build and checks them again after the
request-local Coder app-cookie exchange. Only the fixed registered `/session` or `/terminal` URL
receives an upgrade with its app-scoped cookie and the fixed configured Hive Origin. Caller headers,
owner cookies/tokens, upstream Set-Cookie/Location and upstream close reasons are never forwarded.
The host still requires the separately signed read or terminal ticket; a transport connection does
not confer native RPC or terminal authority.

Initial database clients close before a 101 response is returned. The local followup removes the
60-second transport cap: a serialized check every 20 seconds freshly verifies the Hive session,
owner, current Coder build/app and active registration. Each check creates its own database scope
and closes it before publishing renewed authority. Only the same registration/build/server/thread
identity may extend its lease; initial preview-cookie and Hive-session expiry remain hard limits.
Initial setup and each refresh have a 10-second cancellation deadline. Coder requests combine this
signal with existing shorter bounds, and relay database scopes configure Neon `query_timeout` and
Prisma transaction/max-wait bounds of 10 seconds. Cancelled SQL reads drain before disconnect;
checkpoints prevent later queries from starting. This does not promise instantaneous PostgreSQL
cancellation. Reservations remain held until cleanup drains; `waitUntil` retains only cleanup.

Traffic is limited to 1 MiB per frame, 8 MiB and 256 messages per second, supported send buffering,
and four per-isolate reservations. Close/error/revocation/timeout stops scheduling and closes both
peers once. Current local evidence is not live Coder/browser acceptance, and the existing 100 ms
Worker CPU limit is unchanged. The previously deployed preview kept gateway/terminal flags off.
Terminal routing remains explicitly disabled unless configured and validated.

The actual local workerd fixture uses a second Worker service binding as its simulated provider.
It proved text/binary forwarding, sanitized close, oversized-frame rejection and earlier-expiry
closure. Its sustained mode also kept the same socket open for over 66 seconds through three
fresh authorization checks. Provider and auth metadata are simulated; it does not prove real Coder
authentication or registered host data. See
`docs/checks/autonomous-delivery/cloudflare-relay-local.json` and the preserved first failure.
The real runtime caught a March-2026 compatibility change: binary frames default to Blob. The
relay explicitly sets `binaryType = "arraybuffer"` on both sockets before accept, preserving
synchronous frame limits. Run the bounded transport proof with:

```sh
node deploy/cloudflare/app/run-local-relay-proof.mjs
node deploy/cloudflare/app/run-local-relay-proof.mjs --sustained
node deploy/cloudflare/app/run-local-database-bounds.mjs
```

The last command uses only the restricted isolated Neon runtime URL and fixed read-only
`SELECT pg_sleep(2)`. The actual local Workers proof configured a 500 ms query timeout, observed
`query_read_timeout`, and completed scope close after the rejected read.
See `cloudflare-database-bounds.json`; this records actual rejection and cleanup timing separately.

## Native host callbacks

With the gateway flag explicitly enabled, only JSON POSTs at `/api/codex-host/registrations` and
`/api/codex-host/registrations/<uuid>/heartbeat` may reach the existing native handlers without a
preview cookie/bearer. Queries, encoded path components, browser Origin/fetch metadata, upgrades,
Next Actions, compression and oversized declared bodies retain the outer private gate. This
transport exception does not authenticate a host: native issuer/host signatures, replay fences and
current registration checks remain mandatory. Preview/Hive browser credentials cannot replace
native authority. Other APIs and assets remain private. The default gateway flag remains off.

Handlers bound registration JSON to 64 KiB, heartbeat JSON to 4 KiB, reads to five seconds and
1024 chunks, and cancellation wait to 100 ms. Unit route integration rejects a well-formed grant
signed by another issuer before database or browser-session access. Actual host callback and
browser/native integration require a separately reviewed committed build and bounded preview plan.

## Primary vendor references

- [OpenNext setup](https://opennext.js.org/cloudflare/get-started)
- [Custom Worker entry](https://opennext.js.org/cloudflare/howtos/custom-worker)
- [Runtime-specific packages](https://opennext.js.org/cloudflare/howtos/workerd)
- [OpenNext environment handling](https://opennext.js.org/cloudflare/howtos/env-vars)
- [Workers redirect support](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Workers WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- [Current binary WebSocket defaults](https://developers.cloudflare.com/changelog/post/2026-04-21-websocket-standard-binary-type/)
- [Prisma v6 JavaScript engine](https://www.prisma.io/docs/orm/v6/reference/prisma-client-reference)
