---
"hive-web": patch
---

Remove the unused custom Worker upload workflow, publisher executables and their
token setup. Keep application publication on the existing connected Cloudflare
Builds pipeline, preserve the D10 artifact/compatibility helpers, and authenticate
tested-tree attestations with their existing purpose-bound GitHub OIDC proof.
