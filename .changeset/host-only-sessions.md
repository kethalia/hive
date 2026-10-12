---
"hive-web": patch
"hive-terminal": patch
"@hive/auth": patch
---

Use protected host-only production session cookies and a new signing purpose, reject duplicate cookies, and authenticate separate terminal/audio/status transports with short-lived request-bound tickets. Existing users must sign in once after a coordinated web/terminal rollout; legacy cookie domains are deletion targets only.
