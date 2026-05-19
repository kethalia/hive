# hive-migrate

## 0.1.1

### Patch Changes

- 033670c: Extract `@hive/db` workspace package owning the Prisma schema, migrations, and `PrismaClient` singleton. Web, auth, and migrate now import from `@hive/db` directly; the old `src/lib/db/index.ts` and `services/auth/src/db.ts` barrels are removed. New dedicated `hive-migrate` image runs `prisma migrate deploy` as a Helm hook.
