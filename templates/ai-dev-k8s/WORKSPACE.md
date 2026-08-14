# Development and orchestration workspace

Use this persistent main workspace for implementation, debugging, reviews, CI, repository-local
automation, and coordination of specialist Coder workspaces. Keep one change stream per tmux session
or worktree so questions and manual corrections remain part of the live TUI conversation.

## Start here

- Repositories declared in `~/repositories.txt` are cloned under `~/projects` on first startup.
- Use `claude` or `codex` inside a repository terminal.
- Open code-server or File Browser from Coder when repository inspection is useful.
- Run `coder templates list` and `coder list` before launching a specialist workspace.
- Hand browser automation and visual inspection to the Browser Testing workspace.
- Use the Hive workspace controls to stop this environment when the change is complete.

## Lifecycle contract

- Reuse a healthy workspace when its project and isolation boundary already match.
- Create a specialist workspace for desktop tools, distinct credentials, dependencies, or resources.
- Stop idle workspaces without deleting their persistent home.
- Delete only after confirming the exact workspace name and preserving required work.

## Included tools

- Node.js 24 with pnpm, Yarn, and Bun
- Foundry, GitHub CLI, GitHub Actions `act`, and common build tools
- Claude Code, Codex, and the Coder CLI
- code-server, File Browser, tmux, and direnv

Container builds require a rootless or remote builder; the Kubernetes workspace does not mount a
host Docker socket.
