---
"hive-web": minor
---

Add per-preview wildcard Certificate template for cookie-isolated preview environments. The chart now stamps a cert-manager Certificate covering both the preview host apex and `*.<host>` when `preview.enabled` is true.
