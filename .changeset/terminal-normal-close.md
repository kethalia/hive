---
"hive-web": patch
---

Preserve normal upstream terminal closure through the Cloudflare relay so exiting a
shell does not trigger automatic reconnection and recreate its session. Keep transient
closures retryable and upstream close reasons private.
