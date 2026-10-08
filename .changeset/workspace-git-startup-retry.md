---
"hive-web": patch
---

Retry transient Git configuration lock contention during workspace alias and credential-helper initialization so concurrent startup scripts do not leave a working workspace marked unhealthy.
