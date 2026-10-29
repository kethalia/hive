# Isolated delivery capability probe

This is an F02 networking/transaction probe, separate from Hive's production edge proxy.
It runs a plain Worker with the Neon HTTP driver and a Prisma 6.19 fixture client. Real local
workerd has passed Prisma interactive callback transactions against the isolated Neon database.
This does **not** establish the full Hive Prisma schema, Next.js, Hive browser authentication,
workspace operations, terminal transport, or the shared native Codex session.

On 2026-10-29, committed revision `e7110466dbe693a5501b5ef9e1738aa59f46b4b8` passed
the bounded **Cloudflare network → Coder + Neon** checks. See [live results](live-evidence.json)
and [deployment/version identity](deployment-evidence.json). Sixteen scripted Worker requests
were used across initial diagnosis and final validation, within the authorized maximum of 20.
The task Worker is retained with public `workers.dev` and version preview URLs **disabled**.
The clean Neon test project is retained. No production routes, DNS, paid add-ons or plans changed.

The probe has no production routes or `HIVE_ORIGIN`. Its Coder operation is fixed to
`GET https://coder.kethalia.com/api/v2/users/me`; there is no caller-supplied URL, command,
SQL, database name, run identity or Coder password. All endpoints require a dedicated preview
bearer credential. Configuration fails closed with field names, never values.

## Local validation

This package intentionally has its own pinned lockfile, outside the root pnpm workspace,
so the probe does not change application dependencies. Use the repository's pnpm version:

```sh
cd deploy/cloudflare/epic-preview
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm test
pnpm build
pnpm preview --port 8791
```

`build` invokes `wrangler deploy --dry-run`; it does not deploy. `preview` runs local workerd
on loopback. With the committed placeholder configuration, every app request returns 503.
Synthetic local credentials can validate routing/authentication without making external requests.
Store these only in ignored `.dev.vars`; remove them after the bounded check. Do not use production
credentials to make the local probe appear complete.

The initial HTTP-only 2026-10-29 check passed 11 focused tests, built a 208.18 KiB uncompressed Worker
(56.37 KiB gzip), and observed local workerd responses for missing configuration (503), missing
bearer (401), authenticated capability artifact (200), and rejected query parameters (400).
No real Coder/Neon request was made by that check. See [initial local evidence](local-evidence.json).

The initial Prisma fixture had 12 passing focused tests and a 2450.37 KiB uncompressed
dry-run build (880.82 KiB gzip). The final diagnostic revision has 13 passing tests and a
2451.72 KiB upload (881.29 KiB gzip), with 51 ms Cloudflare startup time.
[Real local-workerd evidence](prisma-workerd-evidence.json)
records two successful requests against the clean Neon test project: awaited read/insert/read
inside an interactive `$transaction` callback, duplicate replay, a deliberate callback throw
whose inserted row is rolled back, UUID/JSON/date round trips, and SELECT/INSERT-only role checks.
The initial proof explicitly labels its response SHA as a **base revision**, with exact tested
file digests; it does not pretend uncommitted source was that commit's artifact.

After committing source, rerun with a fresh UUID and committed-revision evidence:

```sh
node deploy/cloudflare/epic-preview/run-local-proof.mjs
```

The helper reads only the restricted runtime URL and supplied test-account token from the primary's
private credential directory, creates temporary ignored local bindings, runs two local workerd
requests, records digests/results, stops the process group and removes bindings. It never prints
credentials. `--allow-uncommitted` is only for explicitly labeled development evidence. It does
not deploy. The fixture maps the existing `hive_epic_preview.probes` table, so it requires no
Prisma migration or new grants. Generated code is ignored and rebuilt from the pinned Prisma 6.19
schema/client/adapter versions. Root application dependencies are unchanged.

## Deployment proposal and prerequisites

The primary agent coordinates deployment. The bounded probe has now completed; the procedure
below records its prerequisites and reproduction path. Read-only account findings and the later
task resource state are in [account inspection](account-inspection.json).

1. The user confirmed an existing Cloudflare Workers **Paid** plan, with no authorization for
   additional cost. Verify sufficient included usage headroom before deployment. The connected
   OAuth session can inspect Workers but cannot read billing subscriptions/usage: those endpoints
   returned 403 and require Billing Read via an API token. The initial analytics GraphQL read was
   rate-limited. A subsequent account-wide overview query returned substantial apparent headroom:
   269,260 invocations and a conservative larger CPU sum of 19.575M CPU milliseconds over a window
   covering possible current monthly cycles. See [usage evidence](cloudflare-usage.json).
   Published Standard includes 10M requests and 30M CPU milliseconds/month. Adaptive analytics
   are not invoice proof or a reservation of future allowance. Existing Workers using
   `standard` usage model do not identify the plan. Do not upgrade a plan or enable paid add-ons.
