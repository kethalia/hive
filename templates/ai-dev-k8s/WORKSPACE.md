# Software development workspace

Use this workspace for implementation, debugging, reviews, CI, and repository-local
automation. Keep one change stream per tmux session or worktree so questions and manual corrections
remain part of the live TUI conversation.

## Start here

- Repositories declared in `~/repositories.txt` are cloned under `~/projects` on first startup.
- Use `claude` or `codex` inside a repository terminal.
- Open code-server or File Browser from Coder when repository inspection is useful.
- Hand browser automation and visual inspection to the Browser Testing workspace.
- Use the Hive workspace controls to stop this environment when the change is complete.

## Included tools

- Node.js 24 with pnpm, Yarn, and Bun
- Foundry, GitHub CLI, GitHub Actions `act`, and common build tools
- Claude Code and Codex
- code-server, File Browser, tmux, and direnv

Container builds require a rootless or remote builder; the Kubernetes workspace does not mount a
host Docker socket.
