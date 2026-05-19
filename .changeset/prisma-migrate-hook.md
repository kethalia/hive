---
'hive-auth': patch
'@hive/auth': patch
---

feat(charts): apply Prisma migrations via post-install/post-upgrade hook

The umbrella `hive` chart now ships a Helm hook Job
(`post-install,post-upgrade`, weight `-5`) that runs `prisma migrate deploy`
against the CNPG-issued `<release>-pg-app` database before the workloads
roll. An initContainer waits for `<release>-pg-rw:5432` so the Job does not
race the CNPG operator.

To support this:

- `services/auth/Dockerfile` now copies the root `prisma/` directory into
  the image and installs the `prisma` CLI globally in the runner stage, so
  the same image powers both the auth service and the migrate Job.
- The 4 incremental migrations under `prisma/migrations/` assumed
  `users` / `tasks` / `coder_tokens` already existed (dev was bootstrapped
  via `db push`, so no init migration ever landed). They are replaced with
  a single `0_init` baseline generated via
  `prisma migrate diff --from-empty --to-schema-datamodel` — same end
  state, installable from empty.

Existing dev databases with a populated `_prisma_migrations` table will
need either a wipe or
`prisma migrate resolve --applied 0_init` after pulling this change.
