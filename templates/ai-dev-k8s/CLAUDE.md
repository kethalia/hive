# Software Development Workspace

Use repository-local source, Git history, issues, and `AGENTS.md` files as the source of truth. Keep
changes scoped, preserve user work, and run the narrowest relevant checks before broader validation.

This is an interactive implementation workspace. Keep work visible in the TUI, ask questions when a
decision changes behavior, and leave unrelated orchestration or specialist work in its own workspace.

The workspace includes Codex, Claude Code, Playwright browser tooling, Node.js, Foundry, GitHub
tooling, code-server, File Browser, and tmux. Do not assume a host Docker socket or GPU is available.

Use only vendor-published or OpenAI-curated skills and plugins. Do not install locally authored
domain-expertise prompts without explicit expert review. Do not require or sync an Obsidian vault.
