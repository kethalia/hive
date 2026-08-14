# hive-migrate

## 0.1.7

### Patch Changes

- 7b0f8fe: Update the web, authentication, terminal, and migration runtime dependency chains to patched
  Next.js, Prisma, Undici, and WebSocket releases. Keep the UI scaffolding CLI out of production
  dependencies and make CI enforce the root application typecheck.
- Updated dependencies [7b0f8fe]
  - @hive/db@0.2.1

## 0.1.6

### Patch Changes

- f34c01f: Retire the asynchronous Tasks workflow and task-specific Coder template in favor of interactive,
  profile-driven workspaces. Add authenticated start, stop, and exact-name-confirmed delete controls,
  plus the database migration that removes legacy task records and task-owned workspace metadata.
- Updated dependencies [f34c01f]
  - @hive/db@0.2.0

## 0.1.5

### Patch Changes

- 8c0f1d6: Document terminal workspace updates and ignore generated agent evidence artifacts plus generated doc-contract tests.
- Updated dependencies [8c0f1d6]
  - @hive/db@0.1.2

## 0.1.4

### Patch Changes

- Updated dependencies [43f62fe]
  - @hive/db@0.1.1

## 0.1.3

### Patch Changes

- c955598: Harden Helm rollout defaults and include the migrate image in deployment preflight coverage.

## 0.1.2

### Patch Changes

- 1c3e7ac: Chart: switch `hive-migrate` Job from Helm hooks (`post-install,pre-upgrade`, which ArgoCD treats as PreSync) to ArgoCD-native sync hooks with `argocd.argoproj.io/sync-wave: "-5"`, and annotate the CNPG `Cluster` CR with sync-wave `-10`. Prevents the chicken-and-egg deadlock where the migrate Job's `wait-for-postgres` init container looped on a not-yet-created `hive-pg-rw` Service on fresh preview namespaces.

## 0.1.1

### Patch Changes

- 033670c: Extract `@hive/db` workspace package owning the Prisma schema, migrations, and `PrismaClient` singleton. Web, auth, and migrate now import from `@hive/db` directly; the old `src/lib/db/index.ts` and `services/auth/src/db.ts` barrels are removed. New dedicated `hive-migrate` image runs `prisma migrate deploy` as a Helm hook.
