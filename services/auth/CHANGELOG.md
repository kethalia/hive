# hive-auth

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
