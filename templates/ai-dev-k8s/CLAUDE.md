# Coder Workspace

Use repository-local source, Git history, issues, and `AGENTS.md` files as the source of truth. Keep changes scoped, preserve user work, and run the narrowest relevant checks before broader validation.

The workspace includes Codex, Claude Code, Playwright browser tooling, Unity Hub, Blender, KiCad, Node.js, Foundry, and GitHub tooling. Unity Editor installations and licenses live in the persistent home volume. Do not assume GPU acceleration is available in the Kubernetes workspace.

Use skills and plugins installed under `~/.agents` for reusable workflows. Do not require or sync an Obsidian vault.
