# M010: Multi-User Coder Authentication

## Vision
Replace static CODER_URL and CODER_SESSION_TOKEN env vars with per-user, per-deployment Coder authentication. Each user provides their Coder instance URL, logs in with email/password via Coder's direct login API, and receives a long-lived API key stored encrypted in Postgres. All server actions, API routes, and background workers use the authenticated user's credentials. App installable as PWA with push notifications for token expiry warnings.

## Slice Overview
| ID | Slice | Risk | Depends | Done | After this |
|----|-------|------|---------|------|------------|
| S01 | S01 | high | — | ✅ | User provides Coder URL, logs in with email/password, lands on protected dashboard. Second user on different deployment logs in simultaneously. Invalid URLs and bad credentials show distinct errors. |
| S02 | S02 | medium | — | ✅ | Submit a task — it runs end-to-end using submitting user's stored API key. No CODER_URL or CODER_SESSION_TOKEN in .env. Template push uses per-user token. |
| S03 | S03 | medium | — | ✅ | Token nearing expiry auto-rotates. Worker refuses job with expired token (clear message). Encryption key change doesn't crash app. In-app expiry banner visible. |
| S04 | S04 | low | — | ✅ | App installs as PWA. Push notification fires when token is 24h from expiry. Notification opens login page. Login page has Coder-like styling. |
