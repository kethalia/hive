---
"hive-web": patch
---

Add default-off, exact-event notification wakes in the existing Worker. Reserve
metadata before committing callbacks and reuse the PostgreSQL outbox claims,
five-attempt retries and stable push tags. Retain disabled enrollment to fence
late commits and other dispatchers until the exact event is terminal.
