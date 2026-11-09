---
"hive-web": patch
---

Allow bounded retries for transient startup failures reading the authenticated Coder agent manifest in host, agent, read and voice installers. Preserve the fixed helper and strict response validation, reject late or wrong-scope responses immediately, and never retry installation or service launch.
