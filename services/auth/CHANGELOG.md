# hive-auth

## 1.0.6

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

- Updated dependencies [2323c3d]
  - @hive/auth@1.0.1

## 1.0.5

### Patch Changes

- eaca1db: fix(charts): writable /tmp emptyDir under readOnlyRootFilesystem, opt-out toggle

  All three chart Deployments now mount a writable `/tmp` emptyDir
  (`name: hive-tmp`) so pods with `securityContext.readOnlyRootFilesystem: true`
  can satisfy tsx transpile cache writes and any `os.tmpdir()` callers without
  EROFS. The volume is enabled by default and can be disabled with
  `tmpVolume.enabled: false` for consumers that need to mount their own `/tmp`
  (e.g. a sized tmpfs or PVC). The volume name is chart-scoped (`hive-tmp`) to
  avoid colliding with user-supplied entries in `.Values.volumes` /
  `.Values.volumeMounts`.

## 1.0.4

### Patch Changes

- 51039a3: ci: trigger fresh release through the gated Release workflow

  The v1.0.3 release (commit `e581794`) ran Release in parallel with Build
  images on the merge `push`, so the retag step looked for
  `:sha-e581794` before Build had pushed it and errored with
  `Source image ... does not exist in registry`. Result: `hive-web` and
  `hive-auth` never got `:v1.0.3` / `:latest` tags published on GHCR
  (only `:sha-e581794`). `hive-terminal` was recovered manually via
  workflow_dispatch.

  PR #64 fixed the underlying race by switching Release to
  `workflow_run: ["Build images"] completed`. Patch-bump the stack so a
  release flows end-to-end through the gated workflow and produces the
  missing version tags.

## 1.0.3

### Patch Changes

- 9f7f91c: ci: pin reusable workflows to @v1 and consolidate changeset check via ci-changeset-check reusable

## 1.0.2

### Patch Changes

- c346baa: Copy generated Prisma client into pnpm deploy output so it survives .gitignore exclusion

## 1.0.1

### Patch Changes

- b9402f0: Fix Prisma client generation path for pnpm deploy compatibility

## 1.0.0

### Major Changes

- e1a2d80: Initial release of the auth service — session management, Coder token encryption, rate limiting, and credential storage
