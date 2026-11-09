---
"hive-web": patch
---

Allow independently accepted epic work to feed integration after a verified child
PR merge into its configured non-production branch, while retaining production,
archival and physical writer gates. Use the existing signed workspace GitHub
connection for read-only merge and ancestry observations, without separate tokens.
