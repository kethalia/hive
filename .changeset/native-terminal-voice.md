---
"hive-web": minor
"hive-terminal": minor
---

Bridge browser microphone and speaker audio to per-terminal virtual workspace
devices so native Codex `/voice` works without a separate voice bar or session
picker. Automatically request permission on capture, bound media queues, and
release audio on terminal hiding or disconnect. Enforce one microphone owner
across sessions and, with Web Locks, same-origin tabs and PWA windows. Requires the updated hive-base
workspace image and a new terminal session.
