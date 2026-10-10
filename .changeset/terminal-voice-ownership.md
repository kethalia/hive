---
"hive-web": patch
---

Keep terminal voice calls attached to the pane that started them. Prevent background
panes and overlapping permission requests from competing for the microphone, ignore
retired audio callbacks, and retain call ownership while native capture is paused.
The native capture lifecycle fix requires the rebuilt workspace image and a restart.
