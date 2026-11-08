---
"hive-web": patch
---

Bound host archives as image assets rather than inline pod metadata. Allow up to
256 KiB of compressed XZ while keeping the 2 MiB expansion limit, 32 MiB decoder
memory limit and small hash/config annotation unchanged. Continue verifying the
image installer and archive hashes before reconstruction.
