---
"hive-web": patch
"hive-terminal": patch
---

Preserve recently opened terminal surfaces and connections across workspace navigation. Wait for upstream PTY readiness before accepting input, probe foreground connection health, preserve terminal surfaces during clone credential refresh, and bound suspended browser attachments and queued proxy output. Gracefully close sockets during proxy restarts.
