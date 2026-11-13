# Cloudflare production database migration

The compatibility schema has **11 migrations, 13 application tables and one sequence**.
It supports existing authentication, credentials, favorites, notifications, terminal diagnostics
and template publication. The owner authorized the Cloudflare move and Kubernetes retirement
after existing-feature validation. Complete the checks below before cutover. The owner merges
main through GitHub.

## Pinned scope and credentials

Use the existing migration runner, `services/migrate/src/migrate.mjs`, and the source revision that
produced the reviewed Worker. Preserve all seven original migration files and their checksums.
Apply the four appended migrations in this order.

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
Use owner credentials for migration/restore/grants and runtime credentials only for application
verification. Do not change passwords, memberships, ownership, or privileges in another database.

## Preserve data before switching writers

1. Freeze the exact source/migration hashes and capture the source database's completed migration
   names/checksums, database identity, application-table counts, and safe byte-comparison digests.
   Any failed/unfinished history or history other than the verified seven migrations is a hold;
   inspect the mismatch and follow the existing baseline-adoption procedure when applicable.
2. Use the versioned `scripts/checks/data-migration/capture.py` utility with a private
   connection file and a fresh private destination. It exports a read-only snapshot and records
   table fingerprints from that same snapshot. Preserve a protected custom-format backup of the existing production data, including all seven
   tables and `_prisma_migrations`. Verify successful archive decoding.
   Rehearse restoring it into an isolated database using `--no-owner --no-acl`, then applying the
   four additions. Do not print decoded rows or backup contents.
3. Preserve the original encryption key, cookie-signing secret, session IDs, encrypted Coder token
   bytes/IV/auth tag/version, VAPID key pair, push subscriptions/preferences, notification source
   hashes/pending hashes/generation, users, and favorites.
4. At the cutover boundary, stop old application/background writers before the final
   backup/restore and before enabling Cloudflare production jobs. In particular, do not run old
   Redis token rotation against the old copy while Cloudflare rotates credentials from the new copy.
   Complete feature parity checks before this writer handoff.

For a data-preserving move, restore the verified seven-migration backup into the verified **empty**
production target first, then migrate. Do not initialize all eleven migrations and blindly restore
an entire seven-migration schema over it. Transfer existing users and credentials using the verified
restore path. Fresh-empty creation provides an additional migration compatibility check.

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

- Confirm all 11 names/checksums, completed history, indexes, constraints, triggers, and the exact
  application table/sequence set. Compare every original row and protected byte field with the
  restored backup, accounting for the five additive token-rotation fields.
- Connect as the runtime role. Read the old session/token/VAPID rows with the current generated Node
  client, including the new nullable fields and `rotation_next_at`. Verify application-required
  writes and sequence use on isolated fixtures, including rejection of forbidden operations.
- Confirm the runtime cannot read migration history or a newly created ungranted table. Verify
  default grants and opposite-environment grants were removed. Do not perform production test writes
  on real users merely to prove a privilege. Use catalog checks for production verification.
- After these checks and feature parity validation, deploy the Worker, switch the domain, and verify
  ordinary user acceptance with existing credentials. Retire the Kubernetes Hive application after
  successful cutover, preserving workspace infrastructure.

The seven original table contracts remain readable by the old Node app after this additive
upgrade. Keep one active background writer throughout the transition.
After new credential rotation or accepted jobs occur, restoring an old snapshot can discard real
work or restore invalid upstream credentials. Prefer a forward fix. Stop writers and review any
rollback against the current upstream credential state and committed jobs.

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
