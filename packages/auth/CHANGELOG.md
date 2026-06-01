# @hive/auth

## 1.0.2

### Patch Changes

- 179761f: Add Git clone discovery, home-root sidebar browsing, and session-bound persistent clone terminals with hardened proxy validation.

## 1.0.1

### Patch Changes

- 2323c3d: feat(charts): apply Prisma migrations via post-install/pre-upgrade hook

  The umbrella `hive` chart now ships a Helm hook Job
  (`post-install,pre-upgrade`, weight `-5`) that runs `prisma migrate deploy`
  against the CNPG-issued `<release>-pg-app` database before the workloads
  roll. The hook is split so installs run after the CNPG `Cluster` CR lands
  (initContainer waits for `<release>-pg-rw:5432`), while upgrades run before
  any Deployment is updated — new pods never start against a stale schema.

  To support this:

  - `services/auth/Dockerfile` now copies the root `prisma/` directory into
    the image. The `prisma` CLI is promoted from devDependencies to
    dependencies of `hive-auth` (aligned to `^6.19.0` to match the workspace
    root), so `pnpm deploy --prod` keeps it in the runner stage and the same
    image powers both the auth service and the migrate Job.
  - The 4 incremental migrations under `prisma/migrations/` assumed
    `users` / `tasks` / `coder_tokens` already existed (dev was bootstrapped
    via `db push`, so no init migration ever landed). They are replaced with
    a single `0_init` baseline generated via
    `prisma migrate diff --from-empty --to-schema-datamodel` — same end
    state, installable from empty.

  Existing dev databases need a one-time reconcile before the hook can run:

  - DBs with a populated `_prisma_migrations` table (from the 4 old
    migrations): wipe, or `prisma migrate resolve --applied 0_init`.
  - DBs bootstrapped via `prisma db push` (tables exist, no
    `_prisma_migrations` row): `prisma migrate resolve --applied 0_init`,
    otherwise `migrate deploy` will try to `CREATE TABLE` against existing
    tables and fail. Prod CNPG is empty, so this only affects local dev.
