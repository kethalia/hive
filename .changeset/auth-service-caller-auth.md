---
"@hive/auth": patch
"hive-auth": patch
"hive-terminal": patch
"hive-web": patch
---

Require a dedicated AUTH_SERVICE_SECRET for internal auth-service requests, authenticate the web and terminal clients, and reject missing or invalid service credentials before accessing sessions or Coder tokens. Provision the same 64-hex secret in all three services before rollout, update clients first, then enable auth-service enforcement.
