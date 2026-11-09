---
"@hive/db": patch
---

Retire the unused native publisher tables and trigger functions with a guarded,
transactional forward migration. Any remaining publisher row aborts retirement
without deleting data. Preserve the original migration history and all shared
application and release records.
