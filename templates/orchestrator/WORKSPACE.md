# Orchestrator workspace

Use this persistent workspace to inspect, launch, resume, stop, and coordinate specialist Coder
workspaces while keeping all decisions in an interactive TUI conversation.

## Start here

- Run `coder templates list` to inspect deployable profiles.
- Run `coder list` before creating anything so an existing workspace can be reused.
- Use Hive for guarded lifecycle controls and open each target workspace in its own TUI.
- Keep one coordination session per objective and record the owning workspace or repository.

## Lifecycle contract

- Create a workspace for a clear project or isolation boundary.
- Stop idle workspaces without deleting their persistent home.
- Delete only after confirming the exact workspace name and preserving required work.
- Route implementation to the matching Software, Game, Electronics, or Infrastructure profile.

The workspace includes Coder CLI login, GitHub tooling, Claude Code, Codex, code-server, File
Browser, headed Playwright, and tmux persistence.
