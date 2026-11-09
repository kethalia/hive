---
"hive-web": patch
"hive-auth": patch
---

Verify fresh Coder OAuth credentials through the configured provider before accepting sessions or returning tokens. Atomically invalidate existing sessions only for the definitively rejected credential generation, preserve newer refresh/login winners and ambiguous refresh holds, roll back invalidation on precommit cancellation, and distinguish terminal authentication rejection from permission denial.
