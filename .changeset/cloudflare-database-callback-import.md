---
"hive-web": patch
"@hive/db": patch
---

Capture a request-bound factory for the post-response database callback without
loading Worker-only Prisma WASM into Next. Keep the callback's separate pool,
deadlines and cleanup, and require a canonical Cloudflare compile in existing CI.
