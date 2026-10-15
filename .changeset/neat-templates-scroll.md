---
"hive-web": patch
---

Fix template descriptions overlapping table columns, add a confirmed Push all action with independent progress, and restore desktop and mobile scrolling when multiple push panels are open. Keep queued and active pushes pending until their actual result is known instead of reporting log-wait timeouts as failures. Reconnect interrupted streams without enqueuing another job, and coalesce status scans after bulk pushes.
