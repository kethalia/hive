---
"hive-web": patch
---

Add typed, uniquely correlated dispatch and read-only lookup for controlled
database jobs in the existing CI workflow. Pin the trusted recipe and caller
revision, keep lost acknowledgements pending, and reject unrelated or skipped
workflow runs instead of treating dispatch acceptance as database completion.
