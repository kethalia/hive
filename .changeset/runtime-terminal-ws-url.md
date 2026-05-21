---
"hive-web": patch
---

Inject `NEXT_PUBLIC_TERMINAL_WS_URL` at runtime via `window.__HIVE_CONFIG__` so a single Docker image can be promoted across environments without rebuilding. Also document previously-undocumented env vars (login allowlist, Coder template IDs, pi provider defaults, tuning knobs, service bind config) in `.env.example`.

Add `COOKIE_DOMAIN` env to the session cookie. When set (e.g. `.local.kethalia.com`), the cookie is sent to sibling subdomains, fixing the terminal-proxy `no_cookie → 401` rejection when the web UI and terminal-proxy live under different subdomains.
