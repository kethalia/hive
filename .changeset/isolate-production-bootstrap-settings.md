---
"hive-web": patch
---

Keep preview execution switches, repository policies, issuer metadata and callback
origins out of offline production bootstrap preparation. Production login still
requires its own explicit OAuth enrollment; autonomous execution stays disabled.
