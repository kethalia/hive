# D01/F02: Cloudflare and Neon capability audit

Date: 2026-10-29. Source revision inspected: `d02e55438caa10041b1fbdccec9033cf21c62fab`
on `codex/delivery-system-design`. Workspace profile: `software` / image variant `cli`.
Scope: source inspection and current official documentation; no deployment, resource creation,
secret retrieval, production request, database mutation, or browser validation performed by this
audit. Account/credential inspection and the specialist workspace record belong to the primary
agent's separate evidence. F02 remains **unproven** until the real preview checks below run.

## Finding

Hive can move its web/API and durable orchestration to Workers with PostgreSQL on Neon, but
the current deployment is a Cloudflare reverse proxy over a Kubernetes application. Deploying
that proxy again would not demonstrate F02. The existing application requires changes to its
database client, internal authentication boundary, workspace transport, queues, and local-file
assumptions. A request-only Worker that reads Neon is a useful first probe, not acceptance of
the complete framework/auth/terminal/workspace gate.

Two assumptions in older guidance need correction. Cloudflare's current Next.js guide recommends
**vinext**; OpenNext remains documented as an alternative for existing applications. Also,
Workers now supports a virtual `node:fs`; inability to execute binaries or retain host files
between requests is the relevant restriction, not the presence of an `fs` import.
Sources: [Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/),
[OpenNext guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/),
[Workers filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

## Repository evidence and migration boundaries

Paths below are relative to the repository root. These are inspected implementations, not
runtime results from Cloudflare.

| Surface | Current source evidence | Required change / preview proof |
| --- | --- | --- |
| Cloudflare deployment | `deploy/cloudflare/worker.mjs` forwards every application request to `HIVE_ORIGIN`; `wrangler.jsonc` selects this worker. Its tests exercise proxy/header/cookie behavior. | Keep existing edge operation intact; use a distinct preview Worker whose API and rendering execute in Workers. An origin response behind `workers.dev` is insufficient. |
| Framework | Root `package.json` uses Next `^16.4.1`, React 19 and `pnpm@10.32.1`; no vinext/OpenNext/Wrangler dependency or framework adapter config exists. `next.config.ts` emits Node `standalone`, traces Python helper files, and suppresses TypeScript build errors. | Pin an adapter and Wrangler in the existing lockfile; produce an adapter build and workerd execution. Preserve redirects, headers, server actions, RSC and streaming. A successful `next build` alone proves neither compatibility nor type safety. |
| Prisma | `packages/db/prisma/schema.prisma` generates ESM with `runtime = "nodejs"`. `packages/db/src/index.ts` creates an adapter-free process-wide `new PrismaClient()`. Prisma/client are `^6.19.3`; no edge adapter exists. | Generate a Worker-compatible, JavaScript-engine client with a supported driver adapter; obtain clients inside request scope. Keep Node consumers working during migration. Test the actual schema, UUID/Bytes/timestamptz/JSON values and transactions from deployed workerd. |
| Auth | `src/lib/auth/session.ts` verifies a signed cookie, then calls `AuthServiceClient`. `src/lib/auth/service-client.ts` defaults to `http://localhost:4400`; `services/auth/src/server.ts` is a Node HTTP service protected by `AUTH_SERVICE_SECRET`. Coder credentials are encrypted in PostgreSQL. | Replace the internal Node listener with a Worker service binding or shared authenticated server functions. Use preview-specific cookie/encryption secrets and Neon session/token rows. Prove sign-in/session expiry/revocation, cookie scope, owner isolation and Coder API access without depending on the old auth origin. |
| Coder HTTP/TLS | `src/lib/coder/client.ts` has ordinary authenticated HTTP APIs. `src/lib/coder/fetch.ts` uses standard `fetch` by default, but switches to an Undici dispatcher with configured private CA certificates when `CODER_CA_CERT` is set. | First verify public TLS to `https://coder.kethalia.com` from the deployed preview. Private-CA behavior is a separate compatibility test; Node dispatcher options cannot be assumed to work identically in Workers. Keep credentials server-side. |
| Workspace operations | `src/lib/agents/workspace.ts` reads the Python source from the server filesystem and invokes `ssh` with `ProxyCommand=coder ssh`. `src/lib/workspace/exec.ts`, `paste-assets.ts`, `src/lib/push/install.ts` and `src/lib/codex/voice-connection.ts` also spawn binaries. | Move executable work to the software workspace; define an authenticated, bounded HTTP/WebSocket adapter with owner/workspace/operation validation, time/output limits and replay keys. Prove its route through Coder. Neither a fetch to the Coder health endpoint nor a hidden SSH sidecar completes this requirement. |
| Files and templates | Template hashing reads `process.cwd()/templates`; helper installers read traced Python files. `src/lib/git/clone-discovery.ts` scans local clones. Template push runs the Coder CLI, writes `/tmp/template-push-<job>.log`, and another request streams that file. | Bundle immutable helper text/manifests or distribute versioned objects; keep clones/execution in their owning workspace. Store durable logs/evidence in R2 with database references. A different request cannot rely on a prior Worker request's `/tmp`. |
| Background work | `src/instrumentation.ts` starts three BullMQ consumers at Node startup: template push, token rotation and notifications. `src/lib/queue/connection.ts` uses an indefinitely blocking Redis connection. | Replace consumers with Queues handlers, scheduled handlers and Workflows. Preserve idempotency, revocation rechecks, retry/backoff and outbox reconciliation. `HIVE_DISABLE_BACKGROUND_WORKERS=true` is useful during the probe but does not migrate these features. |
| Discovery cache | `src/lib/discovery/server-cache.ts` uses Redis plus bounded process memory and generation invalidation. | Cache failures must remain nonfatal; treat Worker memory as an optional local cache. Shared invalidation semantics need a deliberate replacement before claiming parity. |
| Terminal/audio | `services/terminal-proxy/src/index.ts` owns a Node HTTP server. `proxy.ts` uses `ws` server upgrades, heartbeat timers and process connection registries. `protocol.ts` connects to Coder's `/api/v2/workspaceagents/<id>/pty`; the tmux process lives in the workspace. Audio and voice add separate transports. | Port the relay to Worker WebSocket APIs and authenticated upstream fetch, or another explicitly accepted Cloudflare service. Preserve ticket/origin validation, fresh workspace-agent authorization, binary frames, resize, backpressure and reconnect identity. Reconnect must attach the same tmux/session. Do not claim audio/voice parity from terminal success. |
| Push | `src/lib/push/send.ts` uses `web-push`; VAPID material is persisted in `vapid_keys`; current delivery goes through BullMQ. | Verify its HTTP/crypto behavior in workerd or replace its transport. Preserve existing subscriptions/VAPID identity for cutover; use distinct test subscriptions/keys in preview. This is an F07/F08 obligation beyond an initial API probe. |

Workers exposes `child_process` as a **nonfunctional compatibility stub**. Import success is not
evidence that `spawn` or `execFile` can run `coder`, `ssh`, Python, Git or Terraform. Its virtual
filesystem has read-only bundled modules and request-local, memory-backed `/tmp`; it has no
access to the software workspace's persistent clones. Node HTTP compatibility also does not turn
an existing long-lived Node server into the lifecycle of a Worker.
Sources: [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/),
[filesystem semantics](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

## Recommended implementation slices

These are recommendations to validate, not decisions that authorize production changes.

1. **Isolated deployment/DB probe.** Add a separate preview Worker and reproducible build commands;
   record source SHA, artifact digest, Worker/version identity, account and Neon branch identity.
   Use test-only secrets/data. Provide authenticated capability endpoints and reject unauthenticated
   calls. Keep production routes, auth service and databases untouched. A small plain Worker first
   isolates networking/driver faults, but explicitly labels the framework and workspace gates pending.
2. **Prisma transport seam.** Preserve Prisma 6.19 while adding `engineType = "client"`, a
   `workerd` generated target and a request-scoped factory; retain the existing Node entry during
   transition. Prefer `pg` plus the matching `@prisma/adapter-pg` through Hyperdrive, backed by an
   isolated Neon branch. Disable query caching for authorization/state reads in the probe. Keep
   migrations as reviewed Prisma migration files executed externally using a direct Neon URL,
   not from a Worker startup hook. A Neon serverless adapter is a fallback requiring its own
   transaction/connection-lifecycle proof, not a simultaneous second implementation.
3. **Framework build spike.** Start with OpenNext for this existing Next application because it
   adapts `next build` and explicitly supports Next 16. Compare vinext using a bounded compatibility
   check before committing to a framework migration. Pin the chosen versions and record the choice.
   Separate Node-only imports behind actual runtime module boundaries; merely disabling startup
   consumers does not remove route imports or unsupported execution paths. Maintain existing
   standalone verification for the production runtime until cutover.
4. **Authentication and Coder API.** Move the test auth/session path into Cloudflare using the
   existing signing/encryption semantics; migrate the current auth service contract through a
   binding/shared function seam. Prove one host-locked Coder API request authorized by a test
   session, expired/revoked-session rejection, and cross-owner rejection. A development bearer
   gate around `SELECT 1` does not satisfy Hive authentication compatibility.
5. **Workspace/terminal bridge.** Prove a private Coder-routed bounded agent endpoint in the
   software workspace. Start with read-only inventory and a harmless fixed operation. Independently
   prove a Worker-to-Coder PTY relay with existing tickets and reconnect identity. Any generic exec
   transport, arbitrary URL forwarding, or production credential inheritance needs review before
   use. F04's shared native Codex thread remains a separate gate.
6. **F07/F08 parity and cutover.** Implement queues/outbox/reconciliation, scheduled rotation,
   template execution through the software workspace, R2 preservation, push, audio/voice and
   durable observation. Then rehearse session/data migration and rollback/write handling. A preview
   that retains an old Hive auth/terminal/job service as a bridge must enumerate that dependency
   and cannot pass the “no hidden Kubernetes Hive service” F07 gate.

Prisma's **v6** documentation confirms its Rust-free engine is GA from 6.16 and requires a driver
adapter; its generator supports `workerd`. Thus a Prisma major upgrade is unnecessary for the
first proof. Cloudflare documents `adapter-pg` with Hyperdrive; version-match the adapter to the
existing Prisma client rather than copy current v7/v8 examples blindly.
Sources: [Prisma v6 client](https://www.prisma.io/docs/orm/v6/reference/prisma-client-reference),
[Prisma v6 generators](https://www.prisma.io/docs/orm/v6/prisma-schema/overview/generators),
[Cloudflare Prisma/Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/prisma-orm/),
[OpenNext support](https://opennext.js.org/cloudflare).

## Free-plan feasibility and constraints

Published allowances checked on 2026-10-29; these do not prove the connected account's entitlement,
remaining quota, billing configuration or enabled products. Shared account usage reduces headroom.
Keep a Free-first prototype bounded; measure before selecting a paid plan or promising zero cost.

| Product | Current published Free allowance relevant to Hive | Consequence |
| --- | --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU/invocation; 128 MB memory; 50 subrequests/request; six simultaneous outbound connections; one-second startup. | Rendering, Prisma, crypto and JSON parsing require real CPU measurements. Waiting on network is not CPU, but a small request count cannot prove SSR fits. [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker bundle/assets | 64 MiB **uncompressed** bundle; 20,000 static assets, each at most 25 MiB. | Measure dry-run upload size/startup. Older OpenNext text still describes obsolete compressed 3/10 MiB limits; Cloudflare removed those in September 2026. [Size change](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/) |
| Hyperdrive | 100,000 database statements/day; exceeding the quota fails operations until reset. | Count statements, including mutations; one app request may consume several. [Pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Queues | 10,000 operations/day; 24-hour retention on Free. Operations meter writes, reads and deletes by 64 KB chunks. | A small successful message usually uses three operations; retries/payload size increase usage. Queues cannot be the sole durable task/evidence record. [Free availability](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/#queues) |
| Workflows | 3,000 steps/day; 1 GB-month storage; Workers request/CPU allowances shared. Free has 100 concurrent instances, 1,024 steps/instance and 100 MB state/instance. Completed state defaults to three-day retention. | Persist canonical delivery state in Neon and evidence in R2; keep workflow state/results small. Sleeping can wait efficiently but does not provide indefinite evidence retention. [Pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| R2 Standard | Monthly free tier: 10 GB-month storage, 1M Class A and 10M Class B operations; Internet egress free. | Use bounded object sizes/retention and private bindings. This is an allowance, not an unlimited storage or billing guarantee. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Neon | 100 projects; 10 branches/project; 100 CU-hours/project/month; 1 GB PostgreSQL/project, 20 GB account total; 5 GB public transfer/project/month; up to 2 CU; mandatory suspension after five idle minutes. | Use one isolated test environment, record cold-start/reconnect behavior and prevent polling that defeats suspension. No Free SLA; monitoring/history are short. Old 0.5 GB/50 CU-hour figures are stale. [Current plans](https://neon.com/docs/introduction/plans) |

The likely first Free constraint is measured per-request CPU for a framework/Prisma/auth path,
not necessarily request count. This is an engineering risk to test, not a claim of a measured
failure. Containers are not a Free escape hatch for unchanged Node/CLI services: they require
Workers Paid. [Workers and Containers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Evidence required before F02 is accepted

All items below are **pending** in this audit. Attach actual sanitized outcomes and deployment
identity; label mocks/local workerd/deployed integration/browser results separately.

- Adapter build plus `wrangler deploy --dry-run`: exact versions, uploaded bytes, startup timing,
  explicit typecheck outcome and unsupported imports. Run a real authenticated deployed request
  and record Worker CPU/error telemetry for cold and warm calls.
- Prisma against isolated Neon: existing-schema CRUD/relations and representative binary/date/JSON
  round trips; interactive transaction commit and deliberate rollback; unique-key replay;
  concurrent conditional update/lease claim with exactly one winner; disconnect/retry and branch
  cold-start behavior. No state/outbox partial commit may survive failure.
- Authentication: real test session, cookie scope/origin, expiry/revocation, owner separation and
  configured Coder API access. No secrets, signed tickets, raw tokens or user content in evidence.
- Scoped workspace operation from the preview through Coder: authorized inventory plus a harmless
  bounded operation; wrong owner, wrong workspace, timeout and duplicate request behavior.
- Terminal from the preview: authenticated upgrade, bidirectional binary data, resize, disconnect
  and reconnect to the same session, expired ticket/origin rejection, backpressure and Coder outage.
  Preserve browser evidence from `browser-testing`; terminal success does not complete F04.
- Dependency inventory: show which old origin services remain, which capabilities are disabled,
  and which F02/F07/F08 criteria still block activation. Production stays on the existing release.

The primary agent should reconcile this audit with its account and runtime findings before marking
D01 accepted. The next bounded implementation is slices 1–2; only real deployed evidence can
resolve the driver/network uncertainty they target.

## Initial probe implementation and account inspection

The subsequent isolated implementation is in
[deploy/cloudflare/epic-preview](../../../deploy/cloudflare/epic-preview/README.md).
Its [local evidence](../../../deploy/cloudflare/epic-preview/local-evidence.json) distinguishes
the initial 11 passing focused tests and local workerd/dry-run results from unperformed live integration.
It implements a dedicated bearer gate, fixed read-only Coder identity request, and Neon HTTP
batch commit/replay/rollback checks against a preview-only schema. This deliberately does not
claim the Prisma, interactive transaction, framework, Hive authentication or terminal gates.

[Read-only account inspection](../../../deploy/cloudflare/epic-preview/account-inspection.json)
found the connected Neon organization is Free, but its existing project reports an effective
512 MiB branch limit, lower than the public plan page. Only its default `production` branch
exists. The available MCP branch-create operation copies parent data and exposes no schema-only
option, so a clean test project or verified schema-only API must be selected before test writes.
The Cloudflare connection can inspect Workers/subdomain, but subscription inspection returned
403 because its OAuth connection cannot cover Billing Read. Workers `standard` usage model
does not establish Free versus Paid. The user subsequently confirmed an existing **Paid** Workers
plan and did not authorize additional cost. Published Standard includes 10M requests and 30M CPU
milliseconds/month, but remaining headroom is unverified: billing usage is also inaccessible via
OAuth, and the initial analytics GraphQL request was rate-limited. Deployment remains pending
usage verification; no plan upgrade or paid add-on is authorized. No resource has been created
or deployed by this probe.

Subsequent [Cloudflare usage inspection](../../../deploy/cloudflare/epic-preview/cloudflare-usage.json)
succeeded after cooldown and showed substantial apparent included-allowance headroom. The primary
accepted that evidence for a maximum of 20 scripted requests on a new preview Worker, with no
paid products or plan changes. Adaptive usage is not invoice proof or a future quota reservation.
The primary created a clean separate Neon Free project, avoiding any production-data branch copy.

The [Prisma fixture proof](../../../deploy/cloudflare/epic-preview/prisma-workerd-evidence.json)
now records real **local workerd → Neon** interactive transactions using Prisma/client/adapter
6.19.3 and a `workerd` JavaScript-engine generator. It observed commit, duplicate replay and
rollback following an awaited callback throw, plus UUID/JSON/timestamptz round trips with the
restricted SELECT/INSERT role. Exact file digests bind the initial uncommitted source; the SHA
is explicitly labeled a base revision. The rerun helper requires committed source by default.
This closes a narrow transport uncertainty, not the complete F02/framework/auth/schema gate.
Cloudflare network execution remains pending until the primary commits and authorizes that
exact artifact for deployment.
