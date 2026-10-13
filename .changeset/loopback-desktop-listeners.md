---
"hive-web": patch
---

Restrict managed desktop listeners to loopback behind owner-only Coder apps. Prevent KasmVNC's wildcard UDP binds, disable raw VNC/X11 TCP, and require the desktop image's bind guard before starting the backend. Roll out rebuilt desktop images before updating templates.
