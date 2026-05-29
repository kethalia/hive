---
"hive-web": patch
---

Install Codex and maintained OpenGSD packages in Coder templates, wire Codex Playwright MCP/skills, and document workspace migration steps.

Operator note: existing Coder workspaces created from the previous templates must be rebuilt or manually repaired so they stop resolving abandoned pre-OpenGSD packages and pick up the maintained `@opengsd` package shims, Codex CLI, Codex MCP config, and Codex skill wiring.
