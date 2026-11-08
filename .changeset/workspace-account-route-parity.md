---
"hive-web": patch
---

Use one workspace route parameter name so Next can construct its dynamic matcher for account, voice and paste endpoints. Let exact owner account POST routes authenticate their own sessions and return JSON failures instead of login redirects.
