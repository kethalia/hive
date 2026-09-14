# COPY Development Workspace

This workspace owns the persistent development checkout of `lunarresearcher/copy` at
`~/projects/lunarresearcher/copy`. Use repository-local source, Git history, issues, and `AGENTS.md`
files as the source of truth. Keep implementation and questions in the live Hive TUI.

COPY uses Node.js 20 or newer. Run `npm test` in the repository for its smoke and CLI tests.
The `copy` launcher changes to the repository before running commands so `.env` and data paths work
from any terminal. Launch the terminal manually with `copy terminal`; use `copy terminal --demo`
for the built-in replay. Start the optional web wrapper with `copy web` on port 8787.

Startup preserves the checkout, `.env`, and saved data. It does not start the scanner, paper engine,
or native executor. Keep provider tokens and executor credentials in the workspace's `.env` and out
of Git, logs, and template configuration. Native executor settings start blank, as in upstream.
Configuring live transaction execution requires an explicit user request.

Use Browser Testing for Chrome, Playwright, screenshots, and visual validation. This headless
workspace has Node.js, Foundry, Claude Code, Codex, code-server, File Browser, and tmux. Workspace
lifecycle orchestration belongs to `ai-dev-k8s`.

Use only vendor-published or OpenAI-curated skills and plugins. Do not require or sync an Obsidian
vault. Preserve user work and never delete persistent resources without confirmation of the target.
