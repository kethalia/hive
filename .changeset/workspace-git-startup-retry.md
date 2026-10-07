---
"hive-web": patch
---

Retry transient Git configuration lock contention during workspace initialization so concurrent startup scripts do not leave a working workspace marked unhealthy.
