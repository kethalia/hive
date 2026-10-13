---
"hive-web": patch
---

Restrict managed desktop listeners to loopback behind owner-only Coder apps. Prevent KasmVNC's wildcard UDP binds, disable raw VNC/X11 TCP, and verify the bind guard before starting the backend. Bundle its source with templates so existing pinned desktop images can compile it securely; newer images supply the prebuilt guard.
