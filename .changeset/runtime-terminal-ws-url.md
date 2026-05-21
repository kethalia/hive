---
"hive-web": patch
---

Inject `NEXT_PUBLIC_TERMINAL_WS_URL` at runtime via `window.__HIVE_CONFIG__` so a single Docker image can be promoted across environments without rebuilding. Also document previously-undocumented env vars (login allowlist, Coder template IDs, pi provider defaults, tuning knobs, service bind config) in `.env.example`.
