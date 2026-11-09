---
"hive-web": patch
"hive-auth": patch
"@hive/auth": patch
---

Add owner-scoped Coder OAuth disconnect to the existing Settings window. Atomically detach the selected credential generation and its Hive sessions before requesting exact-token provider revocation, preserve newer sign-ins, and report unconfirmed outcomes without retrying or replacing OAuth with managed keys.
