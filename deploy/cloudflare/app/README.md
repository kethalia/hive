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
requests require its separate `Authorization: Bearer …` header and otherwise receive 401 before
OpenNext or database access. Query parameters never authorize preview access. The credential is
stripped before framework/upstream handling. `assets.run_worker_first` covers static assets, and
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
node deploy/cloudflare/app/prepare-deployment.mjs
```

Preparation requires the exact ready artifact and successful committed app proof, including its
private HTML/static-asset checks. It also requires a read-only account/name/quota audit no older
than 30 minutes in `cloudflare-app-preflight.json`. The sampled usage check is evidence of apparent
included-allowance headroom, not an invoice or future billing guarantee. Refresh it before a
deployment decision if stale. No additional charges or paid products are authorized.

The script creates a fresh private directory containing separate app/auth secret files and
configs; it reads only the isolated runtime database URL and creates distinct preview, internal
service, encryption and cookie secrets. Owner database URLs and Coder passwords/tokens are never
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

## Primary vendor references

- [OpenNext setup](https://opennext.js.org/cloudflare/get-started)
- [Custom Worker entry](https://opennext.js.org/cloudflare/howtos/custom-worker)
- [Runtime-specific packages](https://opennext.js.org/cloudflare/howtos/workerd)
- [OpenNext environment handling](https://opennext.js.org/cloudflare/howtos/env-vars)
- [Workers redirect support](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Prisma v6 JavaScript engine](https://www.prisma.io/docs/orm/v6/reference/prisma-client-reference)
