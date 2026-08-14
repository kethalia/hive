---
"hive-web": patch
"hive-auth": patch
"hive-terminal": patch
"hive-migrate": patch
"@hive/db": patch
---

Update the web, authentication, terminal, and migration runtime dependency chains to patched
Next.js, Prisma, Undici, and WebSocket releases. Keep the UI scaffolding CLI out of production
dependencies and make CI enforce the root application typecheck.
