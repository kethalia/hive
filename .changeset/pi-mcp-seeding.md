---
"hive-orchestrator": patch
---

Seed pi MCP config from `~/.claude/mcp.json` into `~/.mcp.json` (and the cloned project's `.gsd/mcp.json` in Hive workers) so pi picks up playwright/obsidian MCP servers from first boot. Pi only reads project-rooted MCP config, so without seeding it has no MCP tools when launched from `~` or any project without its own config. Also align playwright `DISPLAY` to `:1` (matching the KasmVNC display) across `claude-mcp.json`, both `tools-shell.sh` chrome aliases, and the ai-dev README.
