---
"hive-web": patch
---

Remove the custom native Preview publisher, token enrollment, machine routes,
and dedicated artifact workflow. Retain managed Cloudflare Workers Builds,
existing release safeguards, and applied database migration history.

Allow verified implementation Preview work to reach premerge checks while keeping
production criteria pending and full-task preservation/cleanup verification strict.
