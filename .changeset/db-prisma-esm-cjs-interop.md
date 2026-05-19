---
"@hive/db": patch
---

Fix runtime `SyntaxError: does not provide an export named 'PrismaClient'` when consuming services run under Node ESM. `@prisma/client` is CJS, and Node's ESM loader can't statically detect its named exports, so the named-import form blew up at startup in hive-auth (and would in hive-migrate/hive-web/hive-terminal once they exercised the same path). Switch to a default-import + destructure for runtime values; types are re-exported via `export type *` so consumers using `import type { Prisma, PrismaClient }` continue to work unchanged.
