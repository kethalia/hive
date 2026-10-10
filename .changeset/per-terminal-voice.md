---
"hive-web": patch
"hive-terminal": patch
---

Allow simultaneous voice calls in separate terminal sessions using each session's
virtual microphone and speaker devices. Idle views no longer reserve workspace
audio, and calls claim ownership before requesting microphone permission so a view
left open on another device cannot interrupt the active call. Compose and touch
Enter controls arm voice for their target terminal, including while the audio
bridge loads. Each interaction permits only one claim attempt so earlier calls
cannot reclaim a new call started on another device.

Deploy matching web, terminal proxy, and rebuilt workspace images, then restart
workspaces to enable the new native audio ownership protocol.
