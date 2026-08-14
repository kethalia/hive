---
"hive-web": minor
"@hive/db": minor
"hive-migrate": patch
---

Retire the asynchronous Tasks workflow and task-specific Coder template in favor of interactive,
profile-driven workspaces. Add authenticated start, stop, and exact-name-confirmed delete controls,
plus the database migration that removes legacy task records and task-owned workspace metadata.
