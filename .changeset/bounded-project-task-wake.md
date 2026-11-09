---
"hive-web": patch
---

Add default-off, exact-task Durable Object preparation wakes inside the existing
Worker. Persist reservations before enqueue, retain deadline/budget holds, and
reuse PostgreSQL task leases and current policy checks for alarm and browser work.
