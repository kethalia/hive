---
"hive-web": patch
---

Fix native Codex voice in workspace images by exposing Debian's ALSA plugins at the
path used by Codex's bundled audio library. Requires the rebuilt workspace image
and a workspace restart.
