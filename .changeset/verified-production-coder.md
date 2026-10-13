---
"hive-web": patch
---

Remove the unpinned Coder shell installer from the production web image. Install only the architecture-specific release archive after checking its pinned SHA-256 digest, and reject unsupported or missing target architectures.
