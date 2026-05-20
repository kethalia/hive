---
"hive-migrate": patch
---

Chart: switch `hive-migrate` Job from Helm hooks (`post-install,pre-upgrade`, which ArgoCD treats as PreSync) to ArgoCD-native sync hooks with `argocd.argoproj.io/sync-wave: "-5"`, and annotate the CNPG `Cluster` CR with sync-wave `-10`. Prevents the chicken-and-egg deadlock where the migrate Job's `wait-for-postgres` init container looped on a not-yet-created `hive-pg-rw` Service on fresh preview namespaces.
