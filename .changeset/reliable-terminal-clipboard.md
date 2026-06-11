---
"hive-web": patch
---

Make terminal clipboard paste reliable for text, images, and files by handling browser clipboard data before terminal apps can fall back to unavailable X11 clipboards, and stream pasted assets into Coder workspaces through the SSH stdio transport.
