---
"hive-migrate": patch
---

Allow the migration runner to select the fixed native runtime role explicitly, validating the selector before database operations. Apply the same bounded table privileges while preserving immutable recovery history and database CONNECT restrictions.
