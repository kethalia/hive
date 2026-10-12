---
"hive-web": patch
---

Bound terminal paste uploads to 20 MiB total and 10 MiB per file, reject excess concurrent requests before reading their bodies, and transfer files sequentially with cancellation and timeout cleanup.
