---
"hive-orchestrator": major
---

Multi-user Coder authentication: replaced static CODER_URL/CODER_SESSION_TOKEN env vars with per-user, per-deployment credentials stored encrypted in Postgres. Added login/logout flow, session management, token auto-rotation, PWA support with push notifications for token expiry.
