# Development and orchestration workspace

Use this persistent main workspace for implementation, debugging, reviews, CI, repository-local
automation, and coordination of specialist Coder workspaces. Keep one change stream per tmux session
or worktree so questions and manual corrections remain part of the live TUI conversation.

## Start here

- `~/repositories.txt` is seeded on first startup. Local edits are preserved on subsequent starts;
  missing listed repositories are cloned under `~/projects`. Remove entries to retire those clones.
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

## Task checkout lifecycle

Reuse a primary checkout or the existing task worktree whenever isolation permits. For a task that
needs a separate branch or clean validation checkout, use:

```bash
hive-worktree create ~/projects/<owner>/<repo> <task> --branch <branch>
```

The command groups worktrees under `~/projects/<owner>/.worktrees/<repo>/<task>` and never copies
dependencies or build outputs. Install dependencies only where required, using the repo's pinned
package manager. After committing completed work, return to the primary checkout and run
`hive-worktree complete <task-path>`. Close or move terminals still referencing that checkout.
Cleanup retains branches and skips source changes, unrecognized ignored files, and active processes.
Explicitly completed tasks deferred by an active process are retried daily at 06:55 UTC; manual retry
is `hive-worktree prune`. Existing task checkouts must first be explicitly registered using
`hive-worktree adopt <primary-repo> <task-path>` and then marked complete after task ownership review.

## Included tools

- Node.js 24 with pnpm, Yarn, and Bun
- Foundry, GitHub CLI, GitHub Actions `act`, and common build tools
- Claude Code, Codex, and the Coder CLI
- code-server, File Browser, tmux, and direnv

Container builds require a rootless or remote builder; the Kubernetes workspace does not mount a
host Docker socket.
