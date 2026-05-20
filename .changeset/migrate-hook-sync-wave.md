---
---

Chart-only change: switch `hive-migrate` Job from Helm hooks to ArgoCD-native sync hooks and add sync-wave to the CNPG `Cluster` CR so the database exists before migrate runs. No application code changed.
