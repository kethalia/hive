---
"hive-web": patch
---

Enable independent production validation through the existing acceptance engine
only after explicit production enrollment and owner cutover approval. Preserve the
release fence until scoped semantic acceptance passes, recheck the serving build
before completion, and retain native writer and archive safeguards.
