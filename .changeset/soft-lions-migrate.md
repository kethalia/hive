---
"hive-web": patch
---

Migrate existing host-only session cookies to the configured domain scope and clear both cookie scopes on logout so the terminal WebSocket receives authentication on sibling subdomains.
