# Cloudflare fresh production initialization

The compatibility schema has **11 migrations, 13 application tables and one sequence**.
It supports existing authentication, credentials, favorites, notifications, terminal diagnostics
and template publication. The owner authorized the Cloudflare move and Kubernetes retirement
after existing-feature validation. On 13 November 2026, the owner authorized a fresh
production start and waived legacy data transfer. Initialize the empty production database and
generate new production secrets. The owner signs in again and configures preferences and browser
notifications after cutover. Complete the checks below before cutover. The owner merges main
through GitHub.

## Pinned scope and credentials

Use the existing migration runner, `services/migrate/src/migrate.mjs`, and the source revision that
produced the reviewed Worker. Preserve all seven original migration files and their checksums.
Initialize the empty target with all eleven recorded migrations. The four compatibility additions
follow the seven existing migrations in this order.

1. `20261113010000_agent_notification_events`: callback outbox and rate window.
2. `20261113020000_terminal_diagnostics`: connection leases and bounded diagnostic events.
3. `20261113030000_template_jobs`: publication jobs and completion notices.
4. `20261113040000_legacy_rotation_leases`: additive credential-rotation columns and constraints.

Production uses database `hive_production`, owned by `hive_epic_owner`, and application role
`hive_production_runtime`. Verify its current PostgreSQL OID and restricted LOGIN role attributes before execution.
Refresh the verified OID input if the database was recreated. Record observations in the private
execution receipt.

Existing owner/runtime URL files are private inputs. Never put URLs, credentials, token ciphertext,
VAPID private keys, or session IDs in a PR, command transcript, dump listing, or public receipt.
Use owner credentials for schema initialization and grants, and runtime credentials for application
verification. Do not change passwords, memberships, ownership, or privileges in another database.

## Fresh target and production secrets

Verify the target database name, OID, owner and restricted runtime role. Confirm that the target
has zero application tables before the first initialization. If initialization is being resumed,
inspect the completed migration history and run the same migration runner idempotently.

Create independent cryptographically random production `ENCRYPTION_KEY`, `COOKIE_SECRET` and
`AUTH_SERVICE_SECRET` values. Supply `DATABASE_URL` for `hive_production_runtime` privately.
Configure these four secrets on the existing production Worker through the official Cloudflare
secret workflow. Record secret names and verification results in public evidence. Keep their
values in protected private files. Preview retains its independently configured runtime secrets.

The serving Kubernetes app can continue during preparation. At the approved cutover window,
stop its old background writers before the Cloudflare application starts creating production
Coder credentials. The old token-rotation implementation can revoke credentials belonging to
the same Coder account. Coordinate this writer handoff through the Kubernetes GitOps retirement
and the Cloudflare deployment, then verify the production application and finish residual storage
cleanup. Source database capture and Rancher access are outside the fresh initialization path.

## Apply schema, then explicit runtime grants

Run these commands on the verified owner connection, beginning with the preflight check.

```sh
node services/migrate/src/migrate.mjs --check
node services/migrate/src/migrate.mjs
```

`DATABASE_URL` must be supplied privately for the exact owner connection. Never run `db push`,
`migrate reset`, edit completed migration files, or mark a new migration applied without running it.
The Worker that selects the new fields must not serve production before the schema and grants pass.

The versioned grant generator produces SQL for review.

```sh
node services/migrate/src/runtime-grants.mjs production "$VERIFIED_DATABASE_OID" > grants-reviewed.sql
```

Inspect and hash that file, then apply it through the same verified owner connection with
`ON_ERROR_STOP=1`. It runs in one transaction with bounded statement/lock timeouts. The script
requires the exact database name/OID/owner, restricted runtime role, exact 13-table application
set plus migration history, and the 11 completed migration names. Before applying, independently
compare all recorded migration checksums with the pinned source.

The existing blanket owner default grants would expose future tables, including migration history.
The script removes those defaults in this database, revokes PUBLIC application-schema privileges,
and removes grants to the other environment's runtime role in this database.
The runtime role receives the following privileges.

| Tables | Runtime privileges |
| --- | --- |
| `users`, `coder_tokens`, `vapid_keys`, `template_jobs`, `template_notices` | SELECT, INSERT, UPDATE |
| `sessions`, `push_subscriptions`, `navigation_favorites`, `notification_sources`, `agent_notification_events`, `agent_notification_rate_windows`, `terminal_connections` | SELECT, INSERT, UPDATE, DELETE |
| `terminal_events` | SELECT, INSERT, DELETE |
| `terminal_events_id_seq` | USAGE |

No runtime grants cover `_prisma_migrations`, schema creation, database CREATE/TEMP, table alteration,
TRUNCATE, trigger creation, sequence `setval`, or administrative role operations. Future tables need
explicitly reviewed grants. Reapplying the same script after successful verification is idempotent.
The generator also has a fixed Preview profile and fixed table/role allowlists.

Current production callers do not delete users, Coder tokens, VAPID keys, template jobs, or template
notices. Completed publication jobs/notices retain their identities and currently have no retention
sweep, so their row counts grow with publications. A retention policy remains a separate change.

## Verify and cut over

- Confirm all eleven migration names and checksums, completed history, indexes, constraints,
  triggers and the exact application table/sequence set. Confirm the fresh application tables
  contain zero users and sessions before the first production sign-in.
- Connect as the runtime role. Verify required table and sequence privileges, denied migration
  history and schema/admin privileges, and removed opposite-environment/default grants through
  catalog checks. The isolated local integration suite exercises actual permitted and rejected
  operations.
- Stage the reviewed fresh production connection and new cryptographic secrets on the existing
  Worker. Verify the background-writer handoff and deploy the approved main source through the
  existing repository-connected Cloudflare Builds integration.
- Route `hive.kethalia.com` to the existing Worker. Verify fresh sign-in, workspace discovery,
  terminal output/reconnect, File Browser, clipboard, notifications, microphone and speakers.
- Finish Kubernetes Hive application and storage retirement through the GitOps retirement PR,
  preserving Coder workspace infrastructure and shared platform resources.

The owner accepted starting with empty application state. Existing local migration/restore tests
remain regression coverage for schema upgrades. After fresh production credentials or jobs exist,
prefer a forward fix that preserves the current credential state and committed work.

## Local evidence and repeatability

`src/__tests__/deployment/cutover-migrations.integration.test.ts` is restricted to
`coder@127.0.0.1:55439/hive_cutover_migrations_20261113`. It owns that database's `public` and
`upgrade_fixture` schemas and uses two dedicated nonprivileged fixture roles,
`hive_cutover_fixture_runtime_20261113` and `hive_cutover_fixture_other_20261113`. Create that empty
fixture database and those LOGIN roles once on the owned local test server. Avoid reusing an
application database or change other roles. The test resets only its own schemas, uses the actual
Prisma migration runner, and leaves the database available for inspection. No production URL is
accepted by this test.

```sh
HIVE_CUTOVER_MIGRATIONS_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:55439/hive_cutover_migrations_20261113 \
  pnpm exec vitest run src/__tests__/deployment/cutover-migrations.integration.test.ts
```

The test checks fresh 11-migration creation, a seeded seven-to-eleven upgrade, unchanged original
rows and history, current Node client reads, scoped grants and their reapplication, callback/template
immutability, diagnostic constraints and sequence use, rotation constraints, and denied admin/history
access. It changes no other database or role and uses no Coder, push, model, or production endpoints.
