# Isolated delivery capability probe

This is an F02 networking/transaction probe, separate from Hive's production edge proxy.
It runs a plain Worker and the Neon HTTP driver. It does **not** prove Next.js, Prisma,
interactive transactions, Hive browser authentication, workspace operations, terminal transport,
or the shared native Codex session. Those remain explicit gates in `/api/capabilities`.

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

The 2026-10-29 local check passed 11 focused tests, built a 208.18 KiB uncompressed Worker
(56.37 KiB gzip), and observed local workerd responses for missing configuration (503), missing
bearer (401), authenticated capability artifact (200), and rejected query parameters (400).
No real Coder/Neon request was made by that check. See [local evidence](local-evidence.json).

## Deployment proposal and prerequisites

The primary agent coordinates deployment. **No cloud resources have been created or deployed by
this probe.** Read-only account findings are in [account inspection](account-inspection.json).

1. The user confirmed an existing Cloudflare Workers **Paid** plan, with no authorization for
   additional cost. Verify sufficient included usage headroom before deployment. The connected
   OAuth session can inspect Workers but cannot read billing subscriptions/usage: those endpoints
   returned 403 and require Billing Read via an API token. The initial analytics GraphQL read was
   rate-limited, so current headroom is unverified. Published Standard includes 10M requests and
   30M CPU milliseconds/month; that is not proof of remaining allowance. Existing Workers using
   `standard` usage model do not identify the plan. Do not upgrade a plan or enable paid add-ons.
2. Record an isolated Neon test project/database with a Free plan and effective limits. The
   inspected `hive` project has only a default branch named `production`. The installed MCP
   `create_branch` copies parent data and exposes no schema-only option; do not use it to copy
   production. Coordinate a new clean Free test project or verify a supported schema-only API
   before provisioning. Honor the lower API-reported 512 MiB branch limit where applicable,
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

The database probe retains one synthetic row per configured run. Repeating the request reuses
that row; it does not accumulate rows or clean up unknown data. Choose a new run UUID when the
source revision changes. SQL/network/auth failures cannot be counted as successful rollback.
No automatic retry hides an ambiguous external result; replay the fixed run to inspect it.

The next proof after this plain Worker is the existing Prisma 6 client through an appropriate
Worker adapter with interactive transactions, followed by the supported framework build and real
Hive auth/terminal/workspace flows. See the [capability audit](../../../docs/checks/autonomous-delivery/cloudflare-capability.md).
The HTTP driver supports noninteractive transaction batches; interactive transactions require
another transport. [Official Neon driver documentation](https://neon.com/docs/serverless/serverless-driver).