2. Record an isolated Neon test project/database with a Free plan and effective limits. The
   inspected `hive` project has only a default branch named `production`. The installed MCP
   `create_branch` copies parent data and exposes no schema-only option; do not use it to copy
   production. Coordinate a new clean Free test project or verify a supported schema-only API
   before provisioning. The primary has since created clean Free project `purple-math-59583745`
   (`hive-epic-preview`), branch `br-ancient-violet-b7pcun87`; its creation/provenance evidence is
   linked in the account inspection. The restricted role and schema have been prepared there.
   Honor the lower API-reported 512 MiB branch limit where applicable,
   even though current public documentation lists 1 GB/project.
3. Apply [schema.sql](schema.sql) externally to that isolated database and record migration
   evidence. Create/use a preview-only role with `USAGE` on `hive_epic_preview` and only
   `SELECT, INSERT` on `hive_epic_preview.probes`. Keep schema/admin credentials outside Workers.
4. Bind `DATABASE_URL`, `PREVIEW_BEARER_TOKEN` and `CODER_API_TOKEN` as Worker secrets using the
   connected app where sufficient. `PREVIEW_BEARER_TOKEN` must be a cryptographically random
   base64url string, 43–128 characters. `CODER_API_TOKEN` is a user account token used only for
   the fixed read. Do not copy an owner CLI session or a Coder password into this Worker.
5. Set `SOURCE_REVISION` to the committed 40-character source SHA; `PROBE_RUN_ID` to a fresh UUID;
   `NEON_PREVIEW_HOST` and `NEON_PREVIEW_BRANCH_ID` to the independently verified test endpoint
   and branch. These identity fields describe the selected environment; they do not themselves
   prove database provenance. Keep `CODER_URL` fixed. Record code/config digest and returned
   Worker version/preview URL in primary evidence before testing.
6. Deploy only the new `hive-delivery-capability-preview` Worker after checking that the name
   is absent and the account is correct. Do not change existing Workers, routes, DNS, subdomains
   or subscriptions. Keep this deployment within verified existing included allowances; no Hyperdrive,
   R2, Queues, Durable Objects or paid service is required by this bounded probe.
7. Invoke the endpoints below from a script that reads credentials from private files/environment
   and prints sanitized result fields. Never put bearer/Coder/Neon credentials in query strings,
   recorded commands, logs or committed evidence. Stop after the bounded checks and preserve
   test/project/Worker identities for later cleanup under the applicable authority.

| Endpoint | Method | Expected real evidence |
| --- | --- | --- |
| `/api/capabilities` | GET | Source/run/branch identity and explicit remaining gates; no credentials |
| `/api/probe/coder` | GET | Fixed public TLS and Coder account-token authentication work; sanitized user UUID only |
| `/api/probe/neon` | POST with no body | One test row commits; duplicate transaction adds no second row; deliberate SQLSTATE `22012` rolls back its inserted row; final read sees only committed data |
| `/api/probe/prisma` | POST with no body | Prisma 6.19 workerd fixture, Neon WebSocket interactive callback transactions, restricted-role checks, commit/replay/rollback and typed round trips |

The database probe retains one synthetic row per configured run. Repeating the request reuses
that row; it does not accumulate rows or clean up unknown data. Choose a new run UUID when the
source revision changes. SQL/network/auth failures cannot be counted as successful rollback.
No automatic retry hides an ambiguous external result; replay the fixed run to inspect it.

The primary authorized at most 20 scripted preview requests within the existing included allowance,
with no paid add-ons. The config caps each request at 100 CPU milliseconds. Once source is committed
and the local proof rerun, `prepare-deployment.mjs` writes an ignored deployment config and private
bulk-secret file, validating the committed proof/digests. It performs no cloud write. The primary
then rechecks account and name absence and invokes Wrangler against that config, followed by secret
bulk upload from the private file. Existing Wrangler OAuth is available; no new login is needed.
Wrangler is used for local WASM/module upload and private-file secret transport; connected tools
handle account/usage inspection. Never print the private bulk-secret file.

`check-live-preview.mjs` makes exactly seven requests to the fixed new Worker URL: unauthorized
rejection, capabilities, Coder identity, two Prisma requests and two HTTP batch requests. It binds
results to the prepared committed revision/run and saves sanitized evidence. It has no retry loop.
Run it once, then preserve the returned deployment/version identity and disable public serving when
the bounded validation is complete. Do not rerun after failure without accounting for the request
budget and inspecting the recorded partial results.

The next gates are the full existing Hive Prisma schema, supported framework build and real
Hive auth/terminal/workspace flows. See the [capability audit](../../../docs/checks/autonomous-delivery/cloudflare-capability.md).
The HTTP driver supports noninteractive transaction batches; interactive transactions require
another transport. [Official Neon driver documentation](https://neon.com/docs/serverless/serverless-driver).

The initial live Coder request failed before making its outbound request because Workers does not
support `redirect: "error"`. Switching to `manual`, rejecting non-OK status and retaining only a
redirect's origin resolved it without forwarding credentials to another origin. This was a runtime
compatibility defect, not a Coder account rejection or production routing defect. Both the initial
failure and initial Neon success are preserved in suffixed `a3549b4` evidence files.
[Official Workers Request behavior](https://developers.cloudflare.com/workers/runtime-apis/request/).
