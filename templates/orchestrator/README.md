# Orchestrator Workspace on Kubernetes

This Coder template is Hive's persistent control plane for coordinating interactive specialist
workspaces. It deliberately favors workspace inspection, lifecycle management, GitHub context, and
long-lived tmux sessions over domain implementation.

## Runtime

- Profile: `orchestrator`
- Requests: 4 CPU and 8 GiB memory
- Limits: 8 CPU and 16 GiB memory
- Persistent home: 50 GiB
- Image variant: digest-pinned `cli`
- Surface: TUI and command-line tools only

The template configures Claude Code, Codex, Coder CLI login, GitHub CLI, and tmux. It does not install
or start a desktop, code-server, File Browser, Chrome, or Playwright. Its agent instructions require
exact-target confirmation before destructive workspace operations.

## Repository bootstrap

The default manifest clones only Hive and its control-plane repositories. Edit `repositories.txt`
before pushing if another orchestration repository belongs in the persistent command center.

## Publish

```bash
coder templates push orchestrator --directory templates/orchestrator --yes
coder create --template orchestrator orchestrator
```

After creation, verify `coder list`, template discovery, Hive access, terminal persistence, and the
ability to open a specialist workspace without granting extra cluster permissions.
