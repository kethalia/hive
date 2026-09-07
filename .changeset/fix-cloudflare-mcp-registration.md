---
"hive-web": patch
---

Register the Cloudflare API MCP server during startup across all Coder workspace templates so Codex can find it for OAuth login, while preserving existing user configuration.
