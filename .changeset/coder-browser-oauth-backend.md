---
"hive-web": patch
"hive-auth": patch
"@hive/auth": patch
"@hive/db": patch
---

Add confidential Coder browser sign-in with S256 PKCE, expiring one-use browser binding, and atomic verified-owner credential and Hive session storage. Serialize encrypted OAuth refresh through the shared credential path, preserve managed credentials, and require explicit reconnect after an ambiguous rotating grant instead of replacing it with an API key.
