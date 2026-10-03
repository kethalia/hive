---
"hive-web": patch
---

Reduce infrastructure workspace CPU reservations to one core so maintenance workspaces can schedule on nodes with limited unreserved capacity, while preserving their eight-core burst limit.
