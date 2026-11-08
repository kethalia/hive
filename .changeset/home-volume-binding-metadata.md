---
"hive-web": patch
---

Wait for HOME PVC binding before publishing provider-backed volume metadata, so new workspaces retain strict managed-runtime enrollment without an empty PV identity.
