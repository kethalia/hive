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

## Primary vendor references

- [OpenNext setup](https://opennext.js.org/cloudflare/get-started)
- [Custom Worker entry](https://opennext.js.org/cloudflare/howtos/custom-worker)
- [Runtime-specific packages](https://opennext.js.org/cloudflare/howtos/workerd)
- [OpenNext environment handling](https://opennext.js.org/cloudflare/howtos/env-vars)
- [Workers redirect support](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Prisma v6 JavaScript engine](https://www.prisma.io/docs/orm/v6/reference/prisma-client-reference)
