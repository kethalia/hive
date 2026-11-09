---
"hive-web": patch
"hive-migrate": patch
---

Add a disabled-by-default source-build compatibility mode for the existing
controlled database workflow. Keep tested local artifact hashes separate from
Cloudflare serving-build identity, pin the owner-reviewed SQL plan and both
source trees, and test single-Worker versions in isolated workerd/PostgreSQL jobs.
