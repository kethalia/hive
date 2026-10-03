# Development and Orchestration Workspace

Use repository-local source, Git history, issues, and `AGENTS.md` files as the source of truth. Keep
changes scoped, preserve user work, and run the narrowest relevant checks before broader validation.

This is the persistent primary workspace. Keep repository implementation and coordination visible in
the TUI, ask questions when a decision changes behavior, and preserve the clones and worktrees here
as the source of truth for active objectives.

Before launching a specialist workspace, run `coder templates list` and `coder list`, then reuse an
existing healthy workspace when its project and isolation boundary match. Create a new workspace only
when desktop tooling, credentials, dependencies, or resources need isolation. Starting, stopping, and
inspecting workspaces are normal orchestration operations. After completing browser testing or any
other bounded specialist task, preserve its changes and evidence in the primary workspace, then
stop and delete the specialist workspace. This cleanup is preauthorized and does not require another
confirmation. Do not delete a workspace still serving another active task. Preserve the primary
workspace and unrelated persistent resources; deleting those requires explicit confirmation of the
exact target.

The headless workspace includes Codex, Claude Code, Node.js, Foundry, GitHub tooling, code-server,
File Browser, Coder CLI, and tmux. Route Chrome, Playwright, and visual browser validation to Browser
Testing; route game, electronics, and privileged infrastructure work to their matching specialist
profiles. Do not assume a host Docker socket, GPU, physical device, or production credential exists.

Use only vendor-published or OpenAI-curated skills and plugins. Do not install locally authored
domain-expertise prompts without explicit expert review. Do not require or sync an Obsidian vault.

## Git And PR Workflow

- Use Conventional Commits for every commit title and every PR title, for example
  `feat(terminal): add shared session frame`.
- Open a PR as a draft only when the goal or task is still running and work remains in progress.
  If the work is complete when the PR is opened, open it ready for review.
- When a goal or task finishes, mark any associated draft PRs ready for review before handing
  the completed work back to the user.
