# Hive Workspace Routing

Hive is a multi-workspace Coder system. Every workspace runs in the Kubernetes cluster, and each
template is an explicit capability boundary rather than a package-installation suggestion.

## Workspace catalog

- `ai-dev-k8s` (`HIVE_WORKSPACE_PROFILE=software`) is the persistent development and orchestration
  workspace. It owns the main repository clones and worktrees, CLI implementation, Codex and Claude
  Code sessions, and Coder workspace lifecycle operations. It has no desktop or browser runtime.
- `browser-testing` (`HIVE_WORKSPACE_PROFILE=browser`) owns Chrome, Playwright, screenshots, traces,
  accessibility inspection, and headed browser debugging through Coder Desktop.
- `game-dev` (`HIVE_WORKSPACE_PROFILE=game`) owns Unity, Blender, game assets, and desktop visual
  iteration. GPU access is not guaranteed.
- `electronics` (`HIVE_WORKSPACE_PROFILE=electronics`) owns KiCad, electronics design files, and
  desktop design review. Physical USB and serial hardware are not available by default.
- `infrastructure` (`HIVE_WORKSPACE_PROFILE=infrastructure`) owns Terraform, kubectl, Helm, Argo CD,
  and infrastructure repositories. Tooling does not imply credentials or permission to mutate a
  live environment.

## Routing contract

Before acting on a capability-sensitive request, identify the current profile from
`HIVE_WORKSPACE_PROFILE`, `HIVE_IMAGE_VARIANT`, or `~/README.md`. Do not infer workspace capabilities
from the checked-out repository or the requested task.

When a required capability belongs to another profile, stop before trying to recreate that profile
locally. In particular, outside `browser-testing` do not download a replacement browser, run
Playwright browser or system-dependency installers, use `sudo` or `apt` to add browser libraries, or
rely on a Docker socket as a browser fallback. Route the browser step to `browser-testing` instead.

Only `ai-dev-k8s` orchestrates workspaces. From that profile, inspect `coder templates list` and
`coder list`, reuse a healthy matching workspace when possible, and create or start one only when
needed. Never delete a workspace or persistent volume without explicit confirmation of the exact
target. After preparing a specialist workspace, keep the interaction in Hive's TUI: tell the user
which workspace to open and provide the handoff below so questions and corrections stay interactive.

Specialist profiles do not create, start, stop, or delete other workspaces. If work falls outside the
current profile, preserve the current state and return this handoff to the user or the agent running
in `ai-dev-k8s`:

```text
Workspace handoff required
- Target template: <template>
- Reason: <missing capability>
- Repository/path: <repository, branch, commit, and path or target URL>
- Current state: <completed work, evidence, and relevant artifacts>
- Next action: <specific interactive step to continue in the target workspace>
```

Keep implementation in the workspace that owns the repository unless the task explicitly moves it.
Use the specialist workspace for its bounded validation or tool step, then carry the resulting
evidence or changes back through the repository and the live TUI conversation. Do not use retired
Hive Tasks or New Task workflows for handoffs.
